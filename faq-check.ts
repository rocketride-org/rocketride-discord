import 'dotenv/config';
import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { RocketRideClient } from 'rocketride';

// faq-check.ts — verifies the FAQ builder is wired up correctly, WITHOUT running the
// agent or touching the real FAQ file. Run before starting faq.ts:
//   ./node_modules/.bin/tsx faq-check.ts

const PIPE = process.env.FAQ_PIPE || 'pipelines/faq-builder.pipe';
const STORE = process.env.FAQ_STORE_PATH || 'data/faqs.json';
const CHANNELS = (process.env.FAQ_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN = (process.env.FAQ_BOT_TOKEN || process.env.SCHEDULER_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || '').trim();

let failures = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => { console.log(`  ✗ ${m}`); failures++; };
const warn = (m: string) => console.log(`  ! ${m}`);

function detectEngineUri(): string {
	try {
		const out = execSync("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i engine | grep '127.0.0.1' | sed -E 's/.*:([0-9]+).*/\\1/' | head -1", { encoding: 'utf8', shell: '/bin/bash' }).trim();
		if (out) return `http://localhost:${out}`;
	} catch {}
	return process.env.ROCKETRIDE_URI ?? 'http://localhost:5565';
}

async function main() {
	console.log('\n1) Environment');
	CHANNELS.length ? ok(`FAQ_CHANNEL_IDS: ${CHANNELS.length} channel(s)`) : bad('FAQ_CHANNEL_IDS is empty');
	TOKEN ? ok('bot token present') : bad('no FAQ_BOT_TOKEN / SCHEDULER_BOT_TOKEN / DISCORD_BOT_TOKEN');
	process.env.ROCKETRIDE_OPENAI_KEY ? ok('ROCKETRIDE_OPENAI_KEY present (used by the agent LLM)') : bad('ROCKETRIDE_OPENAI_KEY missing');

	console.log('\n2) FAQ store path is writable');
	try {
		mkdirSync(dirname(STORE), { recursive: true });
		const probe = join(dirname(STORE), '.faq-write-probe');
		writeFileSync(probe, 'ok'); rmSync(probe);
		ok(`can write to ${dirname(STORE)}/ (FAQ file: ${STORE})`);
	} catch (e) { bad(`cannot write to ${dirname(STORE)}/: ${e instanceof Error ? e.message : e}`); }

	console.log('\n3) Pipeline validates against the engine');
	const uri = detectEngineUri();
	const rr = new RocketRideClient({ uri, auth: process.env.ROCKETRIDE_APIKEY });
	try {
		await rr.connect();
		ok(`connected to local engine at ${uri}`);
		const pipeline = JSON.parse(readFileSync(PIPE, 'utf8'));
		const res: any = await rr.validate({ pipeline });
		const errs = res?.errors ?? []; const warns = res?.warnings ?? [];
		errs.length ? bad(`pipeline ${PIPE} invalid: ${JSON.stringify(errs)}`) : ok(`pipeline ${PIPE} valid`);
		for (const w of warns) warn(`pipeline warning: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
	} catch (e) { bad(`engine/validate failed (is the RocketRide engine running?): ${e instanceof Error ? e.message : e}`); }
	finally { await rr.disconnect().catch(() => {}); }

	console.log('\n4) Bot can log in and see the channels');
	if (!TOKEN) { warn('skipped — no bot token'); }
	else {
		const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
		try {
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('login timed out after 20s')), 20_000);
				discord.once(Events.ClientReady, () => { clearTimeout(t); resolve(); });
				discord.login(TOKEN).catch(reject);
			});
			ok(`logged in as ${discord.user?.tag}`);
			for (const cid of CHANNELS) {
				const ch: any = await discord.channels.fetch(cid).catch(() => null);
				if (!ch) bad(`channel ${cid} not found (is the bot in that server / does it have access?)`);
				else if (!ch.isTextBased?.()) bad(`channel ${cid} (#${ch.name ?? '?'}) is not text-based`);
				else {
					const fetched = await ch.messages.fetch({ limit: 1 }).catch((e: any) => { bad(`channel ${cid} (#${ch.name}) fetch failed — grant Read Message History + enable the Message Content intent: ${e?.message ?? e}`); return null; });
					if (fetched) {
						const m = [...fetched.values()][0];
						if (m && !m.content && !m.author?.bot) warn(`#${ch.name}: message content is empty — enable the Message Content intent in the Discord dev portal`);
						else ok(`#${ch.name} readable`);
					}
				}
			}
		} catch (e) { bad(`login failed: ${e instanceof Error ? e.message : e}`); }
		finally { await discord.destroy().catch(() => {}); }
	}

	console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
