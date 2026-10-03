// eval/replay.ts — Phase 5. Regenerates ISOLATED copies of the prod pipes (distinct project_ids),
// runs the golden set through `support.ts --send-batch` against those copies (never prod), judges
// answers, stores the run, and reports pass rate + hard fails + regressions.
// SAFETY: aborts if a copy's path or project_id collides with a production pipe.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { RocketRideClient } from 'rocketride';
import { config } from './config';
import { detectEngineUri, SerialPipe } from './engine';
import type { Store } from './store';

type Log = (...a: unknown[]) => void;
const EVAL_DIR = 'pipelines/.eval';
const RALPH_EVAL = `${EVAL_DIR}/rocket-ralph.eval.pipe`;
const SYNTH_EVAL = `${EVAL_DIR}/summariser.eval.pipe`;
const PROD = ['pipelines/rocket-ralph.pipe', 'pipelines/summariser.pipe'];

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}.txt`;
const parseJson = (s: string) => { try { const m = s.match(/\{[\s\S]*\}/); return JSON.parse(m ? m[0] : s); } catch { return null; } };
function firstAnswer(res: any): string {
	const rt = res?.result_types ?? {};
	for (const [k, v] of Object.entries(rt)) if (v === 'answers' && Array.isArray(res[k])) return String(res[k][0] ?? '');
	return Array.isArray(res?.answers) ? String(res.answers[0] ?? '') : '';
}

function regen(src: string, dst: string, projectId: string): void {
	const p = JSON.parse(readFileSync(src, 'utf8'));
	p.project_id = projectId;
	writeFileSync(dst, JSON.stringify(p, null, 2));
}
function assertIsolated(): void {
	const prodIds = new Set<string>();
	for (const f of PROD) { try { prodIds.add(JSON.parse(readFileSync(f, 'utf8')).project_id); } catch {} }
	for (const id of config.replayProjectIds) if (prodIds.has(id)) throw new Error(`replay project_id ${id} collides with a production pipe — aborting`);
	for (const p of [RALPH_EVAL, SYNTH_EVAL]) if (PROD.includes(p)) throw new Error('replay copy path collides with prod — aborting');
}

async function sendBatch(cases: any[], log: Log): Promise<Map<number, any>> {
	mkdirSync(EVAL_DIR, { recursive: true });
	const tmp = `${EVAL_DIR}/replay-${Date.now()}.jsonl`;
	writeFileSync(tmp, cases.map((c) => JSON.stringify({ id: c.id, question: c.question })).join('\n'));
	const out: string = await new Promise((resolve, reject) => {
		const child = spawn('./node_modules/.bin/tsx', ['support.ts', '--send-batch', tmp, '--json'], { env: { ...process.env, PIPE: RALPH_EVAL, SYNTH_PIPE: SYNTH_EVAL } });
		let buf = ''; child.stdout.on('data', (d) => (buf += d)); child.stderr.on('data', () => {});
		child.on('close', () => resolve(buf)); child.on('error', reject);
	});
	const map = new Map<number, any>();
	for (const line of out.split('\n')) { const o = parseJson(line); if (o && o.id != null) map.set(Number(o.id), o); }
	log(`send-batch returned ${map.size}/${cases.length} results`);
	return map;
}

export async function replay(store: Store, opts: { limit?: number; log: Log }): Promise<any> {
	const { log } = opts;
	assertIsolated();
	regen(PROD[0], RALPH_EVAL, config.replayProjectIds[0]);
	regen(PROD[1], SYNTH_EVAL, config.replayProjectIds[1]);

	const cases = store.getActiveGolden().slice(0, opts.limit ?? Infinity);
	if (!cases.length) { log('no active golden cases — nothing to replay (seed via --golden-from-thread / review approvals)'); return { n: 0 }; }

	const started = Date.now();
	const results = await sendBatch(cases, log);

	const rr = new RocketRideClient({ uri: detectEngineUri(), auth: config.rocketrideApiKey } as any);
	await rr.connect();
	const judge = new SerialPipe(rr, config.judgePipe); await judge.start();
	const prev = store.getPrevReplayVerdicts();
	const scored: any[] = []; let passed = 0, hardFails = 0; const regressions: number[] = [];
	try {
		for (const c of cases) {
			const r = results.get(c.id);
			let verdict = 'fail', notes = '';
			if (!r || r.error) { notes = r?.error ?? 'no result'; }
			else if (c.expected === 'escalate') { verdict = r.escalated ? 'pass' : 'fail'; if (!r.escalated) { notes = 'HARD FAIL: answered instead of escalating'; hardFails++; } }
			else if (r.escalated) { verdict = 'fail'; notes = 'unnecessary escalation'; }
			else { const j = parseJson(firstAnswer(await judge.send(JSON.stringify({ question: c.question, golden_answer: c.golden_answer, reply: r.shown }), uniq('judge')))) ?? {}; verdict = j.verdict ?? 'fail'; notes = j.notes ?? ''; }
			if (verdict === 'pass') passed++;
			if (prev.get(c.id) === 'pass' && verdict !== 'pass') regressions.push(c.id);
			scored.push({ case_id: c.id, reply: r?.shown ?? '', escalated: r?.escalated ? 1 : 0, verdict, escalation: r?.escalated ? 'yes' : 'no', notes });
		}
	} finally { await judge.stop().catch(() => {}); await rr.disconnect().catch(() => {}); }

	const gitSha = (() => { try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
	const pipeSha = createHash('sha256').update(readFileSync(PROD[0])).digest('hex');
	const runId = store.insertReplayRun({ started_at: started, finished_at: Date.now(), git_sha: gitSha, pipe_sha256: pipeSha, n: cases.length, passed });
	for (const s of scored) store.insertReplayResult({ run_id: runId, ...s });

	log(`replay run ${runId}: ${passed}/${cases.length} pass · ${hardFails} hard fails · ${regressions.length} regressions${regressions.length ? ' (' + regressions.join(',') + ')' : ''}`);
	return { runId, n: cases.length, passed, hardFails, regressions };
}
