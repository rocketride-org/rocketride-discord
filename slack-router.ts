// Slack escalation router for the support bot ("Rocket Ralph").
//
// When Ralph ESCALATES a thread (its reply pings the @RocketRide team role — see
// support.ts), we also page the right owner(s) in Slack. Design (see the chat that
// produced this):
//   • A separate nano-model RocketRide pipeline (pipelines/slack-classifier.pipe, run on the
//     local engine) does ONE small thing: summarize the user's problem + pick 1–2 AREA tags.
//     It never chooses people; the area list travels in the payload so routing stays data-driven.
//   • The PROGRAM maps area → member IDs deterministically from data/slack-experts.json
//     (skill fan-out for "tag everyone with Python", explicit members otherwise).
//   • ALLOWLIST: we post a Discord-ticket-style message to an Incoming Webhook ONLY when the
//     escalation resolves to a routed label's owner(s). Uncategorized escalations — Triage,
//     no match, or a classifier failure — are SKIPPED (not posted).
// Everything here is best-effort: a failure never blocks or throws into the bot — the
// Discord team ping already happened, so Slack routing is a bonus, not a dependency.
//
// The classifier pipeline's nano LLM node uses ${ROCKETRIDE_OPENAI_KEY}. Disabled (no-op)
// unless SUPPORT_SLACK_WEBHOOK_URL is set AND the directory file loads; the classifier pipeline
// is connected+started lazily on the first escalation (needs the local engine running).

import 'dotenv/config'; // no-op when imported by support.ts (already loaded); needed for standalone --ask/--areas
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RocketRideClient } from 'rocketride';
import type { Message, ThreadChannel } from 'discord.js';

const WEBHOOK_URL = process.env.SUPPORT_SLACK_WEBHOOK_URL || '';
const DIRECTORY_FILE = process.env.SUPPORT_SLACK_DIRECTORY || 'data/slack-experts.json';
const CLASSIFIER_PIPE = process.env.SUPPORT_SLACK_CLASSIFIER_PIPE || 'pipelines/slack-classifier.pipe';
const OPENAI_KEY = process.env.ROCKETRIDE_OPENAI_KEY || process.env.OPENAI_API_KEY || '';

type Expert = { name: string; slack: string; role?: string; skills: string[] };
type AreaRule = { members?: string[]; skill?: string; hint?: string };
type Directory = {
	experts: Expert[];
	areas: Record<string, AreaRule>;
};

type Logger = (...args: unknown[]) => void;

let dir: Directory | null = null;
let enabled = false;
// Engine connection + classifier instance — created lazily on first use (memoized).
let rr: RocketRideClient | undefined;
let connectReady: Promise<void> | null = null;
let classifierToken: string | null = null;
let classifierReady: Promise<void> | null = null;
let classifyLock: Promise<unknown> = Promise.resolve();
let classifySeq = 0;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);
}

// Parse + validate the directory file. Throws on a missing/empty file so callers can
// decide what to do (init disables the router; the dry-run CLI reports and exits).
function loadDir(file: string): Directory {
	const loaded = JSON.parse(readFileSync(file, 'utf8')) as Directory;
	if (!Array.isArray(loaded.experts) || !loaded.experts.length) throw new Error('no experts[]');
	if (!loaded.areas || !Object.keys(loaded.areas).length) throw new Error('no areas{}');
	return loaded;
}

// Load the directory once at startup. If anything is missing, the router simply stays
// disabled — the bot keeps working, it just won't page Slack.
export function initSlackRouter(log: Logger): void {
	if (!WEBHOOK_URL) { log('slack router: SUPPORT_SLACK_WEBHOOK_URL unset → disabled'); return; }
	if (!OPENAI_KEY) { log('slack router: no OpenAI key (ROCKETRIDE_OPENAI_KEY) → disabled'); return; }
	try {
		dir = loadDir(DIRECTORY_FILE);
		enabled = true;
		log(`slack router: ready (${dir.experts.length} experts, ${Object.keys(dir.areas).length} areas, via ${CLASSIFIER_PIPE})`);
	} catch (e) {
		log(`slack router: could not load ${DIRECTORY_FILE} → disabled (${e instanceof Error ? e.message : e})`);
	}
}

// The local engine listens on a DYNAMIC port (changes each restart). The client-facing engine
// is the `eaas.py` process; per-pipeline TASK processes also listen (on debug/data ports), so a
// plain "grep engine | head -1" can grab a task port and connect to a dead end. This bot
// connects LATE (on first escalation, when task processes already exist), so match eaas first;
// fall back to any engine listener (fine at cold start), then ROCKETRIDE_URI / the default.
function detectEngineUri(): string {
	const sh = (cmd: string): string => {
		try { return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; }
	};
	const eaasPid = sh("ps ax -o pid=,command= | grep -i engine | grep -i eaas | grep -v grep | awk '{print $1}' | head -1");
	if (eaasPid) {
		const port = sh(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${eaasPid} 2>/dev/null | grep 127.0.0.1 | sed -E 's/.*:([0-9]+).*/\\1/' | head -1`);
		if (port) return `http://localhost:${port}`;
	}
	const any = sh("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i engine | grep '127.0.0.1' | sed -E 's/.*:([0-9]+).*/\\1/' | head -1");
	if (any) return `http://localhost:${any}`;
	return process.env.ROCKETRIDE_URI ?? 'http://localhost:5565';
}

// Lazily connect to the local engine once per process (memoized). Only the escalation /
// `--ask` paths need it; `--areas` never connects.
async function ensureConnected(log: Logger): Promise<void> {
	if (rr) return;
	if (!connectReady) {
		connectReady = (async () => {
			const uri = detectEngineUri();
			const client = new RocketRideClient({ uri, auth: process.env.ROCKETRIDE_APIKEY, persist: true });
			await client.connect();
			rr = client;
			log(`slack router: connected to local engine (${uri}) for ${CLASSIFIER_PIPE}`);
		})().catch((e) => { connectReady = null; throw e; }); // reset so a later escalation retries
	}
	await connectReady;
}

// Pull {summary, areas} out of the pipeline's answers (tolerating stray ```json fences).
function parseTriage(response: any): { summary: string; areas: string[] } {
	const rt = response?.result_types ?? {};
	let raw = '';
	for (const [k, t] of Object.entries(rt)) {
		if (t === 'answers' && Array.isArray((response as any)[k])) { raw = (response as any)[k].map(String).find((a: string) => a.trim()) ?? ''; break; }
	}
	if (!raw && Array.isArray(response?.answers)) raw = response.answers.map(String).find((a: string) => a.trim()) ?? '';
	raw = raw.trim();
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) raw = fence[1].trim();
	let parsed: any = {};
	try { parsed = JSON.parse(raw); } catch { /* unparseable → no areas → caller skips */ }
	const areas = Array.isArray(parsed.areas) ? parsed.areas.filter((a: unknown) => typeof a === 'string').slice(0, 2) : [];
	return { summary: String(parsed.summary ?? '').trim(), areas };
}

// startFresh the classifier instance: clear any leftover instance from a prior run (else use()
// errors "Pipeline is already running"), then start one with no idle timeout (ttl:0).
async function startFreshClassifier(): Promise<string> {
	try { const prev = await rr!.use({ filepath: CLASSIFIER_PIPE, useExisting: true }); await rr!.terminate(prev.token); } catch {}
	const { token } = await withTimeout(rr!.use({ filepath: CLASSIFIER_PIPE, ttl: 0 }), 25_000, 'classifier start');
	return token;
}

// Connect (once) and start the classifier instance (once), memoized.
async function ensureClassifier(log: Logger): Promise<void> {
	await withTimeout(ensureConnected(log), 25_000, 'engine connect');
	if (classifierToken) return;
	if (!classifierReady) {
		classifierReady = (async () => {
			classifierToken = await startFreshClassifier();
			log(`slack router: classifier pipeline ready (${CLASSIFIER_PIPE} → ${classifierToken})`);
		})().catch((e) => { classifierReady = null; throw e; }); // reset so a later escalation retries
	}
	await classifierReady;
}

// LLM step, now via a SEPARATE nano-model RocketRide pipeline on the local engine (cheaper than
// a direct API call, and observable like the bot's other pipelines). The LLM still only
// summarizes + picks AREA tags (never people); the area list travels IN the payload so routing
// stays data-driven (edit the directory JSON, no pipe change). Sends are SERIALIZED and the
// instance is RESTARTED after each — the prompt node accumulates context across requests
// otherwise (the same engine quirk support.ts works around for the summariser), which would
// leak an earlier question into a later classification.
async function classify(question: string, ralphReply: string, log: Logger): Promise<{ summary: string; areas: string[] }> {
	await ensureClassifier(log);
	const areaDefs = Object.entries(dir!.areas).map(([name, v]) => ({ name, hint: v.hint ?? '' }));
	const payload = JSON.stringify({
		question: question || '(no text — see attachments)',
		ralph_reply: ralphReply.slice(0, 1500),
		areas: areaDefs,
	});
	const name = `slack-classify-${Date.now()}-${++classifySeq}.json`; // unique per request
	const result = classifyLock.then(() =>
		withTimeout(rr!.send(classifierToken!, payload, { name }, 'text/plain'), 30_000, 'classifier'));
	classifyLock = result.catch(() => {}).then(async () => {
		try { classifierToken = await startFreshClassifier(); }
		catch (e) { classifierToken = null; classifierReady = null; log(`  slack router: classifier restart failed: ${e instanceof Error ? e.message : e}`); }
	});
	return parseTriage(await result);
}

// PROGRAM step: area tags → member IDs. `skill` rules fan out to every expert with that
// skill (this is how "tag everyone with Python" works); `members` rules are explicit.
// Nothing resolves to an owner (Triage, or no match) → empty ids → the caller SKIPS the
// Slack post entirely (allowlist: only routed labels reach Slack).
function resolveMembers(areas: string[]): { ids: string[]; label: string } {
	const ids = new Set<string>();
	const label: string[] = [];
	for (const a of areas) {
		const rule = dir!.areas[a];
		if (!rule) continue;
		label.push(a);
		if (rule.skill) for (const e of dir!.experts) if (e.skills.includes(rule.skill)) ids.add(e.slack);
		for (const m of rule.members ?? []) ids.add(m);
	}
	return { ids: [...ids], label: label.join(' / ') || 'Unclassified' };
}

// The exact Slack payload text. Shared by the live poster and the dry-run CLI so a preview
// always matches what would really be sent.
function buildSlackText(summary: string, label: string, ids: string[], link: string): string {
	const mentions = ids.map((i) => `<@${i}>`).join(' ');
	const areaLine = `Area: ${label}  ·  <${link}|open in Discord>`;
	return `*New Discord support message*\nSummary: ${summary}\n${areaLine}\n${mentions} — please take a look and help this user out.`;
}

// Public entry point: called once per thread when Ralph first escalates it.
export async function notifyEscalation(thread: ThreadChannel, msg: Message, ralphReply: string, log: Logger): Promise<void> {
	if (!enabled) return;
	try {
		const question = msg.content.trim();
		const attNames = [...msg.attachments.values()].map((a) => a.name).filter(Boolean);
		const attNote = attNames.length ? ` [attachments: ${attNames.join(', ')}]` : '';

		let summary: string;
		let areas: string[];
		try {
			const c = await withTimeout(classify(question + attNote, ralphReply, log), 45_000, 'classifier');
			summary = c.summary || (question ? question.slice(0, 280) : 'User escalated with no text (see attachments).');
			areas = c.areas;
		} catch (e) {
			// Can't classify → we can't confirm it fits a routed label, so skip (allowlist).
			// The Discord team ping already happened; Slack is a best-effort bonus.
			log(`  slack router: classify failed → skipping Slack post (${e instanceof Error ? e.message : e})`);
			return;
		}

		const { ids, label } = resolveMembers(areas);
		// Allowlist: only escalations that resolve to a routed owner reach Slack. Triage,
		// no match, or an off-topic area (events/bizdev/etc.) resolve to no owner → skip.
		if (!ids.length) {
			log(`  slack router: no routed owner (areas: ${areas.join(', ') || 'none'}) → skipping Slack post`);
			return;
		}
		const link = `https://discord.com/channels/${thread.guildId}/${thread.id}`;
		const text = buildSlackText(summary, label, ids, link);

		const res = await fetch(WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
		});
		if (res.status !== 200) log(`  slack router: webhook ${res.status} ${(await res.text()).slice(0, 120)}`);
		else log(`  slack router: paged ${ids.length} member(s) → ${label}`);
	} catch (e) {
		log(`  slack router: error (not fatal): ${e instanceof Error ? e.message : e}`);
	}
}

// Manual escalation: a human explicitly pushes a Discord message to Slack (the "Escalate to
// Slack" message command in support.ts). Unlike the automatic path this ALWAYS posts — the human
// chose to — tagged if it resolves to owners, otherwise untagged with a self-assign note.
export async function escalateManually(
	input: { text: string; authorName: string; messageUrl: string; escalatorName: string; attachmentsNote?: string },
	log: Logger,
): Promise<{ ok: boolean; reason?: string; label?: string; owners?: number }> {
	if (!enabled) return { ok: false, reason: 'Slack routing is off (SUPPORT_SLACK_WEBHOOK_URL not set / directory not loaded).' };
	try {
		let summary = (input.text || '(no text)').slice(0, 280);
		let areas: string[] = [];
		try {
			const c = await withTimeout(classify(input.text + (input.attachmentsNote ?? ''), '(manually escalated from Discord)', log), 45_000, 'classifier');
			if (c.summary) summary = c.summary;
			areas = c.areas;
		} catch (e) {
			log(`  slack router: manual-escalate classify failed → posting untagged (${e instanceof Error ? e.message : e})`);
		}
		const { ids, label } = resolveMembers(areas);
		const mentions = ids.map((i) => `<@${i}>`).join(' ');
		const areaLine = `Area: ${ids.length ? label : 'Unclassified'}  ·  <${input.messageUrl}|open in Discord>`;
		const cta = mentions ? `${mentions} — please take a look and help this user out.` : '_No area matched — please self-assign._';
		const text = `*Escalated from Discord* — by ${input.escalatorName}\nFrom: ${input.authorName}\nSummary: ${summary}\n${areaLine}\n${cta}`;
		const res = await fetch(WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
		});
		if (res.status !== 200) return { ok: false, reason: `Slack HTTP ${res.status}` };
		log(`  slack router: MANUAL escalate by ${input.escalatorName} → ${ids.length ? label : 'untagged'} (${ids.length} owner(s))`);
		return { ok: true, label: ids.length ? label : 'Unclassified', owners: ids.length };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
}

// --- dry-run harness (CLI) --------------------------------------------------
// Preview routing WITHOUT posting to Slack (SUPPORT_SLACK_WEBHOOK_URL is never used here).
// Reuses the real classify / resolveMembers / buildSlackText, so the preview matches
// exactly what production would send. Two modes:
//
//   tsx slack-router.ts --ask "why does my qdrant store keep failing?" [--reply "ralph's reply"]
//       → runs the real classifier pipeline on the local engine (needs the engine running +
//         ROCKETRIDE_OPENAI_KEY), then shows the areas it picked, owners, POST-vs-SKIP + text.
//
//   tsx slack-router.ts --areas Engine,TS
//       → skips the LLM; shows exactly who a given area set would tag and whether it posts.
//         Use this to sanity-check the directory (e.g. --areas Event and --areas Triage → SKIP).
//
// Add --send to any of the above to REALLY post to the webhook (a clearly-labeled test message
// with mentions suppressed). Add --ping too to include the real <@ID> tags. Without --send,
// nothing is ever sent.
async function dryRunCLI(): Promise<void> {
	const argv = process.argv;
	const val = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

	try { dir = loadDir(DIRECTORY_FILE); }
	catch (e) { console.error(`Could not load ${DIRECTORY_FILE}: ${e instanceof Error ? e.message : e}`); process.exit(1); }

	const PLACEHOLDER_LINK = 'https://discord.com/channels/GUILD_ID/THREAD_ID';
	const nameOf = (slack: string) => dir!.experts.find((e) => e.slack === slack)?.name ?? slack;

	let summary: string;
	let areas: string[];

	const areasArg = val('--areas');
	if (areasArg != null) {
		areas = areasArg.split(',').map((s) => s.trim()).filter(Boolean);
		summary = '(--areas mode — classifier skipped)';
		const unknown = areas.filter((a) => !dir!.areas[a]);
		if (unknown.length) console.log(`⚠︎  not in directory, ignored: ${unknown.join(', ')}\n`);
	} else {
		const question = val('--ask');
		if (!question) {
			console.error('Usage:\n  tsx slack-router.ts --ask "question" [--reply "ralph reply"]\n  tsx slack-router.ts --areas Engine,TS');
			process.exit(1); return;
		}
		if (!OPENAI_KEY) {
			console.error('--ask needs ROCKETRIDE_OPENAI_KEY (the classifier pipeline uses it) and the local engine running.\nTo test routing without the engine/LLM, use --areas instead, e.g. --areas Engine,TS');
			process.exit(1); return;
		}
		console.log(`Question: ${question}\nClassifying via the local engine (${CLASSIFIER_PIPE}, nano) …\n`);
		try {
			const c = await classify(question, val('--reply') ?? '(no reply text provided)', console.log);
			summary = c.summary; areas = c.areas;
		} catch (e) {
			console.log(`Classifier FAILED → would SKIP (production posts nothing).\n  reason: ${e instanceof Error ? e.message : e}\n  (is the local engine running? start it in the RocketRide extension.)`);
			process.exit(0); return;
		}
	}

	const send = argv.includes('--send');
	const ping = argv.includes('--ping');

	const { ids, label } = resolveMembers(areas);
	console.log(`Summary:  ${summary}`);
	console.log(`Areas:    ${areas.join(', ') || '(none)'}`);
	console.log(`Resolved: ${label}`);
	console.log(`Owners:   ${ids.length ? ids.map((i) => `${nameOf(i)} <${i}>`).join(', ') : '(none)'}`);

	if (!ids.length) {
		console.log(`\n⏭  WOULD SKIP — no routed owner (Triage / off-topic / no match). Nothing posts to Slack.`);
		return;
	}

	const prodText = buildSlackText(summary, label, ids, PLACEHOLDER_LINK);
	if (!send) {
		console.log(`\n✅ WOULD POST to Slack (dry run — add --send to actually post):\n\n${prodText}`);
		return;
	}

	// --send: really POST to the webhook. By default we send a clearly-labeled TEST message
	// with mentions SUPPRESSED so a plumbing check doesn't ping real people; add --ping to
	// include the real <@ID> tags (do that in a test channel, or when you mean it).
	if (!WEBHOOK_URL) { console.error('\n--send needs SUPPORT_SLACK_WEBHOOK_URL set in .env'); process.exit(1); return; }
	const banner = ':test_tube: *Slack routing test — please ignore* (RocketRide support bot plumbing check)';
	const body = ping
		? prodText
		: `Summary: ${summary}\nArea: ${label}\nWould ping: ${ids.map(nameOf).join(', ')}  _(mentions suppressed for this test — add --ping to really tag them)_`;
	const text = `${banner}\n\n${body}`;
	console.log(`\n📮 Posting ${ping ? 'WITH real pings' : 'a test message (no pings)'} to Slack …`);
	const res = await fetch(WEBHOOK_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
	});
	const respBody = await res.text();
	if (res.status === 200) console.log(`✅ Slack accepted the post (HTTP 200, "${respBody}"). Check the channel.`);
	else console.log(`❌ Slack returned HTTP ${res.status}: ${respBody.slice(0, 300)}`);
}

// Only runs when invoked directly with a flag — importing this module (support.ts) is unaffected.
if (process.argv.includes('--ask') || process.argv.includes('--areas') || process.argv.includes('--send')) {
	const cleanup = async () => {
		try { await classifyLock; } catch {} // let any pending post-send restart finish first
		try { if (rr && classifierToken) await rr.terminate(classifierToken); } catch {}
		try { await rr?.disconnect(); } catch {}
	};
	dryRunCLI()
		.then(async () => { await cleanup(); process.exit(0); })
		.catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
}
