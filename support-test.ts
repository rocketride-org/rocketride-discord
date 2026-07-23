import 'dotenv/config';
import { Client, GatewayIntentBits, Events, ThreadChannel, type Message } from 'discord.js';

// RocketRide support TEST bot (support-test.ts).
// A thin webhook client: posts messages from the test channel to a pipeline DEPLOYED on
// RocketRide Cloud via its webhook endpoint (HTTP POST, pk_ auth), and replies with the
// answer. Multi-modal: the typed text and each image/audio/video attachment are POSTed as
// separate objects (with their mimetype); text-like files are folded into the text part.
// Its own process, like the other bots — no local engine, no SDK. The cloud pipeline must
// be deployed AND running for this to return answers.

const CHANNEL_ID = process.env.SUPPORT_TEST_CHANNEL_ID;
const BOT_TOKEN = process.env.SUPPORT_TEST_BOT_TOKEN || process.env.SUPPORT_BOT_TOKEN;
const WEBHOOK_URL = process.env.SUPPORT_TEST_WEBHOOK_URL || 'https://api.rocketride.ai/webhook';
const WEBHOOK_KEY = process.env.SUPPORT_TEST_WEBHOOK_KEY; // pk_... — ralph pipeline (per-modality)
const SUMMARISER_KEY = process.env.SUPPORT_TEST_SUMMARISER_KEY; // pk_... — summariser (merges multi-part)
const ESCALATION_ROLE_ID = process.env.SUPPORT_ESCALATION_ROLE_ID || '1331418231113650196'; // @RocketRide team
const ROLE_MENTION = `<@&${ESCALATION_ROLE_ID}>`;
// Verbose: log the raw webhook envelope (this is a test bot). Set SUPPORT_TEST_VERBOSE=0 to quiet.
const VERBOSE = (process.env.SUPPORT_TEST_VERBOSE ?? '1') !== '0';

// Threads where the bot escalated → stays quiet until @-mentioned. In-memory (test bot).
const pausedThreads = new Set<string>();

function log(...args: unknown[]) {
	console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

function injectRoleMention(text: string): string {
	return text.replace(/@RocketRide\s+team/gi, ROLE_MENTION);
}

function extractFinalText(rawAnswer: string): string {
	const m = rawAnswer.match(/\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/);
	if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
	return rawAnswer;
}

// --- multi-modal parts ------------------------------------------------------
type Part = { modality: 'text' | 'image' | 'audio' | 'video'; name: string; mimetype: string; data: string | Uint8Array };

function modalityOf(contentType: string | null): Part['modality'] | null {
	const mime = (contentType ?? '').split(';')[0].trim();
	if (mime.startsWith('image/')) return 'image';
	if (mime.startsWith('audio/')) return 'audio';
	if (mime.startsWith('video/')) return 'video';
	return null;
}

const TEXT_FILE_EXTS = ['.pipe', '.json', '.yaml', '.yml', '.txt', '.log', '.md', '.csv', '.toml', '.ini', '.xml', '.js', '.ts', '.py', '.env.example'];
const TEXT_FILE_MAX_BYTES = 512 * 1024;
const TEXT_FILE_MAX_CHARS = 12_000;
function isTextFile(att: { name: string; contentType: string | null; size: number }): boolean {
	if (att.size > TEXT_FILE_MAX_BYTES) return false;
	const mime = (att.contentType ?? '').split(';')[0].trim();
	if (mime.startsWith('text/') || mime.includes('json') || mime.includes('yaml') || mime.includes('xml')) return true;
	return TEXT_FILE_EXTS.some((ext) => att.name.toLowerCase().endsWith(ext));
}

async function collectParts(msg: Message): Promise<Part[]> {
	const parts: Part[] = [];
	const textBits: string[] = [];
	const text = msg.content.trim();
	if (text) textBits.push(text);
	for (const att of msg.attachments.values()) {
		const modality = modalityOf(att.contentType);
		if (modality) {
			const res = await fetch(att.url);
			if (!res.ok) throw new Error(`download failed for ${att.name}: HTTP ${res.status}`);
			parts.push({ modality, name: `${msg.id}-${att.name}`, mimetype: (att.contentType ?? '').split(';')[0].trim(), data: new Uint8Array(await res.arrayBuffer()) });
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

// --- webhook call + response parsing ----------------------------------------
// The webhook returns { status, data: { objectsRequested, objectsCompleted, resultTypes,
// objects } }. On success the answer lives under an object whose resultType is "answers";
// on failure objects.body.status === "Error". We dig defensively (VERBOSE logs the raw envelope).
function deepFindAnswers(node: any, depth = 0): string[] | null {
	if (depth > 6 || node == null) return null;
	if (Array.isArray(node)) {
		if (node.length && node.every((x) => typeof x === 'string')) return node as string[];
		for (const v of node) { const r = deepFindAnswers(v, depth + 1); if (r) return r; }
		return null;
	}
	if (typeof node === 'object') {
		if (Array.isArray(node.answers) && node.answers.every((x: any) => typeof x === 'string')) return node.answers;
		for (const v of Object.values(node)) { const r = deepFindAnswers(v, depth + 1); if (r) return r; }
	}
	return null;
}

// POST one object to a webhook pipeline (the pk_ key selects which deployed pipeline);
// return the raw envelope.
async function postWebhook(key: string, mimetype: string, body: string | Uint8Array, label: string): Promise<any> {
	const url = `${WEBHOOK_URL}?auth=${encodeURIComponent(key)}`;
	const res = await fetch(url, { method: 'POST', headers: { authorization: key, 'content-type': mimetype }, body, signal: AbortSignal.timeout(180_000) });
	const raw = await res.text();
	if (VERBOSE) log(`  [${label}] webhook ${res.status}: ${raw.slice(0, 300)}`);
	if (!res.ok) throw new Error(`webhook HTTP ${res.status}: ${raw.slice(0, 200)}`);
	try { return JSON.parse(raw); } catch { return { data: { objects: { body: { answers: [raw.trim()] } } } }; }
}

// The task-response object (holds an `answers` array) inside a webhook envelope.
function resultBody(env: any): any {
	const data = env?.data ?? env;
	return data?.objects?.body ?? data?.objects ?? data ?? {};
}

// Extract the answer text from one task-response object; '' on error/empty.
function answerFromResult(result: any): string {
	if (result?.status === 'Error' || result?.error) return '';
	const found = deepFindAnswers(result);
	return found?.length ? extractFinalText(String(found.find((a) => a.trim()) ?? '')).trim() : '';
}

// Post one part to the ralph pipeline; return { modality, result } (result = raw task response).
async function askRalphPart(part: Part): Promise<{ modality: string; result: any }> {
	if (!WEBHOOK_KEY) throw new Error('SUPPORT_TEST_WEBHOOK_KEY not set');
	const env = await postWebhook(WEBHOOK_KEY, part.mimetype, part.data, part.modality);
	return { modality: part.modality, result: resultBody(env) };
}

// One result → reply directly. Multiple → merge via the cloud SUMMARISER pipeline (same
// {user_message, results} payload the local bot uses), matching the main bot's behaviour.
async function combine(results: Array<{ modality: string; result: any }>, userMessage: string): Promise<string> {
	if (results.length === 1) {
		log(`  single ${results[0].modality} result — replying directly, no summariser`);
		return injectRoleMention(answerFromResult(results[0].result) || 'Sorry — I could not process that.');
	}
	if (!SUMMARISER_KEY) {
		log('  !! SUPPORT_TEST_SUMMARISER_KEY not set — concatenating per-part answers');
		return injectRoleMention(results.map((r) => answerFromResult(r.result)).filter((a) => a.trim()).join('\n\n') || 'Sorry — I could not process that.');
	}
	log(`  ${results.length} results (${results.map((r) => r.modality).join('+')}) — merging via cloud summariser`);
	const env = await postWebhook(SUMMARISER_KEY, 'text/plain', JSON.stringify({ user_message: userMessage || undefined, results }), 'summariser');
	const found = deepFindAnswers(resultBody(env)) ?? [];
	for (const a of found) {
		try { const parsed = JSON.parse(a); if (parsed?.answer) { if (parsed.notes) log(`  synth notes: ${parsed.notes}`); return injectRoleMention(String(parsed.answer)); } } catch {}
	}
	// Summariser returned non-JSON (or nothing) → fall back to concatenation.
	return injectRoleMention(found.find((a) => a.trim()) || results.map((r) => answerFromResult(r.result)).filter((a) => a.trim()).join('\n\n') || 'Sorry — I could not process that.');
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
		await (thread as any).sendTyping?.().catch(() => {});
		const parts = await collectParts(msg);
		if (!parts.length) return;
		log(`  parts: ${parts.map((p) => p.modality).join(', ')}`);
		const results: Array<{ modality: string; result: any }> = [];
		for (const part of parts) {
			try { results.push(await askRalphPart(part)); }
			catch (err) { log(`  [${part.modality}] error: ${err instanceof Error ? err.message : err}`); results.push({ modality: part.modality, result: { error: { message: String(err) } } }); }
		}
		const reply = await combine(results, msg.content.trim());
		if (!reply.trim()) { log('  !! empty answer — not relayed'); return; }
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
	if (!WEBHOOK_KEY) throw new Error('Set SUPPORT_TEST_WEBHOOK_KEY in .env (the pk_ webhook key).');

	log(`webhook target: ${WEBHOOK_URL} (auth ${WEBHOOK_KEY.slice(0, 6)}…)`);
	const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

	discord.once(Events.ClientReady, (c) => {
		log(`bot online as ${c.user.tag} — test channel ${CHANNEL_ID} (webhook → cloud, multi-modal, replies in threads)`);
		log('waiting for messages... (Ctrl+C to stop)');
	});

	discord.on(Events.MessageCreate, async (msg: Message) => {
		if (msg.author.bot || msg.system) return;
		const text = msg.content.trim();
		if (!text && msg.attachments.size === 0) return; // nothing to act on
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

	const shutdown = async () => { log('shutting down...'); await discord.destroy(); process.exit(0); };
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await discord.login(BOT_TOKEN);
}

// `tsx support-test.ts --ask "question"` posts one text message to the webhook and prints
// the parsed result — for testing the cloud pipeline connection without Discord.
if (process.argv.includes('--ask')) {
	const q = process.argv[process.argv.indexOf('--ask') + 1] || 'ping';
	askRalphPart({ modality: 'text', name: `test-${Date.now()}-message.txt`, mimetype: 'text/plain', data: q })
		.then((r) => combine([r], q))
		.then((a) => console.log('\n--- answer ---\n' + a))
		.then(() => process.exit(0))
		.catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
} else {
	main().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
}
