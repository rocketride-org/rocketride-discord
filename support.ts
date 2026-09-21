import 'dotenv/config';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client, GatewayIntentBits, Events, ThreadChannel, ContextMenuCommandBuilder, ApplicationCommandType, type Message } from 'discord.js';
import { RocketRideClient } from 'rocketride';
import { initSlackRouter, notifyEscalation, escalateManually } from './slack-router';
import { sanitizeReply } from './reply-sanitize';

// RocketRide support bot ("Rocket Ralph") — MAIN support channel, webhook + multi-modal.
// - The user's typed text and each image/audio/video attachment are sent to the
//   rocket-ralph WEBHOOK pipeline per modality; text-like files (.pipe/.json/logs/code)
//   are folded into the text part so intent + content travel together.
// - A message that yields >1 result is merged into ONE reply by the summariser pipeline.
// - Answers in a THREAD created off the user's message; the thread transcript is carried
//   as context on follow-ups (the webhook pipeline itself is stateless).
// - When it escalates (pings @RocketRide team) it goes quiet in that thread so the human
//   team can answer; it resumes only when a user @-mentions it again.
// - When a message is aimed at another person (@-mentions someone else, or replies to a
//   non-bot message) it reacts and — inside a thread — also goes quiet until @-mentioned.
// Runs against the LOCAL engine (auto-detects its dynamic listen port).

const RALPH_PIPE = process.env.PIPE || 'pipelines/rocket-ralph.pipe';
const SYNTH_PIPE = process.env.SYNTH_PIPE || 'pipelines/summariser.pipe';
// The rocket-ralph pipe has multiple source nodes (webhook/chat/dropper); the bot sends
// via the WEBHOOK node, so the engine must start the pipeline on that source.
const RALPH_SOURCE = process.env.PIPE_SOURCE || 'webhook_1';
const CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID;
// A second, "guest" channel: the bot only engages here when it is @-mentioned (on a top-level
// message), then behaves exactly like the primary channel. Set to '' to disable.
const MENTION_CHANNEL_ID = process.env.SUPPORT_MENTION_CHANNEL_ID ?? '1480957995964956702';
// Test mode (driver bot allowed): also log full reply text so an external test harness
// without the MessageContent intent can capture replies. Unset in production.
const TEST_MODE = !!(process.env.TEST_ALLOW_BOT_IDS ?? '').trim();
const ESCALATION_ROLE_ID = process.env.SUPPORT_ESCALATION_ROLE_ID || '1331418231113650196'; // @RocketRide team
const ROLE_MENTION = `<@&${ESCALATION_ROLE_ID}>`;

// "Escalate to Slack" message command (right-click a message → Apps). Access is gated to anyone
// with the @RocketRide team role, PLUS any explicit user IDs listed here (comma-separated). The
// ephemeral reply keeps the whole interaction private to the invoker.
const ESCALATE_COMMAND = 'Escalate to Slack';
const ESCALATE_USER_IDS = (process.env.SUPPORT_ESCALATE_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// When a message is aimed at another person (@-mentions someone else, or replies to a
// message that isn't the bot's), Ralph reacts with this emoji and — inside a thread —
// goes quiet until it's @-mentioned again.
const ACK_EMOJI = process.env.SUPPORT_ACK_EMOJI || '👀';

// Threads where the bot is paused — either it escalated to the team, or a message was
// aimed at someone else. While a thread is here, the bot stays quiet and ignores messages
// until it is @-mentioned. Persisted to disk so a restart doesn't silently resume an
// escalated thread, and reconstructable from thread history (see isPausedFromHistory).
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

// --- engine connection ------------------------------------------------------
// The local engine (launched by the VSCode extension) listens on a DYNAMIC port that changes
// on every engine restart, so a baked-in URI goes stale. The client-facing engine is the
// `eaas.py` process; per-pipeline TASK processes ALSO listen (on debug/data ports), so a plain
// "grep engine | head -1" can grab a task port (e.g. another bot's running pipeline) and connect
// to a dead end. Match eaas first, then fall back to any engine listener, then ROCKETRIDE_URI.
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

// --- pipeline ---------------------------------------------------------------
let RR: RocketRideClient | undefined;
let RALPH_TOKEN: string | null = null; let SYNTH_TOKEN: string | null = null;

async function startFresh(rr: RocketRideClient, filepath: string, source?: string): Promise<string> {
	try { const prev = await rr.use({ filepath, useExisting: true, ...(source ? { source } : {}) }); await rr.terminate(prev.token); } catch {}
	// ttl: 0 → no idle timeout. The bot can sit quiet for hours between messages;
	// with the server default TTL the pipeline expires and sends fail with
	// "Failed to open a data pipe".
	const { token } = await rr.use({ filepath, ttl: 0, ...(source ? { source } : {}) });
	return token;
}

// Connect to the local engine (current dynamic port) and start both pipelines fresh.
async function connectAndStart(): Promise<void> {
	try { await RR?.disconnect(); } catch {}
	const uri = detectEngineUri();
	const rr = new RocketRideClient({
		uri,
		auth: process.env.ROCKETRIDE_APIKEY,
		persist: true, // auto-reconnect (exponential backoff) across transient drops
		onConnected: async () => log('  connection established'),
		onDisconnected: async (reason, hasError) => { if (hasError) log(`  connection lost: ${reason ?? 'unknown'}`); },
	});
	log(`connecting to ${uri} (local engine) ...`);
	await rr.connect();
	log('connected; starting pipelines (fresh)...');
	RR = rr;
	RALPH_TOKEN = await startFresh(rr, RALPH_PIPE, RALPH_SOURCE);
	SYNTH_TOKEN = await startFresh(rr, SYNTH_PIPE);
	log(`pipelines ready (ralph: ${RALPH_TOKEN} [${RALPH_SOURCE}], summariser: ${SYNTH_TOKEN})`);
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

// --- multi-modal handling ---------------------------------------------------
type Part = { modality: 'text' | 'image' | 'audio' | 'video'; name: string; mimetype: string; data: string | Uint8Array };

function modalityOf(contentType: string | null): Part['modality'] | null {
	const mime = (contentType ?? '').split(';')[0].trim();
	if (mime.startsWith('image/')) return 'image';
	if (mime.startsWith('audio/')) return 'audio';
	if (mime.startsWith('video/')) return 'video';
	return null;
}

// Text-like attachments (.pipe files, configs, logs, code) are folded into the text part
// alongside the user's typed message, so the agent sees intent and content together.
const TEXT_FILE_EXTS = ['.pipe', '.json', '.yaml', '.yml', '.txt', '.log', '.md', '.csv', '.toml', '.ini', '.xml', '.js', '.ts', '.py', '.env.example'];
const TEXT_FILE_MAX_BYTES = 512 * 1024;
const TEXT_FILE_MAX_CHARS = 12_000;

function isTextFile(att: { name: string; contentType: string | null; size: number }): boolean {
	if (att.size > TEXT_FILE_MAX_BYTES) return false;
	const mime = (att.contentType ?? '').split(';')[0].trim();
	if (mime.startsWith('text/') || mime.includes('json') || mime.includes('yaml') || mime.includes('xml')) return true;
	const lower = att.name.toLowerCase();
	return TEXT_FILE_EXTS.some((ext) => lower.endsWith(ext));
}

async function collectParts(msg: Message): Promise<Part[]> {
	// IMPORTANT: object names must be unique per request. The engine derives the objectId
	// from the name, and reusing a name in a running pipeline makes stateful nodes (e.g. the
	// summariser's prompt node) accumulate context from previous requests — replies then
	// leak earlier questions' content.
	const parts: Part[] = [];
	const textBits: string[] = [];
	const text = msg.content.trim();
	if (text) textBits.push(text);
	for (const att of msg.attachments.values()) {
		const modality = modalityOf(att.contentType);
		if (modality) {
			const res = await fetch(att.url);
			if (!res.ok) throw new Error(`download failed for ${att.name}: HTTP ${res.status}`);
			const data = new Uint8Array(await res.arrayBuffer());
			parts.push({ modality, name: `${msg.id}-${att.name}`, mimetype: (att.contentType ?? '').split(';')[0].trim(), data });
			continue;
		}
		if (isTextFile(att)) {
			const res = await fetch(att.url);
			if (!res.ok) throw new Error(`download failed for ${att.name}: HTTP ${res.status}`);
			let content = Buffer.from(await res.arrayBuffer()).toString('utf8');
			if (content.includes(String.fromCharCode(0))) { log(`  skipping attachment ${att.name} (binary content)`); continue; }
			if (content.length > TEXT_FILE_MAX_CHARS) content = content.slice(0, TEXT_FILE_MAX_CHARS) + '\n… (truncated)';
			textBits.push(`Contents of attached file "${att.name}":\n\`\`\`\n${content}\n\`\`\``);
			log(`  attached text file ${att.name} (${content.length} chars)`);
			continue;
		}
		log(`  skipping attachment ${att.name} (${att.contentType ?? 'unknown type'})`);
	}
	// If the user attached file(s) but typed no message, frame it as a request so the agent
	// explains the file(s) instead of falling back to a generic answer (a bare config/doc
	// gives the agent no task).
	if (!text && textBits.length) textBits.unshift('The user shared the following file(s) with no message. Explain what each file is and what it does, and help them with it.');
	if (textBits.length) parts.unshift({ modality: 'text', name: `${msg.id}-message.txt`, mimetype: 'text/plain', data: textBits.join('\n\n') });
	return parts;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);
}

async function askRalph(parts: Part[]): Promise<Array<{ modality: string; result: any }>> {
	return Promise.all(parts.map(async (part) => {
		try {
			const result = await withTimeout(RR!.send(RALPH_TOKEN!, part.data, { name: part.name }, part.mimetype), 180_000, part.modality);
			// Cap raw OCR/transcript evidence so the summariser payload stays bounded.
			if (Array.isArray(result?.extracted_text)) result.extracted_text = result.extracted_text.map((t: unknown) => String(t).slice(0, 3000));
			log(`  [${part.modality}] ${firstAnswer(result).slice(0, 80)}`);
			return { modality: part.modality, result };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			log(`  [${part.modality}] error: ${error}`);
			return { modality: part.modality, result: { error } };
		}
	}));
}

// Engine bug workaround: the prompt node's instance state is created once per pipeline task
// and its collected context is never reset between requests, so a long-lived summariser
// instance leaks earlier requests' content into later replies. Serialize summariser use and
// restart the instance after each send. (The rocket-ralph pipe's in-pipe prompt node is
// handled by the engine's IInstance.py closing() reset patch instead — the bot can't restart it.)
let synthLock: Promise<unknown> = Promise.resolve();
function synthesize(payload: string, requestId: string): Promise<any> {
	const result = synthLock.then(() =>
		withTimeout(RR!.send(SYNTH_TOKEN!, payload, { name: `${requestId}-results.json` }, 'text/plain'), 120_000, 'summariser'));
	synthLock = result.catch(() => {}).then(async () => {
		try { await RR!.terminate(SYNTH_TOKEN!); } catch {}
		try { SYNTH_TOKEN = (await RR!.use({ filepath: SYNTH_PIPE, ttl: 0 })).token; }
		catch (err) { log(`  !! summariser restart failed: ${err instanceof Error ? err.message : err}`); }
	});
	return result;
}

async function combineIfNeeded(results: Array<{ modality: string; result: any }>, requestId: string, userMessage?: string): Promise<string> {
	if (results.length === 1) {
		log(`  single ${results[0].modality} result — replying directly, no synthesis`);
		return firstAnswer(results[0].result) || 'Sorry — I could not process that.';
	}
	log(`  ${results.length} results (${results.map((r) => r.modality).join('+')}) — merging via summariser`);
	const merged = await synthesize(JSON.stringify({ user_message: userMessage || undefined, results }), requestId);
	for (const a of collectAnswers(merged)) {
		try { const parsed = JSON.parse(a); if (parsed?.answer) { if (parsed.notes) log(`  synth notes: ${parsed.notes}`); return String(parsed.answer); } } catch {}
	}
	return firstAnswer(merged) || 'Sorry — I could not process that.';
}

// A message is "aimed at someone else" (so Ralph just acknowledges) when it @-mentions a
// user or role other than the bot, or replies to a message that isn't the bot's.
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
// carrying the team role-mention pauses; a later user @-mention of the bot resumes.
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

// Handle one message inside its thread: gather parts (text + attachments), ask the webhook
// pipeline per modality, merge if needed, and reply. Used for both a new thread and follow-ups.
async function handle(thread: ThreadChannel, msg: Message) {
	const started = Date.now();
	try {
		// sendTyping is cosmetic and Discord's typing endpoint intermittently 500s — guard it.
		await (thread as any).sendTyping?.().catch(() => {});
		const parts = await collectParts(msg);
		if (!parts.length) return;
		// Carry thread context on the text part (empty for a brand-new thread → no-op).
		const transcript = await threadTranscript(thread, msg.id, msg.client.user!.id);
		if (transcript) {
			const textPart = parts.find((p) => p.modality === 'text');
			if (textPart) textPart.data = `User's latest message: ${textPart.data}\n\nEarlier in this thread (oldest first, for context):\n${transcript}`;
		}
		log(`  parts: ${parts.map((p) => p.modality).join(', ')}`);
		const results = await askRalph(parts);
		// Strip any leaked CrewAI/ReAct scratchpad ("Thought: …") before relaying — the agent
		// occasionally emits its raw reasoning instead of a clean answer.
		const reply = sanitizeReply(injectRoleMention(await combineIfNeeded(results, msg.id, msg.content.trim())), ROLE_MENTION);
		// Never relay an engine/model error (or an empty result) to Discord — log it and stay quiet.
		if (!reply.trim() || looksLikeError(reply)) {
			log(`  !! suppressed non-answer (not relayed): ${reply.trim().slice(0, 160) || '(empty)'}`);
			return;
		}
		if (reply.includes(ROLE_MENTION)) {
			const firstEscalation = !pausedThreads.has(thread.id); // page Slack once per thread, not on every follow-up
			pause(thread.id);
			log(`  escalated → thread ${thread.id} paused`);
			if (firstEscalation) void notifyEscalation(thread, msg, reply, log); // best-effort; never blocks the reply
		}
		const chunks = chunk(reply);
		log(`  reply in ${((Date.now() - started) / 1000).toFixed(1)}s: ${reply.length} chars, ${chunks.length} msg(s)`);
		if (TEST_MODE) log(`  FULL REPLY [thread ${thread.id}]:\n${reply}\n  END REPLY`);
		for (const part of chunks) await thread.send({ content: part, allowedMentions: { roles: [ESCALATION_ROLE_ID] } });
	} catch (err) {
		log(`  !! error (not relayed): ${err instanceof Error ? err.message : String(err)}`);
	}
}

// --- main --------------------------------------------------------------------
async function main() {
	if (!CHANNEL_ID) throw new Error('Set SUPPORT_CHANNEL_ID in .env (the channel to listen in).');
	if (!process.env.SUPPORT_BOT_TOKEN) throw new Error('Set SUPPORT_BOT_TOKEN in .env (the support bot token).');

	log(`pipelines: ${RALPH_PIPE} [${RALPH_SOURCE}] + ${SYNTH_PIPE}`);
	loadPaused();
	initSlackRouter(log);
	await connectAndStart();

	const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

	discord.once(Events.ClientReady, async (c) => {
		log(`bot online as ${c.user.tag} — primary channel ${CHANNEL_ID}${MENTION_CHANNEL_ID ? `, mention-only channel ${MENTION_CHANNEL_ID}` : ''} (webhook + multi-modal, replies in threads)`);
		// Register the "Escalate to Slack" message context-menu command per guild (instant, vs
		// global commands' ~1h propagation). Upsert-by-name, so re-running on restart is harmless.
		// Access is enforced in the interaction handler (team role / allowlist), not by Discord perms.
		const cmd = new ContextMenuCommandBuilder().setName(ESCALATE_COMMAND).setType(ApplicationCommandType.Message);
		for (const guild of c.guilds.cache.values()) {
			try { await guild.commands.create(cmd); log(`  registered "${ESCALATE_COMMAND}" in ${guild.name}`); }
			catch (err) { log(`  !! could not register "${ESCALATE_COMMAND}" in ${guild.name} (re-invite the bot with the applications.commands scope): ${err instanceof Error ? err.message : err}`); }
		}
		log('waiting for messages... (Ctrl+C to stop)');
	});

	// Test harness: comma-separated bot user IDs allowed to trigger the bot (e.g. a driver
	// bot posting test messages). Unset in production.
	const allowedBotIds = (process.env.TEST_ALLOW_BOT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

	discord.on(Events.MessageCreate, async (msg: Message) => {
		if (msg.author.id === msg.client.user!.id) return;
		if ((msg.author.bot && !allowedBotIds.includes(msg.author.id)) || msg.system) return;
		const text = msg.content.trim();
		if (!text && msg.attachments.size === 0) return; // nothing to act on

		const botId = msg.client.user!.id;
		const inPrimary = msg.channelId === CHANNEL_ID;
		const inMention = Boolean(MENTION_CHANNEL_ID) && msg.channelId === MENTION_CHANNEL_ID;

		// Case 1: top-level message in a listened channel → open a thread and answer there.
		if (inPrimary || inMention) {
			if (inMention && !msg.mentions.users.has(botId)) return; // guest channel: ignore unless @-mentioned
			if (await isAimedAtSomeoneElse(msg, botId)) {
				log(`ack-only (aimed at someone else): ${msg.author.username}`);
				await acknowledge(msg);
				return;
			}
			log(`message from ${msg.author.username}: ${text ? (text.length > 120 ? text.slice(0, 120) + '…' : text) : '(no text)'} (+${msg.attachments.size} attachment(s))`);
			let thread: ThreadChannel;
			try {
				const name = (text || [...msg.attachments.values()][0]?.name || 'Support').slice(0, 90);
				thread = await msg.startThread({ name, autoArchiveDuration: 1440 });
			} catch (err) {
				log(`  !! cannot create thread (grant "Create Public Threads" + "Send Messages in Threads"): ${err instanceof Error ? err.message : err}`);
				await msg.reply('I need permission to create a thread here — please grant **Create Public Threads** and **Send Messages in Threads**.').catch(() => {});
				return;
			}
			await handle(thread, msg);
			return;
		}

		// Case 2: a message inside a thread under a listened channel → continue the conversation.
		if (
			msg.channel.isThread() &&
			((msg.channel as ThreadChannel).parentId === CHANNEL_ID ||
				(Boolean(MENTION_CHANNEL_ID) && (msg.channel as ThreadChannel).parentId === MENTION_CHANNEL_ID))
		) {
			const thread = msg.channel as ThreadChannel;
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
			log(`thread msg from ${msg.author.username}: ${text ? (text.length > 120 ? text.slice(0, 120) + '…' : text) : '(no text)'} (+${msg.attachments.size} attachment(s))`);
			await handle(thread, msg);
		}
	});

	// "Escalate to Slack" message command: right-click a message → Apps → Escalate to Slack.
	// Gated to the @RocketRide team role (or an allowlisted user); the reply is ephemeral so the
	// whole interaction stays private to the invoker. Unlike auto-escalation this ALWAYS posts.
	discord.on(Events.InteractionCreate, async (interaction) => {
		if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== ESCALATE_COMMAND) return;
		await interaction.deferReply({ ephemeral: true }).catch(() => {});
		// Access gate: @RocketRide team role, or an explicit allowlisted user ID.
		let authorized = ESCALATE_USER_IDS.includes(interaction.user.id);
		if (!authorized && interaction.inGuild()) {
			const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
			authorized = Boolean(member?.roles.cache.has(ESCALATION_ROLE_ID));
		}
		if (!authorized) {
			log(`escalate: denied for ${interaction.user.username}`);
			await interaction.editReply(`🚫 Only the **@RocketRide team** can escalate to Slack.`).catch(() => {});
			return;
		}
		const target = interaction.targetMessage;
		const targetText = target.content?.trim() ?? '';
		const attNames = [...target.attachments.values()].map((a) => a.name).filter(Boolean);
		if (!targetText && !attNames.length) {
			await interaction.editReply('Nothing to escalate — that message has no text or attachments.').catch(() => {});
			return;
		}
		const result = await escalateManually({
			text: targetText,
			authorName: target.member?.displayName ?? target.author.globalName ?? target.author.username,
			messageUrl: target.url,
			escalatorName: interaction.user.globalName ?? interaction.user.username,
			attachmentsNote: attNames.length ? ` [attachments: ${attNames.join(', ')}]` : '',
		}, log);
		if (result.ok) {
			const who = result.owners ? `tagged **${result.label}** (${result.owners} owner${result.owners === 1 ? '' : 's'})` : 'posted **untagged** — no area matched, please self-assign';
			log(`escalate: ${interaction.user.username} → Slack (${result.label}, ${result.owners} owner(s))`);
			await interaction.editReply(`✅ Escalated to Slack — ${who}.`).catch(() => {});
		} else {
			log(`escalate: failed for ${interaction.user.username}: ${result.reason}`);
			await interaction.editReply(`⚠️ Couldn't escalate: ${result.reason}`).catch(() => {});
		}
	});

	const shutdown = async () => {
		log('shutting down...');
		if (RALPH_TOKEN) { try { await RR?.terminate(RALPH_TOKEN); } catch {} }
		if (SYNTH_TOKEN) { try { await RR?.terminate(SYNTH_TOKEN); } catch {} }
		await RR?.disconnect().catch(() => {});
		await discord.destroy();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await discord.login(process.env.SUPPORT_BOT_TOKEN);
}

// `tsx support.ts --send-once "your question"` connects, sends one text part, prints the
// answer, and exits — for testing the webhook pipeline connection without Discord.
if (process.argv.includes('--send-once')) {
	const prompt = process.argv[process.argv.indexOf('--send-once') + 1] || 'ping';
	const reqId = `test-${new Date().toISOString().replace(/[^0-9]/g, '')}`;
	connectAndStart()
		.then(() => askRalph([{ modality: 'text', name: `${reqId}-message.txt`, mimetype: 'text/plain', data: prompt }]))
		.then((r) => combineIfNeeded(r, reqId, prompt))
		.then((a) => {
			const raw = injectRoleMention(a);
			const shown = sanitizeReply(raw, ROLE_MENTION);
			console.log('\n--- raw pipeline output ---\n' + raw);
			console.log('\n--- shown on Discord (after sanitize) ---\n' + (shown.trim() ? shown : '(empty → bot stays quiet, nothing posted)'));
		})
		.then(() => RR?.disconnect())
		.then(() => process.exit(0))
		.catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
} else {
	main().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
}
