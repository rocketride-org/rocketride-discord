// eval/bench/runner.ts — runs the model × case × repeat matrix and writes results to disk.
// Every call is priced as it happens, so a run that dies half way still tells you what it spent.
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, type ModelEntry } from './config';
import { callModel } from './providers';
import { costOf } from './cost';
import { decisionFor, parseGrade, scoreModel, signalsOf, consensusLabel, type CaseResult, type ModelScore } from './score';
import type { GraderCase } from './tasks';

type Log = (...a: unknown[]) => void;

export interface RunOptions {
	models: ModelEntry[];
	cases: GraderCase[];
	systemPrompt: string;
	repeats: number;
	maxTokens: number;
	log: Log;
	outDir?: string;
	goldPath?: string;
}

export interface RunSummary {
	runId: string;
	startedAt: string;
	finishedAt: string;
	task: 'grader';
	nCases: number;
	repeats: number;
	referenceKind: 'gold' | 'incumbent';
	goldN: number;
	spendUsd: number;
	scores: ModelScore[];
	consensusScores: ModelScore[];
	dir: string;
}

/** Bounded-concurrency map that keeps going after an individual failure. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

export interface GoldRow { threadId: string; outcome?: string | null; cause?: string | null; [field: string]: unknown }

export function loadGold(path: string): Map<string, GoldRow> {
	const m = new Map<string, GoldRow>();
	if (!existsSync(path)) return m;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const t = line.trim();
		if (!t || t.startsWith('#')) continue;
		try { const row = JSON.parse(t) as GoldRow; if (row.threadId) m.set(row.threadId, row); } catch { /* skip malformed line */ }
	}
	return m;
}

export async function runGraderBench(opts: RunOptions): Promise<RunSummary> {
	const { models, cases, systemPrompt, repeats, maxTokens, log } = opts;
	const runId = new Date().toISOString().replace(/[:.]/g, '-');
	const dir = join(opts.outDir ?? bench.outDir, runId);
	mkdirSync(dir, { recursive: true });
	const jsonl = join(dir, 'results.jsonl');
	const startedAt = new Date().toISOString();

	const tasks = models.flatMap((m) => cases.flatMap((c) => Array.from({ length: repeats }, (_, r) => ({ m, c, r }))));
	log(`run ${runId}: ${models.length} model(s) × ${cases.length} case(s) × ${repeats} repeat(s) = ${tasks.length} call(s)`);

	const byModel = new Map<string, CaseResult[]>();
	const repeatLabels = new Map<string, Map<string, string[]>>(); // model -> caseId -> outcomes
	let done = 0, spend = 0;

	await pool(tasks, bench.concurrency, async ({ m, c, r }) => {
		const res = await callModel(m, { system: systemPrompt, user: c.input, maxTokens }, { timeoutMs: bench.timeoutMs, maxRetries: bench.maxRetries });
		const parsed = res.ok ? parseGrade(res.text) : { obj: null, schemaOk: false, problems: [res.error ?? 'call failed'] };
		const signals = parsed.obj ? signalsOf(parsed.obj) : null;
		const decision = signals ? decisionFor(c, signals, bench.matchScore) : null;
		const cost = costOf(m, res.usage).total;
		spend += cost;

		const row: CaseResult = {
			caseId: c.threadId,
			ok: res.ok,
			schemaOk: parsed.schemaOk,
			problems: parsed.problems,
			signals,
			outcome: decision?.outcome ?? null,
			cause: decision?.cause ?? null,
			draftGiven: !!parsed.obj?.qa_draft?.answer,
			draftExpected: c.retrieval.teamAnswerExists,
			ms: res.ms,
			costUsd: cost,
			inTokens: res.usage.inTokens + res.usage.cachedInTokens,
			outTokens: res.usage.outTokens,
		};

		appendFileSync(jsonl, JSON.stringify({ model: m.key, repeat: r, ...row, raw: res.text.slice(0, 4000) }) + '\n');
		if (r === 0) (byModel.get(m.key) ?? byModel.set(m.key, []).get(m.key)!).push(row);
		const perModel = repeatLabels.get(m.key) ?? repeatLabels.set(m.key, new Map()).get(m.key)!;
		(perModel.get(c.threadId) ?? perModel.set(c.threadId, []).get(c.threadId)!).push(`${row.outcome}|${row.cause}`);

		done++;
		if (done % 10 === 0 || done === tasks.length) log(`  ${done}/${tasks.length} calls · spent ${spend.toFixed(4)} USD`);
		if (!res.ok) log(`  ! ${m.key} ${c.threadId}: ${res.error}`);
	});

	// --- reference labels -----------------------------------------------------------------------
	const gold = loadGold(opts.goldPath ?? bench.goldPath);
	const goldHits = cases.filter((c) => gold.has(c.threadId)).length;
	const referenceKind: 'gold' | 'incumbent' = goldHits >= Math.max(10, cases.length * 0.5) ? 'gold' : 'incumbent';

	const reference = new Map<string, { outcome: string | null; cause: string | null; fields: Record<string, unknown> }>();
	for (const c of cases) {
		const g = gold.get(c.threadId);
		if (referenceKind === 'gold' && g) {
			reference.set(c.threadId, {
				outcome: g.outcome ?? null,
				cause: g.cause ?? null,
				fields: { team_reply_kind: g.team_reply_kind, user_signal: g.user_signal, escalation_category: g.escalation_category, llm_cause: g.llm_cause },
			});
		} else if (referenceKind === 'incumbent' && c.reference) {
			reference.set(c.threadId, {
				outcome: c.refOutcome,
				cause: c.refCause,
				fields: {
					team_reply_kind: c.reference.team_reply_kind,
					user_signal: c.reference.user_signal,
					escalation_category: c.reference.escalation_category ?? null,
					llm_cause: c.reference.llm_cause ?? null,
				},
			});
		}
	}

	// --- panel consensus (leave-one-out majority across the arms that ran) ----------------------
	const consensusFor = (excludeModel: string) => {
		const ref = new Map<string, { outcome: string | null; cause: string | null; fields: Record<string, unknown> }>();
		for (const c of cases) {
			const votes = new Map<string, string>();
			for (const [model, rows] of byModel) {
				const row = rows.find((x) => x.caseId === c.threadId);
				if (row?.outcome) votes.set(model, row.outcome);
			}
			const label = consensusLabel(votes, excludeModel);
			if (label) ref.set(c.threadId, { outcome: label, cause: null, fields: {} });
		}
		return ref;
	};

	const scores = [...byModel].map(([model, rows]) => scoreModel(model, rows, reference, repeatLabels.get(model)));
	const consensusScores = [...byModel].map(([model, rows]) => scoreModel(model, rows, consensusFor(model)));

	const summary: RunSummary = {
		runId,
		startedAt,
		finishedAt: new Date().toISOString(),
		task: 'grader',
		nCases: cases.length,
		repeats,
		referenceKind,
		goldN: goldHits,
		spendUsd: spend,
		scores,
		consensusScores,
		dir,
	};
	writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...summary, models: models.map((m) => ({ key: m.key, id: m.id, label: m.label, price: m.price })), caseIds: cases.map((c) => c.threadId) }, null, 2));
	log(`run complete — ${spend.toFixed(4)} USD spent · results in ${dir}`);
	return summary;
}
