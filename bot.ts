import 'dotenv/config';
import { Client, GatewayIntentBits, Events, ThreadChannel, type Message } from 'discord.js';
import { RocketRideClient, Question } from 'rocketride';

// RocketRide support bot ("Rocket Ralph").
// - Answers in a THREAD created off the user's message in the support channel.
// - Carries the whole thread as context on each reply.
// - When it escalates (pings @RocketRide team) it goes quiet in that thread so the
//   human team can answer; it resumes only when a user @-mentions it again.

const PIPELINE = process.env.PIPE || 'pipelines/support.pipe';
const CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID;
const ESCALATION_ROLE_ID = process.env.SUPPORT_ESCALATION_ROLE_ID || '1331418231113650196'; // @RocketRide team
const ROLE_MENTION = `<@&${ESCALATION_ROLE_ID}>`;

// Threads where the bot has escalated and is waiting for the team. While a thread is
// here, the bot ignores messages unless it is @-mentioned. In-memory → resets on restart.
const pausedThreads = new Set<string>();

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
let RR: RocketRideClient; let TOKEN: string;
async function startFresh(rr: RocketRideClient): Promise<string> {
	try { const prev = await rr.use({ filepath: PIPELINE, useExisting: true }); await rr.terminate(prev.token); } catch {}
	const { token } = await rr.use({ filepath: PIPELINE });
	return token;
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

async function answerFor(text: string, transcript: string): Promise<string> {
	const q = new Question();
	q.addQuestion(transcript ? `User's latest message: ${text}\n\nEarlier in this thread (oldest first, for context):\n${transcript}` : text);
	const response = await RR.chat({ token: TOKEN, question: q });
	return injectRoleMention(firstAnswer(response));
}

async function handle(thread: ThreadChannel, msg: Message) {
	const started = Date.now();
	try {
		await (thread as any).sendTyping?.();
		const transcript = await threadTranscript(thread, msg.id, msg.client.user!.id);
		const reply = await answerFor(msg.content.trim(), transcript);
		if (reply.includes(ROLE_MENTION)) { pausedThreads.add(thread.id); log(`  escalated → thread ${thread.id} paused`); }
		const parts = chunk(reply);
		log(`  reply in ${((Date.now() - started) / 1000).toFixed(1)}s: ${reply.length} chars, ${parts.length} msg(s)`);
		for (const part of parts) await thread.send({ content: part, allowedMentions: { roles: [ESCALATION_ROLE_ID] } });
	} catch (err) {
		log(`  !! error: ${err instanceof Error ? err.message : String(err)}`);
		await thread.send('Sorry — something went wrong handling that.').catch(() => {});
	}
}

// --- main --------------------------------------------------------------------
async function main() {
	if (!CHANNEL_ID) throw new Error('Set SUPPORT_CHANNEL_ID in .env (the channel to listen in).');
	if (!process.env.SUPPORT_BOT_TOKEN) throw new Error('Set SUPPORT_BOT_TOKEN in .env (the support bot token).');

	log(`pipeline: ${PIPELINE}`);
	log(`connecting to ${process.env.ROCKETRIDE_URI ?? '(default cloud)'} ...`);
	RR = new RocketRideClient({ uri: process.env.ROCKETRIDE_URI, auth: process.env.ROCKETRIDE_APIKEY });
	await RR.connect();
	log('connected; starting support pipeline (fresh)...');
	TOKEN = await startFresh(RR);
	log(`pipeline ready (token: ${TOKEN})`);

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
			const mentioned = msg.mentions.users.has(msg.client.user!.id);
			if (pausedThreads.has(thread.id)) {
				if (!mentioned) return; // escalated → stay quiet so the team can answer
				pausedThreads.delete(thread.id); // user re-engaged the bot
				log(`thread ${thread.id} re-engaged by ${msg.author.username}`);
			}
			log(`thread msg from ${msg.author.username}: ${text.length > 120 ? text.slice(0, 120) + '…' : text}`);
			await handle(thread, msg);
		}
	});

	const shutdown = async () => {
		log('shutting down...');
		try { await RR.terminate(TOKEN); } catch {}
		await RR.disconnect().catch(() => {});
		await discord.destroy();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await discord.login(process.env.SUPPORT_BOT_TOKEN);
}

main().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
