// eval/bench/cost.ts — token accounting and the money question.
//
// Two modes:
//   · estimate — no API keys, no calls. Prompt sizes come from the real store, output sizes from
//     the incumbent's stored grades. Good to ±15%: enough to decide whether cost matters at all.
//   · measured — real usage counts returned by each provider during --run.
import type { ModelEntry } from './config';
import type { LlmUsage } from './providers';
import type { GraderCase } from './tasks';

export interface CostBreakdown { input: number; output: number; total: number }

/** Heuristic only. JSON-wrapped English runs ~3.9 chars/token; the bench prints measured tokens once a run happens. */
export const estimateTokens = (text: string, charsPerToken: number): number => Math.ceil(text.length / charsPerToken);

export function costOf(m: ModelEntry, usage: Pick<LlmUsage, 'inTokens' | 'outTokens' | 'cachedInTokens'>, batch = false): CostBreakdown {
	const mult = batch ? 1 - (m.batchDiscount ?? 0) : 1;
	const cacheRate = m.price.cacheRead ?? m.price.in;
	const input = ((usage.inTokens * m.price.in) + (usage.cachedInTokens * cacheRate)) / 1e6 * mult;
	const output = (usage.outTokens * m.price.out) / 1e6 * mult;
	return { input, output, total: input + output };
}

export interface WorkloadShape {
	n: number;
	inTokensMean: number;
	inTokensP90: number;
	outTokensMean: number;
	/** Chars per token used for the estimate. */
	charsPerToken: number;
	outSource: 'measured-incumbent' | 'default';
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quantile = (xs: number[], q: number) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/**
 * Size the grader workload from real data: input from the exact prompts production sends, output
 * from the JSON the incumbent grader actually returned (stored in threads.grader_json, minus the
 * two fields the eval adds after the fact).
 */
export function shapeGraderWorkload(cases: GraderCase[], systemPrompt: string, charsPerToken: number, fallbackOutTokens = 400): WorkloadShape {
	const ins = cases.map((c) => estimateTokens(systemPrompt + '\n' + c.input, charsPerToken));
	const outChars: number[] = [];
	for (const c of cases) {
		if (!c.reference) continue;
		const { _auto_outcome, _auto_cause, ...asReturned } = c.reference;
		outChars.push(JSON.stringify(asReturned).length);
	}
	const outs = outChars.map((n) => Math.ceil(n / charsPerToken));
	return {
		n: cases.length,
		inTokensMean: Math.round(mean(ins)),
		inTokensP90: Math.round(quantile(ins, 0.9)),
		outTokensMean: outs.length ? Math.round(mean(outs)) : fallbackOutTokens,
		charsPerToken,
		outSource: outs.length ? 'measured-incumbent' : 'default',
	};
}

export interface Projection {
	model: string;
	label: string;
	perCall: number;
	perCallBatch: number;
	perMonth: number;
	perMonthBatch: number;
	perYear: number;
	callsPerMonth: number;
	vsIncumbentPct: number | null;
}

export function project(m: ModelEntry, shape: WorkloadShape, callsPerMonth: number, incumbentPerCall?: number): Projection {
	// Output size is measured from the incumbent's stored grades, which carry no hidden reasoning.
	// Arms that think before answering bill that thinking as output, so scale the estimate for them.
	const outTokens = Math.round(shape.outTokensMean * (m.options?.outTokenMultiplier ?? 1));
	const usage = { inTokens: shape.inTokensMean, outTokens, cachedInTokens: 0 };
	const perCall = costOf(m, usage, false).total;
	const perCallBatch = costOf(m, usage, true).total;
	return {
		model: m.key,
		label: m.label,
		perCall,
		perCallBatch,
		perMonth: perCall * callsPerMonth,
		perMonthBatch: perCallBatch * callsPerMonth,
		perYear: perCall * callsPerMonth * 12,
		callsPerMonth,
		vsIncumbentPct: incumbentPerCall ? (perCall / incumbentPerCall - 1) * 100 : null,
	};
}

/** $0.0000 is unreadable; this keeps small numbers honest without scientific notation. */
export function usd(n: number): string {
	if (n === 0) return '$0';
	if (n < 0.01) return `$${n.toFixed(5)}`;
	if (n < 1) return `$${n.toFixed(4)}`;
	if (n < 100) return `$${n.toFixed(2)}`;
	return `$${Math.round(n).toLocaleString('en-US')}`;
}
