import 'dotenv/config';
import { Client, GatewayIntentBits, Events, ThreadChannel, type Message } from 'discord.js';
import { RocketRideClient, Question } from 'rocketride';

// RocketRide support TEST bot (support-test.ts) — CHAT interface (temporary).
// Talks to the pipeline's CHAT interface DEPLOYED on RocketRide Cloud, the same one the
// hosted widget uses: https://api.rocketride.ai/chat?auth=pk_...  The publishable pk_ key
// IS the chat token — chat({ token: pk_key, question }) over the SDK's WebSocket. Single
// question -> single answer, so there is NO summariser and NO per-modality webhook here.
// "Only for now": this replaces the earlier webhook + summariser flow while we iterate.
// Text-only: the typed message (+ any text-like file contents) is sent; media attachments
// are noted and skipped, since the chat interface is conversational text Q&A.

const CHANNEL_ID = process.env.SUPPORT_TEST_CHANNEL_ID;
const BOT_TOKEN = process.env.SUPPORT_TEST_BOT_TOKEN || process.env.SUPPORT_BOT_TOKEN;
const CHAT_URI = process.env.SUPPORT_TEST_CHAT_URI || process.env.ROCKETRIDE_URI || 'https://api.rocketride.ai';
// Publishable chat key (pk_...). With the chat interface the key doubles as the chat token.
const CHAT_KEY = process.env.SUPPORT_TEST_CHAT_KEY;
const ESCALATION_ROLE_ID = process.env.SUPPORT_ESCALATION_ROLE_ID || '1331418231113650196'; // @RocketRide team
const ROLE_MENTION = `<@&${ESCALATION_ROLE_ID}>`;
// How many prior thread messages to carry as conversation history on a follow-up.
const HISTORY_LIMIT = 8;

// Threads where the bot escalated → stays quiet until @-mentioned. In-memory (test bot).
const pausedThreads = new Set<string>();

function log(...args: unknown[]) {
	console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

// Turn the literal "@RocketRide team" the agent wrote into a real role mention so the team is pinged.
function injectRoleMention(text: string): string {
	return text.replace(/@RocketRide\s+team/gi, ROLE_MENTION);
}

function extractFinalText(rawAnswer: string): string {
	const m = rawAnswer.match(/\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/);
	if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
	return rawAnswer;
}

// Engine/model failures can surface as the "answer" text (an OpenAI/Anthropic API error, a
// Python traceback, an engine stack frame). Detect those so we never relay them to Discord.
function looksLikeError(text: string): boolean {
	return /an error occurred with the \w+ api\b/i.test(text)
		|| /\b(chat|agent)\.py:\d+/i.test(text)
		|| /_run failed\b/i.test(text)
		|| /Traceback \(most recent call last\)/i.test(text);
}

// --- response parsing (mirrors the RocketRide chat widget) -------------------
// The chat response carries result_types { lane: 'answers' | 'text' | ... }; the answer
// lives under a lane typed 'answers' or 'text' (a string, an array of strings, or an
// object with an { answer } field).
function collectAnswers(r: any): string[] {
	const out: string[] = [];
	const rt = r?.result_types ?? {};
	for (const [key, laneType] of Object.entries(rt)) {
		if (laneType !== 'answers' && laneType !== 'text') continue;
		const val = r[key];
		if (Array.isArray(val)) { for (const x of val) if (typeof x === 'string' && x.trim()) out.push(x); }
		else if (typeof val === 'string' && val.trim()) out.push(val);
		else if (val && typeof val === 'object' && typeof val.answer === 'string' && val.answer.trim()) out.push(val.answer);
	}
	if (!out.length && Array.isArray(r?.answers)) for (const x of r.answers) if (typeof x === 'string' && x.trim()) out.push(x);
	return out;
}
function firstAnswer(r: any): string {
	const raw = collectAnswers(r).find((a) => a.trim()) ?? '';
	return extractFinalText(raw).trim();
}

// --- text collection (typed message + text-like file attachments) -----------
const TEXT_FILE_EXTS = ['.pipe', '.json', '.yaml', '.yml', '.txt', '.log', '.md', '.csv', '.toml', '.ini', '.xml', '.js', '.ts', '.py'];
const TEXT_FILE_MAX_BYTES = 512 * 1024;
const TEXT_FILE_MAX_CHARS = 12_000;
function isTextFile(att: { name: string; contentType: string | null; size: number }): boolean {
	if (att.size > TEXT_FILE_MAX_BYTES) return false;
	const mime = (att.contentType ?? '').split(';')[0].trim();
	if (mime.startsWith('text/') || mime.includes('json') || mime.includes('yaml') || mime.includes('xml')) return true;
	return TEXT_FILE_EXTS.some((ext) => att.name.toLowerCase().endsWith(ext));
}

async function collectText(msg: Message): Promise<string> {
	const bits: string[] = [];
	const text = msg.content.trim();
	if (text) bits.push(text);
	for (const att of msg.attachments.values()) {
		if (isTextFile(att)) {
			try {
				const res = await fetch(att.url);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				let content = Buffer.from(await res.arrayBuffer()).toString('utf8');
				if (content.includes(String.fromCharCode(0))) { log(`  skipping ${att.name} (binary)`); continue; }
				if (content.length > TEXT_FILE_MAX_CHARS) content = content.slice(0, TEXT_FILE_MAX_CHARS) + '\n… (truncated)';
				bits.push(`Contents of attached file "${att.name}":\n\`\`\`\n${content}\n\`\`\``);
				log(`  attached text file ${att.name} (${content.length} chars)`);
			} catch (e) { log(`  could not read ${att.name}: ${e instanceof Error ? e.message : e}`); }
			continue;
		}
		// Chat interface is text-only for now — note and skip media/binary attachments.
		log(`  ignoring attachment ${att.name} (${att.contentType ?? 'unknown'}) — chat interface is text-only for now`);
	}
	if (!msg.content.trim() && bits.length) bits.unshift('The user shared the following file(s) with no message. Explain what each file is and what it does, and help them with it.');
	return bits.join('\n\n');
}

// --- chat client ------------------------------------------------------------
let RR: RocketRideClient;

async function connectChat(): Promise<void> {
	try { await RR?.disconnect(); } catch {}
	RR = new RocketRideClient({
		uri: CHAT_URI,
		auth: CHAT_KEY,
		persist: true, // auto-reconnect across transient drops
		onConnected: async () => log('  chat connection established'),
		onDisconnected: async (reason, hasError) => { if (hasError) log(`  chat connection lost: ${reason ?? 'unknown'}`); },
	});
	log(`connecting to ${CHAT_URI} (cloud chat, auth ${CHAT_KEY!.slice(0, 6)}…) ...`);
	await RR.connect(CHAT_KEY);
	log('chat ready');
}

function isConnectionError(err: unknown): boolean {
	const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return /not connected|connection closed|disconnect|socket|econnrefused|websocket|invalid token|unknown token/.test(m);
}

// Prior thread messages (oldest first) as chat history, excluding the current message.
async function threadHistory(thread: ThreadChannel, exceptId: string, botId: string): Promise<Array<{ role: string; content: string }>> {
	const fetched = await thread.messages.fetch({ limit: 50 }).catch(() => null);
	if (!fetched) return [];
	return [...fetched.values()]
		.filter((m) => m.id !== exceptId && !m.system && m.content.trim())
		.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
		.slice(-HISTORY_LIMIT)
		.map((m) => ({ role: m.author.id === botId ? 'assistant' : 'user', content: m.content.trim() }));
}

async function askChat(text: string, history: Array<{ role: string; content: string }>): Promise<string> {
	const build = () => { const q = new Question(); q.addQuestion(text); for (const h of history) q.addHistory(h); return q; };
	try {
		return injectRoleMention(firstAnswer(await RR.chat({ token: CHAT_KEY!, question: build() })));
	} catch (err) {
		if (!isConnectionError(err)) throw err;
		log(`  chat failed on a dead connection (${err instanceof Error ? err.message : err}) — reconnecting and retrying once...`);
		await connectChat();
		return injectRoleMention(firstAnswer(await RR.chat({ token: CHAT_KEY!, question: build() })));
	}
}

// --- Discord chunking (<=2000 chars) ----------------------------------------
const DISCORD_LIMIT = 2000;
function chunk(text: string, size = 1900): string[] {
	const trimmed = text.trim();
	if (!trimmed) return ['(empty response)'];
	const out: string[] = [];
	let rest = trimmed;
	while (rest.length > size) {
		let cut = rest.lastIndexOf('\n', size); if (cut < size * 0.6) cut = rest.lastIndexOf(' ', size); if (cut < size * 0.6) cut = size;
		out.push(rest.slice(0, cut).trimEnd()); rest = rest.slice(cut).trimStart();
	}
	if (rest) out.push(rest);
	return out.flatMap((p) => (p.length <= DISCORD_LIMIT ? [p] : Array.from({ length: Math.ceil(p.length / DISCORD_LIMIT) }, (_, i) => p.slice(i * DISCORD_LIMIT, (i + 1) * DISCORD_LIMIT))));
}

async function handle(thread: ThreadChannel, msg: Message) {
	const started = Date.now();
	try {
		await (thread as any).sendTyping?.().catch(() => {}); // cosmetic; never let it abort the reply
		const text = await collectText(msg);
		if (!text.trim()) { log('  nothing to send'); return; }
		const history = await threadHistory(thread, msg.id, msg.client.user!.id);
		const reply = await askChat(text, history);
		if (!reply.trim() || looksLikeError(reply)) { log(`  !! suppressed non-answer (not relayed): ${reply.trim().slice(0, 160) || '(empty)'}`); return; }
		if (reply.includes(ROLE_MENTION)) { pausedThreads.add(thread.id); log(`  escalated → thread ${thread.id} paused`); }
		const chunks = chunk(reply);
		log(`  reply in ${((Date.now() - started) / 1000).toFixed(1)}s: ${reply.length} chars, ${chunks.length} msg(s)`);
		for (const part of chunks) await thread.send({ content: part, allowedMentions: { roles: [ESCALATION_ROLE_ID] } });
	} catch (err) {
		log(`  !! error (not relayed): ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function main() {
	if (!CHANNEL_ID) throw new Error('Set SUPPORT_TEST_CHANNEL_ID in .env (the test channel).');
	if (!BOT_TOKEN) throw new Error('Set SUPPORT_TEST_BOT_TOKEN (or SUPPORT_BOT_TOKEN) in .env.');
	if (!CHAT_KEY) throw new Error('Set SUPPORT_TEST_CHAT_KEY in .env (the pk_ chat key).');

	await connectChat();

	const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

	discord.once(Events.ClientReady, (c) => {
		log(`bot online as ${c.user.tag} — test channel ${CHANNEL_ID} (cloud chat interface, replies in threads)`);
		log('waiting for messages... (Ctrl+C to stop)');
	});

	discord.on(Events.MessageCreate, async (msg: Message) => {
		if (msg.author.bot || msg.system) return;
		const text = msg.content.trim();
		if (!text && msg.attachments.size === 0) return;
		const botId = msg.client.user!.id;

		// Case 1: top-level message in the test channel → open a thread and answer there.
		if (msg.channelId === CHANNEL_ID) {
			log(`message from ${msg.author.username}: ${text ? (text.length > 120 ? text.slice(0, 120) + '…' : text) : '(no text)'} (+${msg.attachments.size} attachment(s))`);
			let thread: ThreadChannel;
			try {
				const name = (text || [...msg.attachments.values()][0]?.name || 'Support').slice(0, 90);
				thread = await msg.startThread({ name, autoArchiveDuration: 1440 });
			} catch (err) {
				log(`  !! cannot create thread: ${err instanceof Error ? err.message : err}`);
				await msg.reply('I need permission to create a thread here — please grant **Create Public Threads** and **Send Messages in Threads**.').catch(() => {});
				return;
			}
			await handle(thread, msg);
			return;
		}

		// Case 2: a message inside a thread under the test channel → continue the conversation.
		if (msg.channel.isThread() && (msg.channel as ThreadChannel).parentId === CHANNEL_ID) {
			const thread = msg.channel as ThreadChannel;
			const mentioned = msg.mentions.users.has(botId);
			if (pausedThreads.has(thread.id)) {
				if (!mentioned) return;
				pausedThreads.delete(thread.id);
				log(`thread ${thread.id} re-engaged by ${msg.author.username}`);
			}
			log(`thread msg from ${msg.author.username}: ${text ? (text.length > 120 ? text.slice(0, 120) + '…' : text) : '(no text)'} (+${msg.attachments.size} attachment(s))`);
			await handle(thread, msg);
		}
	});

	const shutdown = async () => { log('shutting down...'); await RR?.disconnect().catch(() => {}); await discord.destroy(); process.exit(0); };
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await discord.login(BOT_TOKEN);
}

// `tsx support-test.ts --ask "question"` connects, asks once, prints the answer, and exits —
// for testing the cloud chat connection without Discord.
if (process.argv.includes('--ask')) {
	const q = process.argv[process.argv.indexOf('--ask') + 1] || 'ping';
	connectChat()
		.then(() => askChat(q, []))
		.then((a) => console.log('\n--- answer ---\n' + a))
		.then(() => RR?.disconnect())
		.then(() => process.exit(0))
		.catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
} else {
	main().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
}
