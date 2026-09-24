// eval/bench/score.ts — pure scoring. No I/O, no network, so it is unit-testable.
//
// What "accuracy" means here, in order of how much it should move a decision:
//   1. decision agreement — feed each model's signals through the REAL decideOutcome/decideCause
//      and compare the outcome/cause that would land in the scorecard. This is the only metric
//      that maps to a number the team actually reports.
//   2. schema validity — production drops an unparseable grade on the floor (`parse fail ... left
//      open`), so invalid JSON is a silent data loss, not a cosmetic flaw.
//   3. draft discipline — the prompt says draft a Q/A only when a team member supplied the answer.
//      The store knows whether a team reply exists, so this is checkable without any human labels.
//   4. per-field agreement + Cohen's kappa against a reference labeller.
//   5. self-consistency across repeats of the identical prompt.
//
// Agreement with the incumbent is NOT correctness: it measures "would this model reproduce what we
// run today". Only a human-labelled gold set can show a cheap model is *better*. Both are supported;
// the report says which one it used.
import { decideCause, decideOutcome, type Cause, type GraderSignals, type Outcome } from '../rules';
import type { GraderCase } from './tasks';

export interface ParsedGrade { obj: any | null; schemaOk: boolean; problems: string[] }

const ENUMS: Record<string, (string | null)[]> = {
	escalation_category: ['policy_public', 'policy_account', 'policy_other', 'knowledge', null],
	team_reply_kind: ['none', 'ack', 'correction', 'addition'],
	user_signal: ['confirmed', 'rejected', 'neutral'],
	llm_cause: ['product_defect', 'feature_request', null],
};

/** Same salvage strategy as eval/grader.ts — first {...} block, else the whole string. */
export function parseGrade(text: string): ParsedGrade {
	let obj: any = null;
	try { const m = text.match(/\{[\s\S]*\}/); obj = JSON.parse(m ? m[0] : text); }
	catch { return { obj: null, schemaOk: false, problems: ['unparseable JSON'] }; }
	if (!obj || typeof obj !== 'object') return { obj: null, schemaOk: false, problems: ['not a JSON object'] };

	const problems: string[] = [];
	for (const [field, allowed] of Object.entries(ENUMS)) {
		const v = obj[field] ?? null;
		if (!allowed.includes(v)) problems.push(`${field}=${JSON.stringify(v)}`);
	}
	if (!('cluster' in obj)) problems.push('cluster missing');
	if (!('qa_draft' in obj)) problems.push('qa_draft missing');
	if (obj.qa_draft != null && typeof obj.qa_draft?.answer !== 'string') problems.push('qa_draft.answer not a string');
	if (typeof obj.summary !== 'string') problems.push('summary missing');
	return { obj, schemaOk: problems.length === 0, problems };
}

export const signalsOf = (obj: any): GraderSignals => ({
	team_reply_kind: obj?.team_reply_kind,
	user_signal: obj?.user_signal,
	escalation_category: obj?.escalation_category ?? null,
	llm_cause: obj?.llm_cause ?? null,
});

/**
 * Run a model's signals through production's decision logic, holding the retrieval facts fixed
 * (retrieval is local miniLM — identical for every arm, so the LLM labels are the only variable).
 */
export function decisionFor(c: GraderCase, signals: GraderSignals, matchScore: number): { outcome: Outcome; cause: Cause | null } {
	const { outcome } = decideOutcome(c.thread, c.events, signals, { testAllowBotIds: [], testChannelIds: [] });
	const cause = decideCause(outcome, c.events, signals, { ...c.retrieval, matchScore });
	return { outcome, cause };
}

// --- statistics -------------------------------------------------------------------------------

type Pair = [string, string];
const key = (v: unknown) => (v === null || v === undefined ? '∅' : String(v));

export const agreement = (pairs: Pair[]): number =>
	pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : 0;

/**
 * Cohen's kappa — chance-corrected agreement. Needed because the outcome distribution is skewed
 * (~60% of graded threads land in two classes), so raw agreement of 0.7 can mean "always guesses
 * the majority class". <0 worse than chance, 0.6-0.8 substantial, >0.8 near-interchangeable.
 * Returns null when it is undefined (one rater used a single label for everything).
 */
export function cohenKappa(pairs: Pair[]): number | null {
	if (!pairs.length) return null;
	const labels = [...new Set(pairs.flat())];
	if (labels.length < 2) return null;
	const n = pairs.length;
	const po = agreement(pairs);
	let pe = 0;
	for (const l of labels) {
		const pa = pairs.filter(([a]) => a === l).length / n;
		const pb = pairs.filter(([, b]) => b === l).length / n;
		pe += pa * pb;
	}
	if (pe === 1) return null;
	return (po - pe) / (1 - pe);
}

/** Per-case majority label across models, excluding the model being scored (no self-voting). */
export function consensusLabel(labelsByModel: Map<string, string>, excludeModel: string): string | null {
	const counts = new Map<string, number>();
	for (const [model, label] of labelsByModel) {
		if (model === excludeModel) continue;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	let best: string | null = null, bestN = 0, tie = false;
	for (const [label, n] of counts) {
		if (n > bestN) { best = label; bestN = n; tie = false; }
		else if (n === bestN) tie = true;
	}
	return tie || bestN < 2 ? null : best;
}

// --- per-model aggregation --------------------------------------------------------------------

export interface CaseResult {
	caseId: string;
	ok: boolean;              // the HTTP call succeeded
	schemaOk: boolean;
	problems: string[];
	signals: GraderSignals | null;
	outcome: string | null;
	cause: string | null;
	draftGiven: boolean;
	draftExpected: boolean;
	ms: number;
	costUsd: number;
	inTokens: number;
	outTokens: number;
}

export interface ModelScore {
	model: string;
	n: number;
	callSuccessRate: number;
	schemaValidRate: number;
	outcomeAgreement: number | null;
	outcomeKappa: number | null;
	causeAgreement: number | null;
	fieldAgreement: Record<string, number>;
	draftDisciplineRate: number;
	draftMissed: number;      // team answered, no draft produced → a KB entry we never get
	draftInvented: number;    // nobody answered, drafted anyway → risks writing fiction into the KB
	selfConsistency: number | null;
	msP50: number;
	msP95: number;
	costPerCall: number;
	costPer1k: number;
}

const pct = (hit: number, n: number) => (n ? hit / n : 0);
const quantile = (xs: number[], q: number) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/**
 * Score one model's run.
 * `reference` maps caseId -> {outcome, cause, fields} from whichever labeller is acting as truth
 * (gold when present, otherwise the incumbent). Cases with no reference are skipped for the
 * agreement metrics but still count for validity, latency and cost.
 */
export function scoreModel(
	model: string,
	results: CaseResult[],
	reference: Map<string, { outcome: string | null; cause: string | null; fields: Record<string, unknown> }>,
	repeats?: Map<string, string[]>,
): ModelScore {
	const n = results.length;
	const usable = results.filter((r) => r.ok && r.schemaOk && r.signals);

	const outcomePairs: Pair[] = [];
	const causePairs: Pair[] = [];
	const fieldPairs: Record<string, Pair[]> = { team_reply_kind: [], user_signal: [], escalation_category: [], llm_cause: [] };
	for (const r of usable) {
		const ref = reference.get(r.caseId);
		if (!ref) continue;
		outcomePairs.push([key(r.outcome), key(ref.outcome)]);
		if (ref.cause !== undefined) causePairs.push([key(r.cause), key(ref.cause)]);
		for (const f of Object.keys(fieldPairs)) {
			if (ref.fields[f] === undefined) continue;
			fieldPairs[f].push([key((r.signals as any)[f]), key(ref.fields[f])]);
		}
	}

	const fieldAgreement: Record<string, number> = {};
	for (const [f, pairs] of Object.entries(fieldPairs)) if (pairs.length) fieldAgreement[f] = agreement(pairs);

	const draftJudged = usable.length;
	const draftMissed = usable.filter((r) => r.draftExpected && !r.draftGiven).length;
	const draftInvented = usable.filter((r) => !r.draftExpected && r.draftGiven).length;

	let selfConsistency: number | null = null;
	if (repeats?.size) {
		const stable = [...repeats.values()].filter((labels) => labels.length > 1 && new Set(labels).size === 1).length;
		const judged = [...repeats.values()].filter((labels) => labels.length > 1).length;
		selfConsistency = judged ? stable / judged : null;
	}

	const latencies = results.filter((r) => r.ok).map((r) => r.ms);
	const cost = results.reduce((s, r) => s + r.costUsd, 0);
	return {
		model,
		n,
		callSuccessRate: pct(results.filter((r) => r.ok).length, n),
		schemaValidRate: pct(results.filter((r) => r.ok && r.schemaOk).length, results.filter((r) => r.ok).length),
		outcomeAgreement: outcomePairs.length ? agreement(outcomePairs) : null,
		outcomeKappa: cohenKappa(outcomePairs),
		causeAgreement: causePairs.length ? agreement(causePairs) : null,
		fieldAgreement,
		draftDisciplineRate: pct(draftJudged - draftMissed - draftInvented, draftJudged),
		draftMissed,
		draftInvented,
		selfConsistency,
		msP50: quantile(latencies, 0.5),
		msP95: quantile(latencies, 0.95),
		costPerCall: n ? cost / n : 0,
		costPer1k: n ? (cost / n) * 1000 : 0,
	};
}
