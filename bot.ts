import 'dotenv/config';
import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import { RocketRideClient, Question } from 'rocketride';

// RocketRide support bot ("Rocket Ralph"). Reads questions in one Discord channel,
// runs them through the RAG pipeline, and replies. The agent itself decides answers
// vs. escalation (see pipelines/support.pipe); this runner just ships the reply and
// turns the literal "@RocketRide team" into a real role ping.

const PIPELINE = process.env.PIPE || 'pipelines/support.pipe';
const CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID;
const ESCALATION_ROLE_ID = process.env.SUPPORT_ESCALATION_ROLE_ID || '1331418231113650196'; // @RocketRide team

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
	if (m) {
		try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
	}
	return rawAnswer;
}

function firstAnswer(response: any): string {
	const answers = collectAnswers(response);
	const raw = answers.find((a) => a.trim().length > 0) ?? '';
	return extractFinalText(raw).trim();
}

// Turn the literal "@RocketRide team" (however the agent capitalized/spaced it) into a
// real role mention so the team actually gets pinged.
function injectRoleMention(text: string): string {
	return text.replace(/@RocketRide\s+team/gi, `<@&${ESCALATION_ROLE_ID}>`);
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
	const out: string[] = [];
	let openLang: string | null = null;
	const FENCE_RX = /^```([^\n]*)$/gm;
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
	const parts: string[] = [];
	let remaining = trimmed;
	while (remaining.length > size) {
		const cut = softBreakAt(remaining, size);
		parts.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	if (remaining) parts.push(remaining);
	const balanced = balanceFences(parts);
	const n = balanced.length;
	const labeled = n === 1 ? balanced : balanced.map((p, i) => `${p}\n\n*(${i + 1}/${n})*`);
	const safe: string[] = [];
	for (const p of labeled) {
		if (p.length <= DISCORD_LIMIT) safe.push(p);
		else for (let i = 0; i < p.length; i += DISCORD_LIMIT) safe.push(p.slice(i, i + DISCORD_LIMIT));
	}
	return safe;
}

// --- RocketRide pipeline -----------------------------------------------------
async function startFresh(rr: RocketRideClient): Promise<string> {
	try { const prev = await rr.use({ filepath: PIPELINE, useExisting: true }); await rr.terminate(prev.token); } catch {}
	const { token } = await rr.use({ filepath: PIPELINE });
	return token;
}

async function answer(rr: RocketRideClient, token: string, question: string): Promise<string> {
	const q = new Question();
	q.addQuestion(question);
	const response = await rr.chat({ token, question: q });
	return injectRoleMention(firstAnswer(response));
}

// --- main --------------------------------------------------------------------
async function main() {
	if (!CHANNEL_ID) throw new Error('Set SUPPORT_CHANNEL_ID in .env (the channel to listen in).');
	if (!process.env.SUPPORT_BOT_TOKEN) throw new Error('Set SUPPORT_BOT_TOKEN in .env (the support bot token).');

	log(`pipeline: ${PIPELINE}`);
	log(`connecting to ${process.env.ROCKETRIDE_URI ?? '(default cloud)'} ...`);
	const rr = new RocketRideClient({ uri: process.env.ROCKETRIDE_URI, auth: process.env.ROCKETRIDE_APIKEY });
	await rr.connect();
	log('connected; starting support pipeline (fresh)...');
	const token = await startFresh(rr);
	log(`pipeline ready (token: ${token})`);

	const discord = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
	});

	discord.once(Events.ClientReady, (c) => {
		log(`bot online as ${c.user.tag} — listening in channel ${CHANNEL_ID}`);
		log('waiting for messages... (Ctrl+C to stop)');
	});

	discord.on(Events.MessageCreate, async (msg: Message) => {
		if (msg.channelId !== CHANNEL_ID) return;
		if (msg.author.bot || msg.system) return;
		const text = msg.content.trim();
		if (!text) return;

		log(`message from ${msg.author.username}: ${text.length > 140 ? text.slice(0, 140) + '…' : text}`);
		const started = Date.now();
		try {
			await (msg.channel as any).sendTyping?.();
			const reply = await answer(rr, token, text);
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const parts = chunk(reply);
			log(`  reply in ${secs}s: ${reply.length} chars, ${parts.length} message(s)`);
			for (const part of parts) {
				await msg.reply({ content: part, allowedMentions: { roles: [ESCALATION_ROLE_ID], repliedUser: true } });
			}
			log('  reply sent');
		} catch (err) {
			log(`  !! error: ${err instanceof Error ? err.message : String(err)}`);
			await msg.reply('Sorry — something went wrong handling that.').catch(() => {});
		}
	});

	const shutdown = async () => {
		log('shutting down...');
		try { await rr.terminate(token); } catch {}
		await rr.disconnect().catch(() => {});
		await discord.destroy();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await discord.login(process.env.SUPPORT_BOT_TOKEN);
}

main().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
