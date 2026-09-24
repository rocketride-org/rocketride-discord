// eval/bench/tasks.ts — builds the bench's inputs from PRODUCTION artefacts, so an arm is never
// scored on a prompt or a thread shape that production doesn't actually use:
//   · the system prompt is read out of pipelines/eval-grader.pipe at run time (no copy to drift)
//   · each case is rebuilt with the exact same code path as eval/grader.ts
//   · the store is opened READ-ONLY — the bench must never write to the live eval DB
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bench } from './config';
import { decideOutcome, type EvalEvent, type ThreadInfo } from '../rules';

export interface GraderCase {
	threadId: string;
	question: string;
	/** The exact user message eval/grader.ts sends to the grader LLM. */
	input: string;
	thread: ThreadInfo;
	events: EvalEvent[];
	/** Production's stored grade (GPT-5.4) — the incumbent reference, not ground truth. */
	reference: any | null;
	refOutcome: string | null;
	refCause: string | null;
	/** Retrieval is a local miniLM step, identical for every arm — replayed, not re-run. */
	retrieval: { aTop: number | null; overlap: boolean; teamAnswerExists: boolean };
}

export interface JudgeCase {
	id: string;
	question: string;
	golden_answer: string;
	reply: string;
	expected?: 'pass' | 'partial' | 'fail';
}

/** Pull the instruction block out of a .pipe file's prompt node — the real production prompt. */
export function loadPipePrompt(pipePath: string): string {
	const pipe = JSON.parse(readFileSync(pipePath, 'utf8'));
	const node = (pipe.components ?? []).find((c: any) => c.provider === 'prompt');
	const lines: string[] = node?.config?.instructions ?? [];
	if (!lines.length) throw new Error(`no prompt instructions found in ${pipePath}`);
	return lines.join('\n');
}

// --- mirrors eval/grader.ts exactly ---------------------------------------------------------
const roleOf = (t: string) =>
	t === 'ralph_answer' || t === 'escalation' || t === 'dead_end' ? 'ralph'
	: t === 'team_reply' || t === 'team_mention' ? 'team'
	: t === 'question' || t === 'user_message' ? 'user' : 'other';

const toEvents = (rows: any[]): EvalEvent[] =>
	rows.map((r) => ({ type: r.type, actor_id: r.actor_id, ts: r.ts, data: r.data ? JSON.parse(r.data) : undefined }));

const fnv1a = (s: string): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
	return h >>> 0;
};

/**
 * Load gradable threads as bench cases.
 * Threads that production excludes before ever calling the LLM are dropped here too — they cost
 * nothing in production, so including them would flatter every model's agreement score.
 */
export function loadGraderCases(opts: { n?: number; windowDays?: number; dbPath?: string } = {}): GraderCase[] {
	const db = new DatabaseSync(opts.dbPath ?? bench.dbPath, { readOnly: true });
	try {
		const clusters = db.prepare('SELECT id, label, description FROM clusters WHERE merged_into IS NULL').all();
		const cutoff = opts.windowDays ? Date.now() - opts.windowDays * 86400_000 : 0;
		const threads = db.prepare('SELECT * FROM threads WHERE created_at >= ? ORDER BY created_at').all(cutoff) as any[];
		const exOpts = { testAllowBotIds: bench.testAllowBotIds, testChannelIds: [] as string[] };
		const cases: GraderCase[] = [];

		for (const t of threads) {
			const rows = db.prepare('SELECT * FROM events WHERE thread_id = ? ORDER BY ts').all(t.thread_id) as any[];
			const events = toEvents(rows);
			const thread: ThreadInfo = { opener_id: t.opener_id, opener_is_team: !!t.opener_is_team, channel_id: t.channel_id };
			if (decideOutcome(thread, events, {}, exOpts).excluded_reason) continue;

			const transcript = rows.filter((r) => r.text).map((r) => ({ role: roleOf(r.type), text: String(r.text).slice(0, 1500) }));
			const escEv = rows.find((r) => r.type === 'escalation');
			const input = JSON.stringify({
				question: t.question,
				transcript,
				escalation: { present: !!escEv, text: escEv?.text ?? '' },
				clusters,
			});
			const teamAnswerExists = rows.some((r) => (r.type === 'team_reply' || r.type === 'team_mention') && r.text);
			let reference: any = null;
			try { reference = t.grader_json ? JSON.parse(t.grader_json) : null; } catch { reference = null; }

			cases.push({
				threadId: t.thread_id,
				question: t.question,
				input,
				thread,
				events,
				reference,
				refOutcome: t.outcome ?? null,
				refCause: t.cause ?? null,
				retrieval: {
					aTop: t.a_top_score ?? null,
					// analyzeRetrieval is invertible: 'bad_answer' is the only cause it emits when a top
					// chunk already overlapped the question's retrieval.
					overlap: t.cause === 'bad_answer',
					teamAnswerExists,
				},
			});
		}
		return opts.n ? stratify(cases, opts.n) : cases;
	} finally {
		db.close();
	}
}

/**
 * Deterministic stratified sample: round-robin across outcome classes so rare labels
 * (dead_end, rejected, policy_*) survive a small --n, and the same --n always picks the same cases.
 */
export function stratify(cases: GraderCase[], n: number): GraderCase[] {
	if (n >= cases.length) return cases;
	const groups = new Map<string, GraderCase[]>();
	for (const c of cases) {
		const k = c.refOutcome ?? 'ungraded';
		(groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
	}
	for (const list of groups.values()) list.sort((a, b) => fnv1a(a.threadId) - fnv1a(b.threadId));
	const keys = [...groups.keys()].sort();
	const out: GraderCase[] = [];
	for (let i = 0; out.length < n; i++) {
		let took = false;
		for (const k of keys) {
			const list = groups.get(k)!;
			if (i < list.length) { out.push(list[i]); took = true; if (out.length === n) break; }
		}
		if (!took) break;
	}
	return out;
}

/** Judge cases come from a JSONL file: {question, golden_answer, reply, expected?} per line. */
export function loadJudgeCases(path: string): JudgeCase[] {
	return readFileSync(path, 'utf8')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l, i) => { const o = JSON.parse(l); return { id: o.id ?? `case-${i + 1}`, ...o } as JudgeCase; });
}

/** How many threads per month reach the grader LLM — the number the cost projection multiplies. */
export function monthlyGraderVolume(windowDays: number, dbPath = bench.dbPath): { perMonth: number; perDay: number; n: number; days: number } {
	const all = loadGraderCases({ dbPath });
	const now = Date.now();
	const cutoff = now - windowDays * 86400_000;
	const db = new DatabaseSync(dbPath, { readOnly: true });
	let firstTs = now;
	try {
		const row = db.prepare('SELECT MIN(created_at) a FROM threads').get() as any;
		firstTs = row?.a ?? now;
	} finally { db.close(); }
	// Use the requested window, but never claim a longer history than the store actually has.
	const spanMs = Math.max(1, Math.min(windowDays * 86400_000, now - firstTs));
	const days = spanMs / 86400_000;
	const n = all.filter((c) => {
		const ts = c.events[0]?.ts ?? 0;
		return ts >= Math.max(cutoff, firstTs);
	}).length;
	const perDay = n / days;
	return { perMonth: perDay * 30, perDay, n, days };
}
