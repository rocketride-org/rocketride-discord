// eval/bakeoff/summarise.ts — pulls every finished run together into one decision table.
//
//   tsx eval/bakeoff/summarise.ts
//
// Judge accuracy uses the 3-level Jev rescore where available (the yes/no form had no way to say
// "partial" and rounded borderline replies up to pass). Grader accuracy runs each arm's signals
// through production's own decideOutcome/decideCause, so the number compared is the one that would
// land on the scorecard — not a raw field match.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraderCases } from '../bench/tasks';
import { composeGrader, decisionOf } from './run';
import { decideOutcome } from '../rules';

const OUT = 'logs/bakeoff';
const latest = (task: string) => {
	const d = readdirSync(OUT).filter((x) => x.startsWith(task + '-')).sort();
	return d.length ? join(OUT, d[d.length - 1]) : null;
};
const jsonl = (p: string) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
const quant = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * s.length)] ?? 0; };
const V = ['fail', 'partial', 'pass'];
const bucket = (p: Record<string, number>) => Object.entries(p).reduce((a, c) => (c[1] > a[1] ? c : a))[0];
const isPass = (v: string | null) => v === 'pass';

export const THRESHOLDS = [0.50, 0.60, 0.70, 0.80, 0.90];
/** Judge: 50 golden cases replayed weekly. Grader: measured 47 threads/month reaching the LLM. */
export const MONTHLY = { judge: 216, grader: 47 };

export function judgeTable() {
	const dir = latest('judge');
	if (!dir || !existsSync(join(dir, 'records.jsonl'))) return null;
	const recs = jsonl(join(dir, 'records.jsonl')).filter((r) => r.repeat === 0);
	const prop = JSON.parse(readFileSync('eval/bakeoff/proposals-judge.json', 'utf8'));
	const score = existsSync(join(OUT, 'rescore-judge.jsonl'))
		? new Map(jsonl(join(OUT, 'rescore-judge.jsonl')).filter((r) => r.repeat === 0).map((r) => [r.id, r]))
		: new Map();
	const son = new Map(recs.map((r) => [r.id, r]));
	const labelled = recs.filter((r) => prop[r.id]?.verdict && prop[r.id].verdict !== 'skip');
	const failBase = labelled.filter((r) => prop[r.id].verdict === 'fail').length;

	const row = (name: string, pick: (r: any) => { v: string | null; cost: number; ms: number }) => {
		let ok = 0, fp = 0, cost = 0, esc = 0; const lat: number[] = [];
		for (const r of recs) {
			const s = pick(r); cost += s.cost; lat.push(s.ms);
			const g = prop[r.id]?.verdict; if (!g || g === 'skip') continue;
			if (isPass(s.v) === isPass(g)) ok++;
			if (g === 'fail' && isPass(s.v)) fp++;
		}
		return { name, accuracy: pct(ok, labelled.length), falsePass: fp, failBase,
			perCall: cost / recs.length, perMonth: (cost / recs.length) * MONTHLY.judge, p50: quant(lat, 0.5), escalates: esc };
	};

	const rows = [row('Sonnet only', (r) => ({ v: r.sonnet.verdict, cost: r.sonnet.call.costUsd, ms: r.sonnet.call.ms }))];
	for (const th of THRESHOLDS) {
		let esc = 0;
		const r2 = row(`Jev+Sonnet @ ${th.toFixed(2)}`, (r) => {
			const sc = score.get(r.id); const s = son.get(r.id);
			if (!sc) return { v: r.sonnet.verdict, cost: r.sonnet.call.costUsd, ms: r.sonnet.call.ms };
			const confident = sc.top >= th; if (!confident) esc++;
			return confident
				? { v: V[+bucket(sc.probabilities)], cost: sc.costUsd, ms: sc.ms }
				: { v: s.sonnet.verdict, cost: sc.costUsd + s.sonnet.call.costUsd, ms: sc.ms + s.sonnet.call.ms };
		});
		rows.push({ ...r2, escalates: pct(esc, recs.length) });
	}
	return { n: recs.length, labelled: labelled.length, failBase, rows };
}

export function graderTable() {
	const dir = latest('grader');
	if (!dir || !existsSync(join(dir, 'records.jsonl'))) return null;
	const recs = jsonl(join(dir, 'records.jsonl')).filter((r) => r.repeat === 0);
	const prop = JSON.parse(readFileSync('eval/bakeoff/proposals-grader.json', 'utf8'));
	const cases = new Map(loadGraderCases({}).map((c) => [`g-${c.threadId}`, c]));
	const labelled = recs.filter((r) => prop[r.id]?.outcome);

	// A reference label the schema cannot express is unwinnable for EVERY arm, so scoring against
	// it measures the schema, not the model. decideOutcome emits `excluded` only from its
	// pre-checks (team opener, test bot, manipulation) — never from an LLM signal — so every
	// "this is just a greeting" label is unreachable. Report both, lead with the reachable set.
	const reachable = new Set<string>();
	for (const r of recs) {
		const c = cases.get(r.id); const want = prop[r.id]?.outcome; if (!c || !want) continue;
		const poss = new Set<string>();
		for (const t of ['none', 'ack', 'correction', 'addition'] as const)
			for (const u of ['confirmed', 'rejected', 'neutral'] as const)
				poss.add(decideOutcome(c.thread, c.events, { team_reply_kind: t, user_signal: u }, { testAllowBotIds: [], testChannelIds: [] }).outcome);
		if (poss.has(want)) reachable.add(r.id);
	}

	const score = (v: { outcome: string | null; cause: string | null }, id: string) => {
		const p = prop[id]; if (!p?.outcome) return null;
		return { outcome: v.outcome === p.outcome, cause: (v.cause ?? '') === (p.cause ?? '') };
	};

	const row = (name: string, pick: (r: any, c: any) => { d: any; cost: number; ms: number; escalated: boolean }) => {
		let o = 0, cz = 0, cost = 0, esc = 0, parseFail = 0, oR = 0; const lat: number[] = [];
		for (const r of recs) {
			const c = cases.get(r.id); if (!c) continue;
			const s = pick(r, c); cost += s.cost; lat.push(s.ms); if (s.escalated) esc++;
			if (!s.d.outcome) parseFail++;
			const sc = score(s.d, r.id); if (!sc) continue;
			if (sc.outcome) { o++; if (reachable.has(r.id)) oR++; }
			if (sc.cause) cz++;
		}
		return { name, outcomeAcc: pct(o, labelled.length), outcomeReach: pct(oR, reachable.size), causeAcc: pct(cz, labelled.length),
			perCall: cost / recs.length, perMonth: (cost / recs.length) * MONTHLY.grader,
			p50: quant(lat, 0.5), escalates: pct(esc, recs.length), parseFail };
	};

	const rows = [row('Sonnet only', (r, c) => ({ d: decisionOf(c, r.sonnet.signals), cost: r.sonnet.call.costUsd, ms: r.sonnet.call.ms, escalated: false }))];
	for (const th of THRESHOLDS) {
		rows.push(row(`Jev+Sonnet @ ${th.toFixed(2)}`, (r, c) => {
			const comp = composeGrader(r, th);
			return { d: decisionOf(c, comp.signals), cost: comp.costUsd, ms: comp.ms, escalated: comp.escalated };
		}));
	}
	return { n: recs.length, labelled: labelled.length, reachable: reachable.size, rows };
}

if (process.argv[1]?.endsWith('summarise.ts')) {
	const j = judgeTable();
	if (j) {
		console.log(`\nJUDGE — ${j.n} cases, ${j.labelled} with a reference label, ${j.failBase} of them labelled fail\n`);
		console.log('option                | accuracy | false-pass | $/call   | $/month | p50     | escalates');
		for (const r of j.rows) console.log(`${r.name.padEnd(21)} |   ${String(r.accuracy).padStart(3)}%   |    ${r.falsePass}/${r.failBase}     | $${r.perCall.toFixed(5)} | $${r.perMonth.toFixed(2).padStart(5)}  | ${String(r.p50).padStart(5)}ms | ${r.escalates}%`);
	} else console.log('\nJUDGE — no run found');

	const g = graderTable();
	if (g) {
		console.log(`\nGRADER — ${g.n} cases, ${g.labelled} labelled, ${g.reachable} of those winnable by any model\n`);
		console.log('option                | outcome* | cause | $/call   | $/month | p50     | escalates');
		for (const r of g.rows) console.log(`${r.name.padEnd(21)} |    ${String(r.outcomeReach).padStart(3)}%  |  ${String(r.causeAcc).padStart(3)}% | $${r.perCall.toFixed(5)} | $${r.perMonth.toFixed(2).padStart(5)}  | ${String(r.p50).padStart(5)}ms |    ${String(r.escalates).padStart(3)}%`);
		console.log(`\n* on the ${g.reachable} winnable rows. The other ${g.labelled - g.reachable} want "excluded", which the grader schema cannot express — unwinnable for Sonnet too.`);
	} else console.log('\nGRADER — no run found (still running?)');
}
