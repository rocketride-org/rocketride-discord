// eval/bakeoff/run.ts — runs both arms on identical inputs and produces the disagreement queue.
//
//   tsx eval/bakeoff/run.ts --smoke                     2 calls, proves the wire formats work
//   tsx eval/bakeoff/run.ts --task judge --n 40 --repeats 3 --yes
//   tsx eval/bakeoff/run.ts --task grader --n 60 --repeats 3 --yes
//   tsx eval/bakeoff/run.ts --disagreements             build the A-vs-B adjudication list
//
// THRESHOLD SWEEP WITHOUT RE-RUNNING: Jev's probability distribution does not depend on the
// threshold — only the escalate/don't decision does, and the escalation target is the same Sonnet
// call every time. So each case needs exactly one Jev call and one Sonnet call, and every
// threshold in the sweep is composed from those offline. The full sweep costs one run, not six.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench } from '../bench/config';
import { loadGraderCases, type GraderCase } from '../bench/tasks';
import { askJev, topProbability, type ChoiceAnswer, type NoulAnswer } from './jev';
import {
	GRADER_QUESTIONS, JUDGE_QUESTION, SONNET, armA_grade, armA_judge, askSonnet,
	type Call, type GraderOut,
} from './arms';
import { decideCause, decideOutcome } from '../rules';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const num = (f: string, d: number) => { const v = Number(val(f)); return Number.isFinite(v) ? v : d; };
const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

export const THRESHOLDS = [0.50, 0.60, 0.70, 0.80, 0.90, 0.95];
const OUT = 'logs/bakeoff';

function key(): string {
	const k = process.env.OPENROUTER_API_KEY || process.env.OPENJEV_API_KEY;
	if (!k) throw new Error('OPENROUTER_API_KEY not set in .env — one key covers Jev and Sonnet');
	return k;
}

const denull = (v: string) => (v === 'none' ? null : v);

// --- case loading ----------------------------------------------------------------------------
interface JudgeRow { id: string; threadId: string; question: string; golden_answer: string; reply: string; _synthetic: boolean; _perturbation: string | null }

/** Judge cases, minus the ones whose golden answers a different question than the opener. */
function judgeCases(n?: number): JudgeRow[] {
	const rows = readFileSync('eval/bakeoff/labels.jsonl', 'utf8').split('\n')
		.map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => JSON.parse(l))
		.filter((r) => r.kind === 'judge');
	const prop = JSON.parse(readFileSync('eval/bakeoff/proposals-judge.json', 'utf8'));
	const usable = rows.filter((r) => prop[r.id]?.verdict !== 'skip');
	return n ? usable.slice(0, n) : usable;
}

// --- one case, both arms ----------------------------------------------------------------------
interface JudgeRecord {
	id: string; repeat: number;
	jev: { ok: boolean; noul: number | null; top: number | null; call: Call; error?: string };
	sonnet: { ok: boolean; verdict: string | null; parseFail: boolean; reason: string; call: Call; error?: string };
	reason: { call: Call };   // priced separately so the sweep can cost REASON policies
}

async function runJudgeCase(apiKey: string, c: JudgeRow, repeat: number): Promise<JudgeRecord> {
	const payload = { question: c.question, golden_answer: c.golden_answer, reply: c.reply };
	const state = JSON.stringify(payload);

	const j = await askJev(apiKey, state, JUDGE_QUESTION);
	const a = j.answers.satisfies as NoulAnswer | undefined;

	const s = await armA_judge(apiKey, payload);

	// One reason call, priced so the sweep can charge REASON without re-running anything.
	const r = await askSonnet(apiKey,
		'You explain a judging decision in one short sentence. Do not change the verdict — justify it. Reply with the sentence only.',
		`${state}\n\nVerdict: fail`, 200);

	return {
		id: c.id, repeat,
		jev: {
			ok: j.ok, noul: a?.noul ?? null, top: a ? topProbability(a) : null,
			call: { costUsd: j.usage.costUsd, ms: j.ms, inTokens: j.usage.inTokens, outTokens: j.usage.outTokens },
			error: j.error,
		},
		sonnet: { ok: s.ok, verdict: s.verdict, parseFail: s.parseFail, reason: s.reason ?? '', call: s.call, error: s.error },
		reason: { call: r.call },
	};
}

interface GraderRecord {
	id: string; repeat: number;
	jev: { ok: boolean; answers: Record<string, { choice: string; probabilities: Record<string, number>; top: number }>; call: Call; error?: string };
	sonnet: { ok: boolean; signals: GraderOut | null; parseFail: boolean; call: Call; error?: string };
}

async function runGraderCase(apiKey: string, c: GraderCase, repeat: number): Promise<GraderRecord> {
	const j = await askJev(apiKey, c.input, GRADER_QUESTIONS);
	const answers: GraderRecord['jev']['answers'] = {};
	for (const k of Object.keys(GRADER_QUESTIONS)) {
		const a = j.answers[k] as ChoiceAnswer | undefined;
		if (a) answers[k] = { choice: a.choice, probabilities: a.probabilities ?? {}, top: topProbability(a) };
	}
	const s = await armA_grade(apiKey, c.input);
	return {
		id: `g-${c.threadId}`, repeat,
		jev: { ok: j.ok, answers, call: { costUsd: j.usage.costUsd, ms: j.ms, inTokens: j.usage.inTokens, outTokens: j.usage.outTokens }, error: j.error },
		sonnet: { ok: s.ok, signals: s.signals, parseFail: s.parseFail, call: s.call, error: s.error },
	};
}

// --- composing Arm C at a threshold, offline ---------------------------------------------------
export function composeJudge(rec: JudgeRecord, threshold: number, reasonPolicy: 'always' | 'on-miss' | 'never') {
	const confident = rec.jev.ok && rec.jev.top != null && rec.jev.top >= threshold;
	if (!confident) {
		// escalated: Arm C pays Jev + the full Sonnet judge, and gets Sonnet's verdict and prose
		return {
			verdict: rec.sonnet.verdict, escalated: true,
			costUsd: rec.jev.call.costUsd + rec.sonnet.call.costUsd,
			ms: rec.jev.call.ms + rec.sonnet.call.ms,
		};
	}
	const verdict = (rec.jev.noul ?? 0) > 0.5 ? 'pass' : 'fail';
	const wantReason = reasonPolicy === 'always' || (reasonPolicy === 'on-miss' && verdict !== 'pass');
	return {
		verdict, escalated: false,
		costUsd: rec.jev.call.costUsd + (wantReason ? rec.reason.call.costUsd : 0),
		ms: rec.jev.call.ms + (wantReason ? rec.reason.call.ms : 0),
	};
}

export function composeGrader(rec: GraderRecord, threshold: number) {
	const signals: GraderOut = {};
	const escalatedFields: string[] = [];
	for (const k of Object.keys(GRADER_QUESTIONS)) {
		const a = rec.jev.answers[k];
		if (!a || a.top < threshold) { escalatedFields.push(k); continue; }
		(signals as any)[k] = k === 'escalation_category' || k === 'llm_cause' ? denull(a.choice) : a.choice;
	}
	const escalated = escalatedFields.length > 0;
	if (escalated && rec.sonnet.signals) for (const k of escalatedFields) (signals as any)[k] = (rec.sonnet.signals as any)[k];
	return {
		signals: escalated && !rec.sonnet.signals ? null : signals,
		escalated, escalatedFields,
		costUsd: rec.jev.call.costUsd + (escalated ? rec.sonnet.call.costUsd : 0),
		ms: rec.jev.call.ms + (escalated ? rec.sonnet.call.ms : 0),
	};
}

/** Signals → the outcome/cause that would land on the scorecard, using production's own logic. */
export function decisionOf(c: GraderCase, s: GraderOut | null) {
	if (!s) return { outcome: null, cause: null };
	const sig = { team_reply_kind: s.team_reply_kind as any, user_signal: s.user_signal as any, escalation_category: s.escalation_category as any, llm_cause: s.llm_cause as any };
	const { outcome } = decideOutcome(c.thread, c.events, sig, { testAllowBotIds: [], testChannelIds: [] });
	return { outcome, cause: decideCause(outcome, c.events, sig, { ...c.retrieval, matchScore: bench.matchScore }) };
}

// --- commands ----------------------------------------------------------------------------------
async function smoke() {
	const apiKey = key();
	log('smoke: one Jev decision + one Sonnet completion (a fraction of a cent)');
	const state = JSON.stringify({ question: 'Does RocketRide need my own LLM key?', golden_answer: 'Yes — you supply your own provider API key for LLM nodes.', reply: 'Yes, you provide your own API key for the LLM service you want to use.' });
	const j = await askJev(apiKey, state, JUDGE_QUESTION);
	console.log('  Jev   :', j.ok ? `ok — ${JSON.stringify(j.answers)} · $${j.usage.costUsd} · ${j.ms}ms · model=${j.model}` : `FAILED — ${j.error}`);
	const s = await askSonnet(apiKey, 'Reply with the single word: ok', 'ping', 20);
	console.log('  Sonnet:', s.ok ? `ok — "${s.text.trim().slice(0, 40)}" · $${s.call.costUsd} · ${s.call.ms}ms` : `FAILED — ${s.error}`);
	if (!j.ok || !s.ok) { console.log('\nFix the failures above before running the real thing.'); process.exit(1); }
	console.log('\nBoth wire formats work. Safe to --run.');
}

async function run() {
	const apiKey = key();
	const task = (val('--task') ?? 'judge') as 'judge' | 'grader';
	const repeats = num('--repeats', 3);
	const n = val('--n') ? num('--n', 40) : undefined;
	const cases: (JudgeRow | GraderCase)[] = task === 'judge' ? judgeCases(n) : loadGraderCases({ n });
	const perCase = task === 'judge' ? 3 : 2;
	const calls = cases.length * repeats * perCase;

	console.log(`\n${task} · ${cases.length} cases × ${repeats} repeats × ${perCase} calls = ${calls} calls`);
	console.log(`  Jev is ~$0.00005/call; Sonnet dominates. Rough total: $${(cases.length * repeats * (task === 'judge' ? 0.005 : 0.014)).toFixed(2)}`);
	console.log(`  Thresholds ${THRESHOLDS.join(', ')} are all composed from this one run.\n`);
	if (!has('--yes')) { console.log('Add --yes to run it.'); return; }

	const runId = new Date().toISOString().replace(/[:.]/g, '-');
	const dir = join(OUT, `${task}-${runId}`);
	mkdirSync(dir, { recursive: true });
	const records: any[] = [];
	let spend = 0, done = 0;

	for (let r = 0; r < repeats; r++) {
		for (const c of cases) {
			const rec = task === 'judge'
				? await runJudgeCase(apiKey, c as JudgeRow, r)
				: await runGraderCase(apiKey, c as GraderCase, r);
			records.push(rec);
			spend += rec.jev.call.costUsd + rec.sonnet.call.costUsd + ((rec as JudgeRecord).reason?.call.costUsd ?? 0);
			if (++done % 10 === 0 || done === cases.length * repeats) log(`  ${done}/${cases.length * repeats} cases · $${spend.toFixed(4)}`);
			if (!rec.jev.ok) log(`  ! jev ${rec.id}: ${rec.jev.error}`);
			if (!rec.sonnet.ok) log(`  ! sonnet ${rec.id}: ${rec.sonnet.error}`);
		}
	}
	writeFileSync(join(dir, 'records.jsonl'), records.map((x) => JSON.stringify(x)).join('\n') + '\n');
	writeFileSync(join(dir, 'meta.json'), JSON.stringify({ task, runId, cases: cases.length, repeats, spendUsd: spend, sonnet: SONNET, startedAt: runId }, null, 2));
	log(`done — $${spend.toFixed(4)} spent · ${dir}`);
	log(`next: tsx eval/bakeoff/run.ts --disagreements`);
}

function latest(task: string): string {
	const dirs = readdirSync(OUT).filter((d) => d.startsWith(task + '-')).sort();
	if (!dirs.length) throw new Error(`no ${task} run under ${OUT}`);
	return join(OUT, dirs[dirs.length - 1]);
}

/** The only thing a human has to look at: rows where the two arms landed differently. */
function disagreements() {
	const out: any[] = [];
	for (const task of ['judge', 'grader']) {
		let dir: string;
		try { dir = latest(task); } catch { continue; }
		const recs = readFileSync(join(dir, 'records.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
		const byId = new Map<string, any[]>();
		for (const r of recs) (byId.get(r.id) ?? byId.set(r.id, []).get(r.id)!).push(r);

		for (const [id, list] of byId) {
			const r0 = list[0];
			if (task === 'judge') {
				const c = composeJudge(r0, num('--threshold', 0.80), 'on-miss');
				if (c.verdict !== r0.sonnet.verdict) out.push({ task, id, sonnet: r0.sonnet.verdict, jev: c.verdict, escalated: c.escalated, noul: r0.jev.noul, top: r0.jev.top });
			} else {
				const c = composeGrader(r0, num('--threshold', 0.80));
				const a = JSON.stringify(r0.sonnet.signals), b = JSON.stringify(c.signals);
				if (a !== b) out.push({ task, id, sonnet: r0.sonnet.signals, jev: c.signals, escalatedFields: c.escalatedFields, probabilities: r0.jev.answers });
			}
		}
	}
	mkdirSync(OUT, { recursive: true });
	writeFileSync(join(OUT, 'disagreements.json'), JSON.stringify(out, null, 2));
	console.log(`${out.length} disagreement(s) → ${join(OUT, 'disagreements.json')}`);
	console.log('These are the only rows a human needs to look at.');
}

async function main() {
	if (has('--smoke')) return await smoke();
	if (has('--run')) return await run();
	if (has('--disagreements')) return disagreements();
	console.log(`usage: tsx eval/bakeoff/run.ts
  --smoke                                     2 calls, proves both wire formats work
  --run --task judge|grader [--n N] [--repeats 3] --yes
  --disagreements [--threshold 0.80]          build the A-vs-B list for a human`);
}
main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(1); });
