// eval/main.ts — process entry + CLI for the Rocket Ralph eval system.
// Phase 2 commands:
//   tsx eval/main.ts --backfill [--since YYYY-MM-DD] [--dry]
//   tsx eval/main.ts --report   [--window 28|all]
// (Phase 3+ add scheduled grading / review / replay here.)

import { Client, GatewayIntentBits, Events, type Interaction } from 'discord.js';
import { DateTime } from 'luxon';
import { config } from './config';
import { Store } from './store';
import { backfill } from './backfill';
import { gradeOnce } from './grader';
import { postWeeklySummary, enqueueReviewCards, handleInteraction } from './review';
import { replay } from './replay';
import { ingestApproved } from './ingest';
import { writeFileSync } from 'node:fs';
import { wilson, roundInterval, isFailure, type Outcome } from './rules';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + '%' : '—');

async function runBackfill() {
	if (!config.botToken) throw new Error('EVAL_BOT_TOKEN not set');
	if (!config.ralphBotId) throw new Error('EVAL_RALPH_BOT_ID not set');
	const dry = has('--dry');
	const since = val('--since');
	const sinceMs = since ? Date.parse(since) : undefined;
	const store = dry ? null : new Store(config.dbPath);
	const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
	await new Promise<void>((resolve, reject) => {
		client.once(Events.ClientReady, async (c) => {
			try {
				log(`backfill as ${c.user.tag}${dry ? ' (dry run)' : ''}${sinceMs ? ` since ${since}` : ''}`);
				// dry run still needs a store object for the API; use in-memory
				await backfill(client, store ?? new Store(':memory:'), { dry, sinceMs, log });
				resolve();
			} catch (e) { reject(e); }
		});
		client.login(config.botToken).catch(reject);
	});
	store?.close();
	await client.destroy();
}

function runReport() {
	const window = val('--window') || 'all';
	const store = new Store(config.dbPath);
	const threads = store.getThreads();
	const events = store.getEvents();
	store.close();

	const now = Date.now();
	const cutoff = window === 'all' ? 0 : now - Number(window || 28) * 86400_000;
	const inWindow = threads.filter((t) => t.created_at >= cutoff);

	// per-thread event-type set
	const typesByThread = new Map<string, Set<string>>();
	for (const e of events) { (typesByThread.get(e.thread_id) ?? typesByThread.set(e.thread_id, new Set()).get(e.thread_id)!).add(e.type); }
	const has = (id: string, t: string) => typesByThread.get(id)?.has(t) ?? false;

	const excluded = { internal: 0, test: 0, manipulation: 0 } as Record<string, number>;
	const decidable: any[] = [];
	for (const t of inWindow) {
		if (t.excluded_reason) { excluded[t.excluded_reason] = (excluded[t.excluded_reason] ?? 0) + 1; }
		else decidable.push(t);
	}
	const D = decidable.length;
	const withEsc = decidable.filter((t) => has(t.thread_id, 'escalation')).length;
	const withDead = decidable.filter((t) => has(t.thread_id, 'dead_end')).length;
	const withNo = decidable.filter((t) => has(t.thread_id, 'no_reply')).length;
	const withTeam = decidable.filter((t) => has(t.thread_id, 'team_reply')).length;
	const withAnySignal = decidable.filter((t) => ['escalation', 'dead_end', 'no_reply', 'team_reply'].some((x) => has(t.thread_id, x))).length;
	const upperOk = D - withAnySignal;

	// threads per week
	const times = inWindow.map((t) => t.created_at).sort((a, b) => a - b);
	const weeks = times.length ? Math.max(1, (times[times.length - 1] - times[0]) / (7 * 86400_000)) : 1;

	console.log(`\n===== Ralph eval baseline report (window: ${window}) =====`);
	console.log(`threads:            ${inWindow.length}  (${(inWindow.length / weeks).toFixed(1)}/week over ${weeks.toFixed(1)} weeks)`);
	console.log(`excluded:           internal ${excluded.internal ?? 0} · test ${excluded.test ?? 0} · manipulation ${excluded.manipulation ?? 0}`);
	console.log(`decidable:          ${D}`);
	console.log(`escalation rate:    ${withEsc}/${D}  (${pct(withEsc, D)})`);
	console.log(`dead-end rate:      ${withDead}/${D}  (${pct(withDead, D)})`);
	console.log(`no-reply rate:      ${withNo}/${D}  (${pct(withNo, D)})`);
	console.log(`team-involvement:   ${withTeam}/${D}  (${pct(withTeam, D)})`);
	console.log(`--`);
	const iv = roundInterval(wilson(upperOk, D));
	console.log(`UPPER BOUND success (no escalation/team/dead-end/no-reply): ${upperOk}/${D} = ${pct(upperOk, D)}`);
	console.log(`  95% Wilson interval: ${iv ? `[${(iv[0] * 100).toFixed(1)}%, ${(iv[1] * 100).toFixed(1)}%]` : 'n/a'}`);

	// graded section (Phase 3), if any threads have been graded
	const graded = inWindow.filter((t) => t.status === 'graded' && t.outcome && t.outcome !== 'excluded');
	if (graded.length) {
		const oc: Record<string, number> = {}, cc: Record<string, number> = {};
		for (const t of graded) { oc[t.outcome] = (oc[t.outcome] ?? 0) + 1; if (t.cause) cc[t.cause] = (cc[t.cause] ?? 0) + 1; }
		const confirmed = graded.filter((t) => t.outcome === 'resolved_confirmed').length;
		const failures = graded.filter((t) => isFailure(t.outcome as Outcome)).length;
		const pending = graded.filter((t) => t.outcome === 'resolved_unconfirmed').length;
		const denom = confirmed + failures;
		const giv = roundInterval(wilson(confirmed, denom));
		console.log(`\n----- GRADED (Phase 3): ${graded.length} threads -----`);
		console.log(`outcomes:   ${Object.entries(oc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
		console.log(`causes:     ${Object.entries(cc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || '(none)'}`);
		console.log(`DOC GAPS (content_gap): ${cc.content_gap ?? 0}`);
		console.log(`confirmed-success rate: ${confirmed}/${denom} = ${pct(confirmed, denom)}  (pending/unconfirmed: ${pending}, left out until reviewed)`);
		console.log(`  95% Wilson: ${giv ? `[${(giv[0] * 100).toFixed(1)}%, ${(giv[1] * 100).toFixed(1)}%]` : 'n/a'}  ·  target ${(config.target * 100).toFixed(0)}% (aspirational ${(config.targetAspirational * 100).toFixed(0)}%)`);
	} else {
		console.log(`\n(No graded threads yet — run: tsx eval/main.ts --grade-once. Upper bound is the ceiling; true resolution will be lower.)`);
	}
}

async function runGrade() {
	const store = new Store(config.dbPath);
	const limit = val('--limit') ? Number(val('--limit')) : undefined;
	await gradeOnce(store, { limit, log });
	store.close();
}

/** Log in the eval bot, run fn, then destroy. */
async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
	const client = new Client({ intents: [GatewayIntentBits.Guilds] });
	const ready = new Promise<Client>((res) => client.once(Events.ClientReady, res));
	await client.login(config.botToken);
	await ready;
	try { return await fn(client); } finally { await client.destroy(); }
}

// Fire fn once per day at hour:00 (EVAL_TZ); weekday 1=Mon..7=Sun, or omit for daily.
function scheduleDaily(hour: number, weekday: number | null, fn: () => void): void {
	let lastKey = '';
	setInterval(() => {
		const dt = DateTime.now().setZone(config.tz);
		if (dt.hour !== hour || dt.minute !== 0) return;
		if (weekday && dt.weekday !== weekday) return;
		const key = dt.toFormat('yyyy-LL-dd-HH');
		if (key === lastKey) return; lastKey = key;
		try { fn(); } catch (e) { log('!! schedule error', e instanceof Error ? e.message : e); }
	}, 60_000);
}

async function runServe() {
	const store = new Store(config.dbPath);
	const client = new Client({ intents: [GatewayIntentBits.Guilds] });
	client.once(Events.ClientReady, (c) => {
		log(`eval bot online as ${c.user.tag} — review channel ${config.reviewChannelId}`);
		scheduleDaily(config.gradeHour, null, async () => { log('nightly grade'); await gradeOnce(store, { log }); await enqueueReviewCards(client, store, log); });
		scheduleDaily(9, 1, () => { log('weekly summary'); postWeeklySummary(client, store, log); }); // Mon 09:00
	});
	client.on(Events.InteractionCreate, (i: Interaction) => { handleInteraction(i, store).catch((e) => log('!! interaction', e instanceof Error ? e.message : e)); });
	await client.login(config.botToken);
	log('serving (Ctrl+C to stop)…');
}

function goldenFromThread() {
	const store = new Store(config.dbPath);
	const tid = val('--golden-from-thread')!;
	const expected = (val('--expect') as 'answer' | 'escalate') || 'escalate';
	const t = store.getThreadFull(tid);
	if (!t) { log('thread not found in store:', tid); store.close(); return; }
	store.createGoldenCase({ question: t.question, expected, golden_answer: expected === 'answer' ? (val('--answer') ?? null) : null, source: 'guardrail', thread_id: tid });
	log(`golden case added from ${tid} (expect ${expected})`);
	store.close();
}
function goldenAdd() {
	const store = new Store(config.dbPath);
	const q = val('--question'); const expected = (val('--expect') as 'answer' | 'escalate') || 'answer';
	if (!q) { log('need --question'); store.close(); return; }
	store.createGoldenCase({ question: q, expected, golden_answer: expected === 'answer' ? (val('--answer') ?? '') : null, source: 'manual' });
	log('manual golden case added'); store.close();
}
function exportGolden() {
	const store = new Store(config.dbPath);
	const rows = store.getActiveGolden();
	writeFileSync('data/golden.jsonl', rows.map((r) => JSON.stringify({ id: r.id, question: r.question, expected: r.expected, golden_answer: r.golden_answer, source: r.source })).join('\n') + '\n');
	log(`exported ${rows.length} golden cases → data/golden.jsonl`); store.close();
}

async function main() {
	if (has('--backfill')) return void (await runBackfill());
	if (has('--grade-once')) return void (await runGrade());
	if (has('--report')) return void runReport();
	if (has('--summary-once')) return void (await withClient((c) => postWeeklySummary(c, new Store(config.dbPath), log)));
	if (has('--review-once')) return void (await withClient((c) => enqueueReviewCards(c, new Store(config.dbPath), log)));
	if (has('--replay')) { const s = new Store(config.dbPath); await replay(s, { limit: val('--limit') ? Number(val('--limit')) : undefined, log }); s.close(); return; }
	if (has('--ingest-approved')) { const s = new Store(config.dbPath); await ingestApproved(s, { log }); s.close(); return; }
	if (has('--golden-from-thread')) return void goldenFromThread();
	if (has('--golden-add')) return void goldenAdd();
	if (has('--export-golden')) return void exportGolden();
	if (has('--serve')) { await runServe(); return new Promise<void>(() => {}); } // stay online
	console.log('usage: tsx eval/main.ts --backfill | --grade-once [--limit N] | --report [--window 28|all] |\n  --summary-once | --review-once | --replay [--limit N] | --ingest-approved |\n  --golden-from-thread <id> --expect escalate|answer | --golden-add --question .. --expect .. [--answer ..] | --export-golden | --serve');
}
main().then((v) => { if (v !== undefined || !has('--serve')) process.exit(0); }).catch((e) => { console.error('FATAL', e instanceof Error ? e.stack : e); process.exit(1); });
