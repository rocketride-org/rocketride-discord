import 'dotenv/config';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client, GatewayIntentBits, Events, ThreadChannel, type Message } from 'discord.js';
import { RocketRideClient, Question } from 'rocketride';

// RocketRide support bot ("Rocket Ralph").
// - Answers in a THREAD created off the user's message in the support channel.
// - Carries the whole thread as context on each reply.
// - When it escalates (pings @RocketRide team) it goes quiet in that thread so the
//   human team can answer; it resumes only when a user @-mentions it again.
// - When a message is aimed at another person (@-mentions someone else, or replies to a
//   non-bot message) it reacts and — inside a thread — also goes quiet until @-mentioned.

const PIPELINE = process.env.PIPE || 'pipelines/rocket-ralph 1.pipe';
// The pipe has multiple source nodes (webhook/chat/dropper); the engine needs one
// named explicitly. The bot talks via RR.chat(), so use the chat node.
const PIPELINE_SOURCE = process.env.PIPE_SOURCE || 'chat_1';
const CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID;
const ESCALATION_ROLE_ID = process.env.SUPPORT_ESCALATION_ROLE_ID || '1331418231113650196'; // @RocketRide team
const ROLE_MENTION = `<@&${ESCALATION_ROLE_ID}>`;

// When a message is aimed at another person (@-mentions someone else, or replies to a
// message that isn't the bot's), Ralph reacts with this emoji and — inside a thread —
// goes quiet until it's @-mentioned again.
const ACK_EMOJI = process.env.SUPPORT_ACK_EMOJI || '👀';

// Threads where the bot is paused — either it escalated to the team, or a message was
// aimed at someone else (@-mention of another person, or a reply). While a thread is here,
// the bot stays quiet and ignores messages until it is @-mentioned.
// Persisted to disk so a restart doesn't silently resume an escalated thread, and — as a
// belt-and-suspenders fallback — the escalation pause is also reconstructable from thread
// history (see isPausedFromHistory), so it survives even if the state file is lost.
const PAUSED_FILE = process.env.SUPPORT_PAUSED_FILE || 'logs/paused-threads.json';
const pausedThreads = new Set<string>();
const resolvedThreads = new Set<string>(); // threads whose pause state we've reconciled with history this process

function loadPaused(): void {
	try {
		const arr = JSON.parse(readFileSync(PAUSED_FILE, 'utf8'));
		if (Array.isArray(arr)) for (const id of arr) pausedThreads.add(String(id));
		log(`loaded ${pausedThreads.size} paused thread(s) from ${PAUSED_FILE}`);
	} catch { /* no file yet → start empty */ }
}
function savePaused(): void {
	try { writeFileSync(PAUSED_FILE, JSON.stringify([...pausedThreads])); }
	catch (e) { log(`  !! could not persist paused threads: ${e instanceof Error ? e.message : e}`); }
}
function pause(threadId: string): void { if (!pausedThreads.has(threadId)) { pausedThreads.add(threadId); savePaused(); } }
function unpause(threadId: string): void { if (pausedThreads.delete(threadId)) savePaused(); }

function log(...args: unknown[]) {
	console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

// --- response parsing -------------------------------------------------------
function collectAnswers(response: any): string[] {
	const resultTypes = response?.result_types ?? {};
	for (const [key, laneType] of Object.entries(resultTypes)) {
		if (laneType === 'answers') {
			const arr = response[key];
			if (Array.isArray(arr)) return arr.map(String);
		}
	}
	const arr = response?.answers;
	return Array.isArray(arr) ? arr.map(String) : [];
}

function extractFinalText(rawAnswer: string): string {
	const m = rawAnswer.match(/\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/);
	if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
	return rawAnswer;
}

function firstAnswer(response: any): string {
	const answers = collectAnswers(response);
	const raw = answers.find((a) => a.trim().length > 0) ?? '';
	return extractFinalText(raw).trim();
}

// Turn the literal "@RocketRide team" the agent wrote into a real role mention so the team is pinged.
function injectRoleMention(text: string): string {
	return text.replace(/@RocketRide\s+team/gi, ROLE_MENTION);
}

// Engine/model failures can surface as the "answer" text (an OpenAI/Anthropic API error,
// a Python traceback, an engine stack frame). Detect those so we never relay them to Discord.
function looksLikeError(text: string): boolean {
	return /an error occurred with the \w+ api\b/i.test(text)
		|| /\b(chat|agent)\.py:\d+/i.test(text)
		|| /_run failed\b/i.test(text)
		|| /Traceback \(most recent call last\)/i.test(text);
}

// --- Discord message chunking (<=2000 chars, keep fences balanced) ----------
const DISCORD_LIMIT = 2000;
const CHUNK_SIZE = 1900;
function softBreakAt(text: string, max: number): number {
	if (text.length <= max) return text.length;
	const w = text.slice(0, max);
	const para = w.lastIndexOf('\n\n'); if (para > max * 0.5) return para + 2;
	const line = w.lastIndexOf('\n'); if (line > max * 0.6) return line + 1;
	const sent = Math.max(w.lastIndexOf('. '), w.lastIndexOf('! '), w.lastIndexOf('? ')); if (sent > max * 0.6) return sent + 2;
	const space = w.lastIndexOf(' '); if (space > max * 0.7) return space + 1;
	return max;
}
function balanceFences(chunks: string[]): string[] {
	const out: string[] = []; let openLang: string | null = null; const FENCE_RX = /^```([^\n]*)$/gm;
	for (const raw of chunks) {
		let piece = openLang !== null ? '```' + openLang + '\n' + raw : raw;
		let m: RegExpExecArray | null; FENCE_RX.lastIndex = 0; let lastLang: string | null = openLang;
		while ((m = FENCE_RX.exec(piece))) lastLang = lastLang === null ? (m[1] ?? '') : null;
		if (lastLang !== null) { piece = piece.replace(/\n*$/, '') + '\n```'; openLang = lastLang; } else { openLang = null; }
		out.push(piece);
	}
	return out;
}
function chunk(text: string, size = CHUNK_SIZE): string[] {
	const trimmed = text.trim();
	if (!trimmed) return ['(empty response)'];
	if (trimmed.length <= size) return [trimmed];
	const parts: string[] = []; let remaining = trimmed;
	while (remaining.length > size) { const cut = softBreakAt(remaining, size); parts.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut).trimStart(); }
	if (remaining) parts.push(remaining);
	const balanced = balanceFences(parts); const n = balanced.length;
	const labeled = n === 1 ? balanced : balanced.map((p, i) => `${p}\n\n*(${i + 1}/${n})*`);
	const safe: string[] = [];
	for (const p of labeled) { if (p.length <= DISCORD_LIMIT) safe.push(p); else for (let i = 0; i < p.length; i += DISCORD_LIMIT) safe.push(p.slice(i, i + DISCORD_LIMIT)); }
	return safe;
}

// --- pipeline ---------------------------------------------------------------
let RR: RocketRideClient | undefined; let TOKEN: string;

// The RocketRide engine (launched by the VSCode extension) listens on a DYNAMIC
// port that changes on every engine restart, so the port baked in at launch goes
// stale. Detect the engine's current listen port the same way start-bots.sh does
// so we can recover even after the engine moved.
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

async function startFresh(rr: RocketRideClient): Promise<string> {
	try { const prev = await rr.use({ filepath: PIPELINE, source: PIPELINE_SOURCE, useExisting: true }); await rr.terminate(prev.token); } catch {}
	// ttl: 0 -> no idle timeout, so the pipeline never expires while the bot is up.
	const { token } = await rr.use({ filepath: PIPELINE, source: PIPELINE_SOURCE, ttl: 0 });
	return token;
}

// (Re)build the engine connection from scratch against the engine's CURRENT port
// and start a fresh pipeline. Used at startup and to recover after the connection
// drops or the engine restarts on a new port.
async function connectAndStart(): Promise<void> {
	try { await RR?.disconnect(); } catch {} // stop any background reconnect on the old (possibly stale) client
	const uri = detectEngineUri();
	const rr = new RocketRideClient({
		uri,
		auth: process.env.ROCKETRIDE_APIKEY,
		persist: true, // auto-reconnect (exponential backoff) across transient drops on the same port
		onConnected: async () => log('  engine connection established'),
		onDisconnected: async (reason, hasError) => { if (hasError) log(`  engine connection lost: ${reason ?? 'unknown'}`); },
	});
	log(`connecting to ${uri} ...`);
	await rr.connect();
	log('connected; starting support pipeline (fresh)...');
	TOKEN = await startFresh(rr);
	RR = rr;
	log(`pipeline ready (token: ${TOKEN})`);
}

// Single-flight recovery: many in-flight messages can fail at once when the engine
// drops; collapse their recovery attempts into one rebuild.
let recovering: Promise<void> | null = null;
function recover(): Promise<void> {
	if (!recovering) {
		recovering = connectAndStart()
			.catch((e) => { log(`  !! recovery failed: ${e instanceof Error ? e.message : e}`); throw e; })
			.finally(() => { recovering = null; });
	}
	return recovering;
}

function isConnectionError(err: unknown): boolean {
	const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return /not connected|connection closed|disconnect|socket|econnrefused|websocket|invalid token|unknown token/.test(m);
}

// Build the full thread transcript (oldest first) for context, excluding the current message.
async function threadTranscript(thread: ThreadChannel, exceptId: string, botId: string): Promise<string> {
	const fetched = await thread.messages.fetch({ limit: 50 }).catch(() => null);
	if (!fetched) return '';
	const ordered = [...fetched.values()].filter((m) => m.id !== exceptId && !m.system && m.content.trim()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
	const lines = ordered.map((m) => `${m.author.id === botId ? 'Rocket Ralph' : m.author.username}: ${m.content.trim()}`);
	let out = lines.join('\n');
	if (out.length > 6000) out = '…\n' + out.slice(-6000); // cap context
	return out;
}

async function chatOnce(prompt: string): Promise<string> {
	const q = new Question();
	q.addQuestion(prompt);
	const response = await RR!.chat({ token: TOKEN, question: q });
	return injectRoleMention(firstAnswer(response));
}

async function answerFor(text: string, transcript: string): Promise<string> {
	const prompt = transcript ? `User's latest message: ${text}\n\nEarlier in this thread (oldest first, for context):\n${transcript}` : text;
	try {
		return await chatOnce(prompt);
	} catch (err) {
		if (!isConnectionError(err)) throw err;
		log(`  chat failed on a dead connection (${err instanceof Error ? err.message : err}) — recovering and retrying once...`);
		await recover();
		return await chatOnce(prompt);
	}
}

// A message is "aimed at someone else" (so Ralph just acknowledges) when it @-mentions a
// user or role other than the bot, or replies to a message that isn't the bot's. Messages
// that mention the bot or reply to the bot are still answered normally.
async function isAimedAtSomeoneElse(msg: Message, botId: string): Promise<boolean> {
	if (msg.mentions.users.has(botId)) return false; // aimed at the bot → answer
	const mentionsOthers = msg.mentions.users.some((u) => u.id !== botId) || msg.mentions.roles.size > 0;
	const isReply = msg.reference?.messageId != null;
	if (!mentionsOthers && !isReply) return false; // plain message → answer
	if (isReply) {
		const ref = await msg.fetchReference().catch(() => null);
		if (ref && ref.author?.id === botId) return false; // replying to the bot → answer
	}
	return true;
}

async function acknowledge(msg: Message): Promise<void> {
	await msg.react(ACK_EMOJI).catch((err) => log(`  !! could not react (grant "Add Reactions"): ${err instanceof Error ? err.message : err}`));
}

// Reconstruct the escalation pause from thread history (oldest → newest): a bot message
// carrying the team role-mention pauses; a later user @-mention of the bot resumes. Used the
// first time we see a thread this process, so an escalation survives restarts even if the
// state file is missing.
async function isPausedFromHistory(thread: ThreadChannel, botId: string): Promise<boolean> {
	const msgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
	if (!msgs) return false;
	let paused = false;
	for (const m of [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
		if (m.author.id === botId) { if (m.content.includes(ROLE_MENTION)) paused = true; }
		else if (m.mentions.users.has(botId)) paused = false;
	}
	return paused;
}

async function handle(thread: ThreadChannel, msg: Message) {
	const started = Date.now();
	try {
		await (thread as any).sendTyping?.();
		const transcript = await threadTranscript(thread, msg.id, msg.client.user!.id);
		const reply = await answerFor(msg.content.trim(), transcript);
		// Never relay an engine/model error (or an empty result) to Discord — log it and stay quiet.
		if (!reply.trim() || looksLikeError(reply)) {
			log(`  !! suppressed non-answer (not relayed): ${reply.trim().slice(0, 160) || '(empty)'}`);
			return;
		}
		if (reply.includes(ROLE_MENTION)) { pause(thread.id); log(`  escalated → thread ${thread.id} paused`); }
		const parts = chunk(reply);
		log(`  reply in ${((Date.now() - started) / 1000).toFixed(1)}s: ${reply.length} chars, ${parts.length} msg(s)`);
		for (const part of parts) await thread.send({ content: part, allowedMentions: { roles: [ESCALATION_ROLE_ID] } });
	} catch (err) {
		// Log for ops, but do NOT relay the error to Discord.
		log(`  !! error (not relayed): ${err instanceof Error ? err.message : String(err)}`);
	}
}

// --- main --------------------------------------------------------------------
async function main() {
	if (!CHANNEL_ID) throw new Error('Set SUPPORT_CHANNEL_ID in .env (the channel to listen in).');
	if (!process.env.SUPPORT_BOT_TOKEN) throw new Error('Set SUPPORT_BOT_TOKEN in .env (the support bot token).');

	log(`pipeline: ${PIPELINE}`);
	loadPaused();
	await connectAndStart();

	const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

	discord.once(Events.ClientReady, (c) => {
		log(`bot online as ${c.user.tag} — listening in channel ${CHANNEL_ID} (replies in threads)`);
		log('waiting for messages... (Ctrl+C to stop)');
	});

	discord.on(Events.MessageCreate, async (msg: Message) => {
		if (msg.author.bot || msg.system) return;
		const text = msg.content.trim();
		if (!text) return;

		// Case 1: top-level message in the support channel → open a thread and answer there.
		if (msg.channelId === CHANNEL_ID) {
			if (await isAimedAtSomeoneElse(msg, msg.client.user!.id)) {
				log(`ack-only (aimed at someone else): ${msg.author.username}`);
				await acknowledge(msg);
				return;
			}
			log(`message from ${msg.author.username}: ${text.length > 120 ? text.slice(0, 120) + '…' : text}`);
			let thread: ThreadChannel;
			try {
				thread = await msg.startThread({ name: text.slice(0, 90) || 'Support', autoArchiveDuration: 1440 });
			} catch (err) {
				log(`  !! cannot create thread (grant "Create Public Threads" + "Send Messages in Threads"): ${err instanceof Error ? err.message : err}`);
				await msg.reply('I need permission to create a thread here — please grant **Create Public Threads** and **Send Messages in Threads**.').catch(() => {});
				return;
			}
			await handle(thread, msg);
			return;
		}

		// Case 2: a message inside a thread under the support channel → continue the conversation.
		if (msg.channel.isThread() && (msg.channel as ThreadChannel).parentId === CHANNEL_ID) {
			const thread = msg.channel as ThreadChannel;
			const botId = msg.client.user!.id;
			const mentioned = msg.mentions.users.has(botId);
			// Fast path = the persisted set. The first time we see a thread this process (e.g.
			// after a restart), reconcile with Discord history so an escalation pause is restored
			// even if the state file was lost.
			let paused = pausedThreads.has(thread.id);
			if (!paused && !resolvedThreads.has(thread.id)) {
				paused = await isPausedFromHistory(thread, botId);
				if (paused) { pause(thread.id); log(`thread ${thread.id} restored as paused from history`); }
			}
			resolvedThreads.add(thread.id);
			if (paused) {
				if (!mentioned) return; // paused → stay quiet until the bot is @-mentioned
				unpause(thread.id); // user re-engaged the bot
				log(`thread ${thread.id} re-engaged by ${msg.author.username}`);
			}
			if (await isAimedAtSomeoneElse(msg, botId)) {
				pause(thread.id); // go quiet until the bot is @-mentioned again
				log(`paused thread ${thread.id} (aimed at someone else) — quiet until @-mentioned`);
				await acknowledge(msg);
				return;
			}
			log(`thread msg from ${msg.author.username}: ${text.length > 120 ? text.slice(0, 120) + '…' : text}`);
			await handle(thread, msg);
		}
	});

	const shutdown = async () => {
		log('shutting down...');
		try { await RR?.terminate(TOKEN); } catch {}
		await RR?.disconnect().catch(() => {});
		await discord.destroy();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await discord.login(process.env.SUPPORT_BOT_TOKEN);
}

main().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
