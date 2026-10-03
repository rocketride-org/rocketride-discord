// eval/bench/report.ts — renders the two tables the decision actually needs: what each arm costs,
// and how far its labels drift from the reference. Markdown for the terminal / PR, HTML to share.
import type { ModelEntry } from './config';
import { usd, type Projection, type WorkloadShape } from './cost';
import type { ModelScore } from './score';
import type { RunSummary } from './runner';

const pct = (n: number | null | undefined, dp = 1) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(dp)}%`);
const num = (n: number | null | undefined, dp = 2) => (n === null || n === undefined ? '—' : n.toFixed(dp));
const ms = (n: number) => `${Math.round(n)}ms`;

export interface EstimateInput {
	shape: WorkloadShape;
	projections: Projection[];
	volume: { perMonth: number; perDay: number; n: number; days: number };
	windowDays: number;
	asof: string;
	judgeCallsPerMonth?: number;
}

export function estimateMarkdown(e: EstimateInput): string {
	const L: string[] = [];
	L.push('# Eval grader — cost by model', '');
	L.push(`Prices as of **${e.asof}** (list, USD). Token counts estimated at ${e.shape.charsPerToken} chars/token from the real prompts in the eval store; output size taken from the incumbent's stored grades (${e.shape.outSource}). Expect \u00b115% until a \`--run\` returns measured usage.`, '');
	L.push('## Workload', '');
	L.push('| | |', '|---|---|');
	L.push(`| Threads reaching the grader LLM | ${e.volume.n} in the last ${Math.round(e.volume.days)} days |`);
	L.push(`| Rate | ${e.volume.perDay.toFixed(2)}/day → **${Math.round(e.volume.perMonth)} grader calls/month** |`);
	L.push(`| Input tokens per call | ${e.shape.inTokensMean.toLocaleString()} mean · ${e.shape.inTokensP90.toLocaleString()} p90 |`);
	L.push(`| Output tokens per call | ${e.shape.outTokensMean.toLocaleString()} |`);
	if (e.judgeCallsPerMonth) L.push(`| Judge calls/month (replay) | ${e.judgeCallsPerMonth} |`);
	L.push('');
	L.push('## Cost', '');
	L.push('| Model | $/call | $/call (batch) | $/month | $/year | vs incumbent |', '|---|---|---|---|---|---|');
	for (const p of e.projections) {
		L.push(`| ${p.label} | ${usd(p.perCall)} | ${p.perCallBatch < p.perCall ? usd(p.perCallBatch) : '—'} | ${usd(p.perMonth)} | ${usd(p.perYear)} | ${p.vsIncumbentPct === null ? '—' : `${p.vsIncumbentPct > 0 ? '+' : ''}${p.vsIncumbentPct.toFixed(0)}%`} |`);
	}
	L.push('');
	return L.join('\n');
}

export function runMarkdown(s: RunSummary, projections: Map<string, Projection>, entries: Map<string, ModelEntry>): string {
	const L: string[] = [];
	L.push('# Eval grader — model bake-off', '');
	L.push(`Run \`${s.runId}\` · ${s.nCases} cases × ${s.repeats} repeat(s) · reference = **${s.referenceKind}**${s.referenceKind === 'incumbent' ? ' (GPT-5.4, what runs today)' : ` (${s.goldN} human-labelled cases)`} · spent ${usd(s.spendUsd)}.`, '');
	if (s.referenceKind === 'incumbent') {
		L.push('> Agreement below means "reproduces the labels we ship today", not "is correct". A model can only be shown to be *better* than the incumbent against human labels — see `--label` in the README.', '');
	}
	L.push('## Accuracy', '');
	L.push('| Model | calls ok | JSON valid | outcome agree | κ | cause agree | draft discipline | self-consistent |', '|---|---|---|---|---|---|---|---|');
	for (const m of s.scores) {
		L.push(`| ${entries.get(m.model)?.label ?? m.model} | ${pct(m.callSuccessRate, 0)} | ${pct(m.schemaValidRate, 0)} | ${pct(m.outcomeAgreement)} | ${num(m.outcomeKappa)} | ${pct(m.causeAgreement)} | ${pct(m.draftDisciplineRate, 0)} (${m.draftMissed} missed / ${m.draftInvented} invented) | ${pct(m.selfConsistency, 0)} |`);
	}
	L.push('');
	L.push('## Panel consensus (leave-one-out)', '');
	L.push('Agreement with the majority of the *other* arms — an outside-view check that does not privilege the incumbent.', '');
	L.push('| Model | agrees with panel | κ |', '|---|---|---|');
	for (const m of s.consensusScores) L.push(`| ${entries.get(m.model)?.label ?? m.model} | ${pct(m.outcomeAgreement)} | ${num(m.outcomeKappa)} |`);
	L.push('');
	L.push('## Cost & latency (measured)', '');
	L.push('| Model | $/call | $/1k calls | projected $/month | p50 | p95 |', '|---|---|---|---|---|---|');
	for (const m of s.scores) {
		const p = projections.get(m.model);
		L.push(`| ${entries.get(m.model)?.label ?? m.model} | ${usd(m.costPerCall)} | ${usd(m.costPer1k)} | ${p ? usd(m.costPerCall * p.callsPerMonth) : '—'} | ${ms(m.msP50)} | ${ms(m.msP95)} |`);
	}
	L.push('');
	return L.join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Same visual language as ralph-eval-summary.html so the two reports read as one family. */
export function html(title: string, sections: { heading: string; intro?: string; head: string[]; rows: string[][] }[], footer: string): string {
	const table = (s: { heading: string; intro?: string; head: string[]; rows: string[][] }) => `
  <h2>${esc(s.heading)}</h2>
  ${s.intro ? `<p class="legend">${s.intro}</p>` : ''}
  <table>
    <tr>${s.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
    ${s.rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="p"' : ''}>${c}</td>`).join('')}</tr>`).join('\n    ')}
  </table>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{max-width:960px;margin:32px auto;padding:0 20px;color:#1a1a2e;
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  h1{font-size:26px;margin:0 0 4px}
  .sub{color:#5b5b70;margin:0 0 24px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:#5865F2;margin:30px 0 8px}
  table{width:100%;border-collapse:collapse;margin:8px 0 4px;font-size:14.5px}
  th,td{text-align:left;vertical-align:top;padding:9px 10px;border-bottom:1px solid #e6e6ef}
  th{background:#f6f7fb;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b5b70}
  td.p{font-weight:600;white-space:nowrap}
  .legend{font-size:13px;color:#5b5b70;margin-top:6px}
  .box{background:#f6f7fb;border:1px solid #e6e6ef;border-radius:10px;padding:14px 18px;margin:14px 0}
  footer{margin-top:28px;color:#9a9aa8;font-size:12.5px;border-top:1px solid #e6e6ef;padding-top:12px}
  @media print{body{margin:0}}
</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p class="sub">Rocket Ralph eval · grader model comparison</p>
${sections.map(table).join('\n')}
  <footer>${footer}</footer>
</body>
</html>
`;
}
