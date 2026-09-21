import 'dotenv/config';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import { DateTime } from 'luxon';
import { RocketRideClient } from 'rocketride';

// FAQ BUILDER — standalone bot (its own process, like social.ts / scheduler.ts).
// On a Pacific schedule it scans configured Discord channels for NEW messages, feeds
// them together with the CURRENT FAQ list to the faq-builder pipeline — an
// agent_rocketride "brain" (with memory_internal) that clusters related questions,
// deduplicates them against what already exists, categorizes each, and returns the
// full updated FAQ list. The bot writes that list to a JSON file for the website.
//
// The FAQ file IS the durable memory: each run the current faqs.json is fed back in,
// so the agent merges/dedupes against everything seen before — not just this batch.
// The pipeline's memory_internal node is the agent's within-run working brain.
// (An earlier design wrote the file with RocketRide's local-text-output node via a
//  second pipeline; that node only accepts the `text` lane while the agent emits
//  `answers`, so it needed an extra hop for a one-line write. The bot writes it here.)
//
//   ./node_modules/.bin/tsx faq.ts                      # run on schedule (start-bots.sh does this)
//   ./node_modules/.bin/tsx faq.ts --faq-once [--dry]   # one pass, then exit

function log(...args: unknown[]) {
	console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

const sNum = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const sStr = (v: string | undefined) => { const t = v?.trim(); return t ? t : undefined; };

const FAQ = {
	pipe: process.env.FAQ_PIPE || 'pipelines/faq-builder.pipe',
	tz: sStr(process.env.FAQ_TZ) ?? sStr(process.env.TIMEZONE) ?? 'America/Los_Angeles',
	// Hours (0-23, Pacific) to run. Default: 03:00 nightly.
	hours: (process.env.FAQ_CRON_HOURS || '3')
		.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23).sort((a, b) => a - b),
	// Comma-separated channel IDs to scan for FAQ-worthy questions.
	channelIds: (process.env.FAQ_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
	botToken: sStr(process.env.FAQ_BOT_TOKEN) ?? sStr(process.env.SCHEDULER_BOT_TOKEN) ?? sStr(process.env.DISCORD_BOT_TOKEN),
	storePath: process.env.FAQ_STORE_PATH || 'data/faqs.json',
	statePath: process.env.FAQ_STATE_PATH || 'logs/faq-seen.json',
	// Max messages pulled per channel per run (one Discord fetch page = 100 max).
	maxMessages: Math.min(100, sNum(process.env.FAQ_MAX_MESSAGES, 100)),
	// Cap each message's text so a long paste can't blow up the payload.
	maxMsgChars: sNum(process.env.FAQ_MAX_MSG_CHARS, 1500),
	// Backfill (--since) pulls up to this many messages per channel (paginated).
	backfillMax: sNum(process.env.FAQ_BACKFILL_MAX, 500),
	// Hard cap on how many messages go into a single agent call (keeps the LLM payload sane).
	payloadMax: sNum(process.env.FAQ_PAYLOAD_MAX, 1000),
};

type Faq = { category: string; question: string; answer: string; needs_answer: boolean; mentions: number };
type NewMessage = { author: string; channel: string; text: string; ts: string };

// --- response parsing (ported from support.ts) ------------------------------
function collectAnswers(response: any): string[] {
	const resultTypes = response?.result_types ?? {};
	for (const [key, laneType] of Object.entries(resultTypes)) {
		if (laneType === 'answers') { const arr = response[key]; if (Array.isArray(arr)) return arr.map(String); }
	}
	const arr = response?.answers;
	return Array.isArray(arr) ? arr.map(String) : [];
}
// agent_rocketride may wrap its reply as {"type":"final","content":"..."}.
function extractFinalText(rawAnswer: string): string {
	const m = rawAnswer.match(/\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/);
	if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
	return rawAnswer;
}
function firstAnswer(response: any): string {
	const raw = collectAnswers(response).find((a) => a.trim().length > 0) ?? '';
	return extractFinalText(raw).trim();
}

// Pull the JSON array out of the agent's answer (tolerating stray prose / code fences).
// Returns null on failure so the caller can leave the existing file untouched rather
// than clobbering it with garbage.
function parseFaqArray(text: string): Faq[] | null {
	if (!text) return null;
	let body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	const start = body.indexOf('['); const end = body.lastIndexOf(']');
	if (start === -1 || end === -1 || end < start) return null;
	let parsed: unknown;
	try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
	if (!Array.isArray(parsed)) return null;
	return parsed
		.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
		.map((e) => ({
			category: String(e.category ?? 'General').trim() || 'General',
			question: String(e.question ?? '').trim(),
			answer: String(e.answer ?? '').trim(),
			needs_answer: e.needs_answer === true || String(e.answer ?? '').trim() === '',
			mentions: Number.isFinite(Number(e.mentions)) && Number(e.mentions) > 0 ? Math.floor(Number(e.mentions)) : 1,
		}))
		.filter((e) => e.question.length > 0);
}

// --- FAQ store (plain JSON file the website reads) --------------------------
function readFaqs(): Faq[] {
	try { const parsed = parseFaqArray(readFileSync(FAQ.storePath, 'utf8')); return parsed ?? []; }
	catch (e: any) { if (e?.code === 'ENOENT') return []; log(`[faq] !! could not read ${FAQ.storePath}:`, e?.message ?? e); return []; }
}
function writeFaqs(faqs: Faq[]): void {
	mkdirSync(dirname(FAQ.storePath), { recursive: true });
	writeFileSync(FAQ.storePath, JSON.stringify(faqs, null, 2));
}

// --- watermark (per-channel last message id → only NEW messages) ------------
type FaqState = { watermark: Record<string, string> };
function loadState(): FaqState {
	try { const d = JSON.parse(readFileSync(FAQ.statePath, 'utf8')); return { watermark: d.watermark ?? {} }; }
	catch (e: any) { if (e?.code === 'ENOENT') return { watermark: {} }; throw e; }
}
function saveState(s: FaqState): void {
	try { mkdirSync(dirname(FAQ.statePath), { recursive: true }); writeFileSync(FAQ.statePath, JSON.stringify(s, null, 2)); }
	catch (e) { log('[faq] !! could not persist state:', e instanceof Error ? e.message : e); }
}

// --- RocketRide (LOCAL engine, dynamic port — same as support.ts) -----------
function detectEngineUri(): string {
	try {
		const out = execSync(
			"lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i engine | grep '127.0.0.1' | sed -E 's/.*:([0-9]+).*/\\1/' | head -1",
			{ encoding: 'utf8', shell: '/bin/bash' },
		).trim();
		if (out) return `http://localhost:${out}`;
	} catch {}
	return process.env.ROCKETRIDE_URI ?? 'http://localhost:5565';
}

let RR: RocketRideClient | undefined;
let FAQ_TOKEN: string | null = null;

async function startFresh(rr: RocketRideClient, filepath: string): Promise<string> {
	try { const prev = await rr.use({ filepath, useExisting: true }); await rr.terminate(prev.token); } catch {}
	// ttl:0 → no idle timeout; the pipeline can sit quiet between nightly runs.
	const { token } = await rr.use({ filepath, ttl: 0 });
	return token;
}

async function connectAndStart(): Promise<void> {
	try { await RR?.disconnect(); } catch {}
	const uri = detectEngineUri();
	const rr = new RocketRideClient({
		uri,
		auth: process.env.ROCKETRIDE_APIKEY,
		persist: true,
		onConnected: async () => log('[faq]   engine connection established'),
		onDisconnected: async (reason, hasError) => { if (hasError) log(`[faq]   engine connection lost: ${reason ?? 'unknown'}`); },
	});
	log(`[faq] connecting to ${uri} (local engine) ...`);
	await rr.connect();
	RR = rr;
	FAQ_TOKEN = await startFresh(rr, FAQ.pipe);
	log(`[faq] pipeline ready (${FAQ.pipe} → ${FAQ_TOKEN})`);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);
}

// --- message collection -----------------------------------------------------
// Discord snowflake for a wall-clock time (ms since epoch): turns "since <time>" into a
// synthetic message id we can pass as `after`.
const DISCORD_EPOCH = 1420070400000;
function snowflakeForTime(ms: number): string { return ((BigInt(Math.floor(ms)) - BigInt(DISCORD_EPOCH)) << 22n).toString(); }

async function fetchNewMessages(client: Client, channelId: string, opts: { afterId?: string; cap: number }): Promise<{ items: NewMessage[]; newestId?: string }> {
	const chan: any = await client.channels.fetch(channelId).catch((e) => { log(`[faq] channel ${channelId} fetch failed:`, e instanceof Error ? e.message : e); return null; });
	if (!chan || !chan.isTextBased?.() || !('messages' in chan)) { log(`[faq] channel ${channelId} not a readable text channel — skipped`); return { items: [], newestId: opts.afterId }; }
	const name = chan.name ? String(chan.name) : channelId;

	// With an `after` cursor Discord returns the OLDEST messages after it, so we page
	// FORWARD (advancing the cursor to each page's newest id) up to `cap`. Without a cursor
	// (first-ever nightly run) we take a single page of the most-recent messages.
	const raw: Message[] = [];
	let cursor = opts.afterId;
	let capped = false;
	for (;;) {
		const page = await chan.messages.fetch({ limit: 100, ...(cursor ? { after: cursor } : {}) }).catch((e: any) => {
			log(`[faq] channel ${channelId} message fetch failed (need Read Message History + Message Content intent):`, e instanceof Error ? e.message : e);
			return null;
		});
		if (!page || page.size === 0) break;
		const arr = ([...page.values()] as Message[]).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
		raw.push(...arr);
		if (raw.length >= opts.cap) { capped = true; break; }
		if (!cursor || page.size < 100) break; // no forward paging without a cursor; a short page = caught up
		cursor = arr[arr.length - 1].id;
	}
	if (raw.length === 0) return { items: [], newestId: opts.afterId };
	if (capped) log(`[faq]   #${name}: hit the ${opts.cap}-message cap — older messages this window were not read`);

	const newest = raw.reduce((a, b) => (a.createdTimestamp >= b.createdTimestamp ? a : b));
	const items = raw
		.filter((m) => !m.author.bot && !m.system && m.content.trim().length > 0)
		.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
		.map((m): NewMessage => ({
			author: m.author.username,
			channel: name,
			text: m.content.trim().slice(0, FAQ.maxMsgChars),
			ts: new Date(m.createdTimestamp).toISOString(),
		}));
	return { items, newestId: newest.id };
}

// --- one pass ---------------------------------------------------------------
let faqRunning = false;
async function buildOnce(client: Client, opts: { dry?: boolean; sinceMs?: number } = {}): Promise<void> {
	if (faqRunning) { log('[faq] previous run still in progress — skipping this tick'); return; }
	faqRunning = true;
	try {
		if (!FAQ.channelIds.length) { log('[faq] no FAQ_CHANNEL_IDS configured — nothing to scan'); return; }
		const backfill = opts.sinceMs != null;
		const cap = backfill ? FAQ.backfillMax : FAQ.maxMessages;
		if (backfill) log(`[faq] backfill: reading messages since ${new Date(opts.sinceMs!).toISOString()} (ignoring saved watermark)`);
		const state = loadState();
		const collected: NewMessage[] = [];
		const wmUpdates: Record<string, string> = {};
		for (const cid of FAQ.channelIds) {
			const afterId = backfill ? snowflakeForTime(opts.sinceMs!) : state.watermark[cid];
			const { items, newestId } = await fetchNewMessages(client, cid, { afterId, cap });
			if (newestId) wmUpdates[cid] = newestId;
			log(`[faq] channel ${cid}: ${items.length} message(s)`);
			collected.push(...items);
		}

		if (!collected.length) {
			log('[faq] nothing to process.');
			if (!backfill) { Object.assign(state.watermark, wmUpdates); saveState(state); } // advance past empty nightly scans
			return;
		}

		// Bound the agent payload: if the window is huge, send the most recent N (never silently).
		collected.sort((a, b) => a.ts.localeCompare(b.ts));
		let toSend = collected;
		if (collected.length > FAQ.payloadMax) {
			toSend = collected.slice(-FAQ.payloadMax);
			log(`[faq] !! ${collected.length} messages exceed FAQ_PAYLOAD_MAX=${FAQ.payloadMax} — sending the most recent ${FAQ.payloadMax}, dropping ${collected.length - FAQ.payloadMax} older`);
		}

		const existing = readFaqs();
		const payload = JSON.stringify({ existing_faqs: existing, new_messages: toSend });

		if (opts.dry) {
			log(`[faq] [dry-run] would send ${toSend.length} message(s) against ${existing.length} existing FAQ(s):`);
			toSend.slice(0, 20).forEach((m) => log(`   - [#${m.channel}] ${m.author}: ${m.text.slice(0, 100)}`));
			return; // don't advance the watermark on a dry run
		}

		const reqId = `faq-${DateTime.now().toFormat('yyyyLLdd-HHmmss')}`;
		log(`[faq] curating ${toSend.length} message(s) against ${existing.length} existing FAQ(s)...`);
		const result = await withTimeout(RR!.send(FAQ_TOKEN!, payload, { name: `${reqId}.txt` }, 'text/plain'), 240_000, 'faq-builder');
		const updated = parseFaqArray(firstAnswer(result));
		if (!updated) {
			log(`[faq] !! agent did not return a parseable FAQ array — ${FAQ.storePath} left unchanged, will retry next run`);
			return; // do NOT advance the watermark → same messages retried next cycle
		}

		writeFaqs(updated);
		Object.assign(state.watermark, wmUpdates); saveState(state);
		const added = updated.length - existing.length;
		log(`[faq] wrote ${updated.length} FAQ(s) to ${FAQ.storePath} (${added >= 0 ? '+' : ''}${added} vs previous ${existing.length}).`);
	} catch (e) {
		log('[faq] run error:', e instanceof Error ? e.message : e);
	} finally {
		faqRunning = false;
	}
}

// --- scheduler (in-process, Luxon; TZ-explicit — mirrors social.ts) ---------
function faqNextFire(now: DateTime): DateTime {
	const z = now.setZone(FAQ.tz);
	for (const h of FAQ.hours) { const c = z.set({ hour: h, minute: 0, second: 0, millisecond: 0 }); if (c > z) return c; }
	return z.plus({ days: 1 }).set({ hour: FAQ.hours[0], minute: 0, second: 0, millisecond: 0 });
}
function scheduleFaq(client: Client): void {
	const now = DateTime.now(); const fire = faqNextFire(now); const ms = fire.toMillis() - now.toMillis();
	log(`[faq] next run: ${fire.toFormat('ccc yyyy-LL-dd HH:mm')} ${FAQ.tz} (in ${(ms / 60000).toFixed(0)} min)`);
	setTimeout(() => { void buildOnce(client); scheduleFaq(client); }, ms);
}

// --- discord login helper ---------------------------------------------------
function loginAndReady(): Promise<Client> {
	const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
	return new Promise<Client>((resolve, reject) => {
		discord.once(Events.ClientReady, (c) => { log(`[faq] bot online as ${c.user.tag} — scanning ${FAQ.channelIds.length} channel(s)`); resolve(discord); });
		discord.login(FAQ.botToken).catch(reject);
	});
}

// --- main -------------------------------------------------------------------
async function main() {
	if (!FAQ.channelIds.length) throw new Error('Set FAQ_CHANNEL_IDS in .env (comma-separated channel IDs to scan).');
	if (!FAQ.botToken) throw new Error('Set FAQ_BOT_TOKEN in .env (a bot in the server with Read Message History + Message Content intent).');
	if (!FAQ.hours.length) throw new Error('Set FAQ_CRON_HOURS in .env (e.g. "3" for 03:00 Pacific).');

	await connectAndStart();
	const discord = await loginAndReady();

	log(`[faq] scheduler up — hours [${FAQ.hours.join(', ')}] ${FAQ.tz}, store ${FAQ.storePath}`);
	void buildOnce(discord); // catch-up on startup
	scheduleFaq(discord);

	const shutdown = async () => {
		log('[faq] shutting down...');
		if (FAQ_TOKEN) { try { await RR?.terminate(FAQ_TOKEN); } catch {} }
		await RR?.disconnect().catch(() => {});
		await discord.destroy();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

// --- entry (its own process) ------------------------------------------------
// Resolve a --since value (ISO date "2026-08-03", or a weekday name "monday") to a
// start-of-day epoch in FAQ.tz. A weekday resolves to the MOST RECENT such day (incl. today).
function resolveSince(arg: string): number | undefined {
	const wd: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
	const key = arg.trim().toLowerCase();
	if (key in wd) {
		let d = DateTime.now().setZone(FAQ.tz).startOf('day');
		for (let i = 0; i < 7; i++) { if (d.weekday === wd[key]) return d.toMillis(); d = d.minus({ days: 1 }); }
		return undefined;
	}
	const dt = DateTime.fromISO(key, { zone: FAQ.tz }).startOf('day');
	return dt.isValid ? dt.toMillis() : undefined;
}

const sinceArg = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : undefined;

if (process.argv.includes('--faq-once') || sinceArg) {
	const dry = process.argv.includes('--dry');
	const sinceMs = sinceArg ? resolveSince(sinceArg) : undefined;
	if (sinceArg && sinceMs == null) { console.error(`Bad --since value: "${sinceArg}" (use YYYY-MM-DD or a weekday like monday)`); process.exit(1); }
	(async () => {
		await connectAndStart();
		const discord = await loginAndReady();
		await buildOnce(discord, { dry, sinceMs });
		if (FAQ_TOKEN) { try { await RR?.terminate(FAQ_TOKEN); } catch {} }
		await RR?.disconnect().catch(() => {});
		await discord.destroy();
		process.exit(0);
	})().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
} else {
	main().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
}
