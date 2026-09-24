// eval/bench/main.ts — CLI for the eval model bake-off. Run from the repo root.
//
//   tsx eval/bench/main.ts --list                   list the catalog + which keys are present
//   tsx eval/bench/main.ts --estimate               cost per call / month for every model — NO KEYS NEEDED
//   tsx eval/bench/main.ts --verify-models          check every catalog id against the provider's /models
//   tsx eval/bench/main.ts --run --models a,b --n 30 --yes    the actual bake-off (spends money)
//   tsx eval/bench/main.ts --report [--run <dir>]   re-render the last run as markdown + HTML
//   tsx eval/bench/main.ts --gold-template --n 40   seed a human-labelling file for real accuracy
//
// Nothing here writes to the production eval store, the pipes, or the running bots.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, keyEnvNames, keyFor, loadCatalog, selectable, type ModelEntry } from './config';
import { listModelIds } from './providers';
import { project, shapeGraderWorkload, usd, type Projection } from './cost';
import { loadGraderCases, loadPipePrompt, monthlyGraderVolume } from './tasks';
import { runGraderBench, type RunSummary } from './runner';
import { estimateMarkdown, html, runMarkdown } from './report';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const numArg = (f: string, d: number) => { const v = Number(val(f)); return Number.isFinite(v) ? v : d; };
const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

const catalog = () => loadCatalog();
const pick = (): ModelEntry[] => {
	const all = selectable(catalog());
	const wanted = val('--models');
	if (!wanted) return all;
	const keys = wanted.split(',').map((s) => s.trim()).filter(Boolean);
	const out: ModelEntry[] = [];
	for (const k of keys) {
		const m = all.find((x) => x.key === k);
		if (!m) throw new Error(`unknown model '${k}' — see --list`);
		out.push(m);
	}
	return out;
};

function cmdModels() {
	const c = catalog();
	console.log(`catalog ${bench.catalogPath} · prices as of ${c.asof} (USD per 1M tokens)\n`);
	console.log(['key', 'role', 'in', 'out', 'batch', 'key set?', 'id'].join('\t'));
	for (const m of c.models) {
		console.log([m.key, m.role, m.price.in, m.price.out, m.batchDiscount ? `-${m.batchDiscount * 100}%` : '—', keyFor(m) ? 'yes' : `no (${keyEnvNames(m).join(' | ')})`, m.id].join('\t'));
	}
	console.log('\nAdd a model by appending an entry to the catalog — no code change needed.');
}

function workload(windowDays: number, n?: number) {
	const c = catalog();
	const charsPerToken = numArg('--chars-per-token', c.defaults.charsPerToken);
	const systemPrompt = loadPipePrompt(bench.graderPipe);
	const cases = loadGraderCases({ n, windowDays: windowDays || undefined });
	const all = loadGraderCases({});
	const shape = shapeGraderWorkload(all, systemPrompt, charsPerToken);
	return { c, systemPrompt, cases, shape, charsPerToken };
}

function cmdEstimate() {
	const windowDays = numArg('--window', 0); // 0 = whole history
	const { c, shape } = workload(windowDays);
	const volume = monthlyGraderVolume(numArg('--window', bench.windowDays));
	const callsPerMonth = numArg('--volume', Math.round(volume.perMonth));
	const incumbent = selectable(c).find((m) => m.role === 'incumbent');
	const incumbentPerCall = incumbent ? project(incumbent, shape, callsPerMonth).perCall : undefined;
	const projections = selectable(c)
		.map((m) => project(m, shape, callsPerMonth, incumbentPerCall))
		.sort((a, b) => a.perCall - b.perCall);

	const md = estimateMarkdown({ shape, projections, volume: { ...volume, perMonth: callsPerMonth }, windowDays, asof: c.asof });
	console.log('\n' + md);
	console.log('Replay/judge calls are excluded — the golden set is empty, so that job costs $0 today.');
	console.log('Retrieval (eval-retrieve.pipe) is local miniLM: no API cost at any volume.\n');
	return { md, projections, shape, volume, callsPerMonth, catalog: c };
}

async function cmdVerifyModels() {
	const models = pick();
	log(`checking ${models.length} catalog id(s) against each provider's /models endpoint`);
	const seen = new Map<string, { ok: boolean; ids?: string[]; error?: string }>();
	for (const m of models) {
		const cacheKey = `${m.api.baseUrl}|${keyEnvNames(m).join(',')}`;
		if (!seen.has(cacheKey)) seen.set(cacheKey, await listModelIds(m, bench.timeoutMs));
		const r = seen.get(cacheKey)!;
		if (!r.ok) { console.log(`  ?  ${m.key.padEnd(22)} ${r.error}`); continue; }
		const hit = r.ids?.includes(m.id);
		const near = hit ? '' : ` — closest: ${(r.ids ?? []).filter((id) => id.includes(m.id.split(/[./]/).pop()!.slice(0, 4))).slice(0, 4).join(', ') || '(no obvious match)'}`;
		console.log(`  ${hit ? 'OK ' : 'XX '} ${m.key.padEnd(22)} ${m.id}${near}`);
	}
	console.log('\nXX = the id in pricing.json is not served by that provider. Fix the id before --run.');
}

async function cmdRun() {
	const models = pick();
	const n = numArg('--n', 30);
	const repeats = numArg('--repeats', 1);
	const windowDays = numArg('--window', 0);
	const { c, systemPrompt, cases, shape } = workload(windowDays, n);
	if (!cases.length) throw new Error('no gradable cases in the store');

	const missing = models.filter((m) => !keyFor(m));
	if (missing.length) throw new Error(`missing API keys: ${[...new Set(missing.flatMap(keyEnvNames))].join(', ')}`);

	const maxTokens = numArg('--max-tokens', c.defaults.maxTokens);
	const perModel = models.map((m) => ({ m, p: project(m, shape, cases.length * repeats) }));
	const est = perModel.reduce((s, x) => s + x.p.perMonth, 0);
	console.log(`\nAbout to run ${models.length} model(s) × ${cases.length} case(s) × ${repeats} repeat(s) = ${models.length * cases.length * repeats} calls`);
	for (const { m, p } of perModel) console.log(`  ${m.key.padEnd(22)} ~${usd(p.perMonth)}`);
	console.log(`  ${'TOTAL'.padEnd(22)} ~${usd(est)} (estimate)\n`);
	if (!has('--yes')) { console.log('Add --yes to run it.'); return; }

	const summary = await runGraderBench({ models, cases, systemPrompt, repeats, maxTokens, log });
	renderRun(summary, shape);
}

function latestRunDir(): string {
	const dirs = readdirSync(bench.outDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
	if (!dirs.length) throw new Error(`no runs under ${bench.outDir}`);
	return join(bench.outDir, dirs[dirs.length - 1]);
}

function renderRun(summary: RunSummary, shape?: ReturnType<typeof shapeGraderWorkload>) {
	const c = catalog();
	const entries = new Map(c.models.map((m) => [m.key, m]));
	const volume = monthlyGraderVolume(bench.windowDays);
	const callsPerMonth = Math.round(volume.perMonth);
	const projections = new Map<string, Projection>();
	for (const s of summary.scores) {
		const m = entries.get(s.model);
		if (m && shape) projections.set(s.model, project(m, shape, callsPerMonth));
		else if (m) projections.set(s.model, { model: s.model, label: m.label, perCall: s.costPerCall, perCallBatch: s.costPerCall, perMonth: s.costPerCall * callsPerMonth, perMonthBatch: 0, perYear: s.costPerCall * callsPerMonth * 12, callsPerMonth, vsIncumbentPct: null });
	}
	const md = runMarkdown(summary, projections, entries);
	console.log('\n' + md);

	const pctS = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
	const page = html(`Eval grader bake-off — ${summary.runId}`, [
		{
			heading: 'Accuracy',
			intro: `${summary.nCases} cases · reference = ${summary.referenceKind}${summary.referenceKind === 'incumbent' ? ' (GPT-5.4 — agreement, not correctness)' : ''}`,
			head: ['Model', 'Calls ok', 'JSON valid', 'Outcome agree', 'κ', 'Draft discipline'],
			rows: summary.scores.map((s) => [entries.get(s.model)?.label ?? s.model, pctS(s.callSuccessRate), pctS(s.schemaValidRate), pctS(s.outcomeAgreement), s.outcomeKappa === null ? '—' : s.outcomeKappa.toFixed(2), pctS(s.draftDisciplineRate)]),
		},
		{
			heading: 'Cost & latency (measured)',
			head: ['Model', '$/call', '$/1k calls', `Projected $/month (${callsPerMonth} calls)`, 'p50', 'p95'],
			rows: summary.scores.map((s) => [entries.get(s.model)?.label ?? s.model, usd(s.costPerCall), usd(s.costPer1k), usd(s.costPerCall * callsPerMonth), `${Math.round(s.msP50)}ms`, `${Math.round(s.msP95)}ms`]),
		},
	], `Run ${summary.runId} · spent ${usd(summary.spendUsd)} · prices as of ${c.asof}`);

	const out = join(summary.dir, 'report.html');
	writeFileSync(out, page);
	writeFileSync(join(summary.dir, 'report.md'), md);
	log(`report written: ${out}`);
}

function cmdReport() {
	const dir = val('--run') ? (val('--run') as string) : latestRunDir();
	const summary = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunSummary;
	renderRun({ ...summary, dir });
}

function cmdGoldTemplate() {
	const n = numArg('--n', 40);
	const cases = loadGraderCases({ n });
	mkdirSync(bench.outDir, { recursive: true });
	const out = join(bench.outDir, 'gold.template.jsonl');
	const lines = cases.map((c) => JSON.stringify({
		threadId: c.threadId,
		_question: c.question.slice(0, 300),
		_incumbent: { outcome: c.refOutcome, cause: c.refCause },
		outcome: c.refOutcome,
		cause: c.refCause,
		team_reply_kind: c.reference?.team_reply_kind ?? null,
		user_signal: c.reference?.user_signal ?? null,
		escalation_category: c.reference?.escalation_category ?? null,
		llm_cause: c.reference?.llm_cause ?? null,
	}));
	writeFileSync(out, lines.join('\n') + '\n');
	console.log(`wrote ${lines.length} rows → ${out}`);
	console.log(`Pre-filled with the incumbent's labels. Correct them by hand, drop rows you are unsure about,`);
	console.log(`then save as ${bench.goldPath}. Once ≥10 rows (and ≥50% of the sampled cases) are gold,`);
	console.log(`--run scores every arm against YOUR labels instead of against GPT-5.4.`);
}

async function main() {
	// Commands first: `--models a,b` is also the model SELECTOR, so it only means "list the
	// catalog" when no other command flag is present.
	if (has('--estimate')) return void cmdEstimate();
	if (has('--verify-models')) return await cmdVerifyModels();
	if (has('--run')) return await cmdRun();
	if (has('--report')) return cmdReport();
	if (has('--gold-template')) return cmdGoldTemplate();
	if (has('--list') || has('--models')) return cmdModels();
	console.log(`usage: tsx eval/bench/main.ts
  --list                                    list catalog + key presence
  --estimate [--window D] [--volume N]      cost per call/month, no API keys needed
  --verify-models [--models a,b]            check catalog ids against each provider
  --run --models a,b [--n 30] [--repeats 1] [--max-tokens N] --yes
  --report [--run <dir>]                    re-render a finished run
  --gold-template [--n 40]                  seed human labels for real accuracy`);
}

main().catch((e) => { console.error('FATAL', e instanceof Error ? e.stack : e); process.exit(1); });
