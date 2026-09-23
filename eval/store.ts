// eval/store.ts — SQLite repository. EVERY SQL statement lives here (guardrail).
// Uses the built-in node:sqlite (verified on Node v26 in Phase 0), WAL + busy_timeout.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, opener_id TEXT NOT NULL,
  opener_is_team INTEGER NOT NULL DEFAULT 0, question TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', outcome TEXT, outcome_source TEXT,
  cause TEXT, cause_source TEXT, excluded_reason TEXT,
  cluster_id INTEGER, q_top_score REAL, a_top_score REAL, grader_json TEXT,
  review_message_id TEXT, reviewed_by TEXT, reviewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
  message_id TEXT, ts INTEGER NOT NULL, type TEXT NOT NULL,
  actor_id TEXT, text TEXT, data TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS events_message ON events(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id);
CREATE TABLE IF NOT EXISTS clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, description TEXT,
  created_at INTEGER NOT NULL, merged_into INTEGER
);
CREATE TABLE IF NOT EXISTS qa_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, question TEXT NOT NULL,
  answer TEXT NOT NULL, status TEXT NOT NULL, approved_by TEXT, approved_at INTEGER, ingested_at INTEGER
);
CREATE TABLE IF NOT EXISTS golden_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, expected TEXT NOT NULL,
  golden_answer TEXT, source TEXT NOT NULL, thread_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
`;

const TRUNC = 4000;
const clip = (s: string | null | undefined): string | null => (s == null ? null : String(s).slice(0, TRUNC));

export interface ThreadRow {
	thread_id: string; channel_id: string; opener_id: string; opener_is_team: number;
	question: string; created_at: number; last_activity_at: number; excluded_reason?: string | null;
}
export interface EventRow {
	thread_id: string; message_id?: string | null; ts: number; type: string;
	actor_id?: string | null; text?: string | null; data?: unknown;
}

export class Store {
	private db: DatabaseSync;
	constructor(dbPath: string) {
		if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
		this.db.exec(SCHEMA);
	}

	upsertThread(t: ThreadRow): void {
		this.db.prepare(`
			INSERT INTO threads (thread_id, channel_id, opener_id, opener_is_team, question, created_at, last_activity_at, status, excluded_reason)
			VALUES (?,?,?,?,?,?,?, 'open', ?)
			ON CONFLICT(thread_id) DO UPDATE SET
				last_activity_at = excluded.last_activity_at,
				question = excluded.question,
				opener_is_team = excluded.opener_is_team,
				excluded_reason = excluded.excluded_reason
		`).run(t.thread_id, t.channel_id, t.opener_id, t.opener_is_team ? 1 : 0, clip(t.question) ?? '', t.created_at, t.last_activity_at, t.excluded_reason ?? null);
	}

	/** Idempotent: real messages dedupe on the unique message_id index; synthetic events pass a stable id. */
	insertEvent(e: EventRow): void {
		this.db.prepare(`
			INSERT OR IGNORE INTO events (thread_id, message_id, ts, type, actor_id, text, data)
			VALUES (?,?,?,?,?,?,?)
		`).run(e.thread_id, e.message_id ?? null, e.ts, e.type, e.actor_id ?? null, clip(e.text as string), e.data == null ? null : JSON.stringify(e.data));
	}

	getThreads(): any[] { return this.db.prepare('SELECT * FROM threads').all(); }
	getEvents(): any[] { return this.db.prepare('SELECT thread_id, type, actor_id, ts FROM events').all(); }
	countThreads(): number { return (this.db.prepare('SELECT COUNT(*) c FROM threads').get() as any).c; }
	countEvents(): number { return (this.db.prepare('SELECT COUNT(*) c FROM events').get() as any).c; }

	// ---- Phase 3 grading ----
	getOpenThreadsForGrading(beforeMs: number, limit?: number): any[] {
		const sql = `SELECT * FROM threads WHERE status = 'open' AND last_activity_at < ? ORDER BY last_activity_at DESC${limit ? ' LIMIT ' + Number(limit) : ''}`;
		return this.db.prepare(sql).all(beforeMs);
	}
	getThreadEvents(threadId: string): any[] {
		return this.db.prepare('SELECT type, actor_id, ts, text, data FROM events WHERE thread_id = ? ORDER BY ts').all(threadId);
	}
	getClustersList(): any[] { return this.db.prepare('SELECT id, label, description FROM clusters WHERE merged_into IS NULL').all(); }
	upsertCluster(label: string, description?: string): number {
		const existing = this.db.prepare('SELECT id FROM clusters WHERE label = ? AND merged_into IS NULL').get(label) as any;
		if (existing) return existing.id;
		const info = this.db.prepare('INSERT INTO clusters (label, description, created_at) VALUES (?,?,?)').run(clip(label) ?? '', clip(description ?? '') ?? '', Date.now());
		return Number(info.lastInsertRowid);
	}
	saveGrade(threadId: string, f: { outcome: string; cause: string | null; q_top_score: number | null; a_top_score: number | null; grader_json: string; cluster_id: number | null }): void {
		this.db.prepare(`
			UPDATE threads SET outcome=?, outcome_source='auto', cause=?, cause_source='auto',
				q_top_score=?, a_top_score=?, grader_json=?, cluster_id=?, status='graded' WHERE thread_id=?
		`).run(f.outcome, f.cause, f.q_top_score, f.a_top_score, clip(f.grader_json), f.cluster_id, threadId);
	}
	saveExcluded(threadId: string, reason: string): void {
		this.db.prepare(`UPDATE threads SET outcome='excluded', outcome_source='auto', excluded_reason=?, status='graded' WHERE thread_id=?`).run(reason, threadId);
	}
	insertQaDraft(threadId: string, question: string, answer: string): void {
		this.db.prepare(`INSERT INTO qa_pairs (thread_id, question, answer, status) VALUES (?,?,?,'draft')`).run(threadId, clip(question) ?? '', clip(answer) ?? '');
	}

	// ---- Phase 4 review ----
	getReviewQueue(): any[] {
		return this.db.prepare(`
			SELECT t.*, c.label AS cluster_label FROM threads t LEFT JOIN clusters c ON c.id = t.cluster_id
			WHERE t.status = 'graded' AND t.review_message_id IS NULL
				AND (t.outcome = 'resolved_unconfirmed' OR t.outcome IN ('deferred','deferred_unanswered','overridden','dead_end','no_reply','rejected','reasked'))
			ORDER BY t.last_activity_at DESC
		`).all();
	}
	getThreadFull(threadId: string): any {
		return this.db.prepare('SELECT t.*, c.label AS cluster_label FROM threads t LEFT JOIN clusters c ON c.id = t.cluster_id WHERE t.thread_id = ?').get(threadId);
	}
	setReviewMessageId(threadId: string, messageId: string): void {
		this.db.prepare('UPDATE threads SET review_message_id = ? WHERE thread_id = ?').run(messageId, threadId);
	}
	applyReview(threadId: string, fields: { outcome?: string; cause?: string; cluster_id?: number; excluded_reason?: string }, reviewer: string): void {
		const sets: string[] = []; const vals: any[] = [];
		if (fields.outcome !== undefined) { sets.push('outcome=?', "outcome_source='review'"); vals.push(fields.outcome); }
		if (fields.cause !== undefined) { sets.push('cause=?', "cause_source='review'"); vals.push(fields.cause); }
		if (fields.cluster_id !== undefined) { sets.push('cluster_id=?'); vals.push(fields.cluster_id); }
		if (fields.excluded_reason !== undefined) { sets.push('excluded_reason=?', "outcome='excluded'", "outcome_source='review'"); vals.push(fields.excluded_reason); }
		sets.push('reviewed_by=?', 'reviewed_at=?', "status='reviewed'"); vals.push(reviewer, Date.now(), threadId);
		this.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE thread_id = ?`).run(...vals);
	}
	getLatestQaDraft(threadId: string): any { return this.db.prepare("SELECT * FROM qa_pairs WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(threadId); }
	approveQa(id: number, approver: string, question: string, answer: string): void {
		this.db.prepare("UPDATE qa_pairs SET status='approved', question=?, answer=?, approved_by=?, approved_at=? WHERE id=?").run(clip(question) ?? '', clip(answer) ?? '', approver, Date.now(), id);
	}
	getApprovedUningested(): any[] { return this.db.prepare("SELECT * FROM qa_pairs WHERE status='approved' AND ingested_at IS NULL").all(); }
	markIngested(id: number): void { this.db.prepare('UPDATE qa_pairs SET ingested_at=? WHERE id=?').run(Date.now(), id); }
	createGoldenCase(c: { question: string; expected: string; golden_answer?: string | null; source: string; thread_id?: string | null }): void {
		this.db.prepare('INSERT INTO golden_cases (question, expected, golden_answer, source, thread_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
			.run(clip(c.question) ?? '', c.expected, clip(c.golden_answer ?? null), c.source, c.thread_id ?? null, Date.now());
	}
	getActiveGolden(): any[] { return this.db.prepare('SELECT * FROM golden_cases WHERE active = 1').all(); }

	// ---- Phase 5 replay ----
	insertReplayRun(r: { started_at: number; finished_at: number; git_sha: string; pipe_sha256: string; n: number; passed: number }): number {
		const info = this.db.prepare('INSERT INTO replay_runs (started_at, finished_at, git_sha, pipe_sha256, n, passed) VALUES (?,?,?,?,?,?)').run(r.started_at, r.finished_at, r.git_sha, r.pipe_sha256, r.n, r.passed);
		return Number(info.lastInsertRowid);
	}
	insertReplayResult(r: { run_id: number; case_id: number; reply: string; escalated: number; verdict: string; escalation: string; notes: string }): void {
		this.db.prepare('INSERT OR REPLACE INTO replay_results (run_id, case_id, reply, escalated, verdict, escalation, notes) VALUES (?,?,?,?,?,?,?)')
			.run(r.run_id, r.case_id, clip(r.reply), r.escalated, r.verdict, r.escalation, clip(r.notes));
	}
	getPrevReplayVerdicts(): Map<number, string> {
		const prev = this.db.prepare('SELECT id FROM replay_runs ORDER BY id DESC LIMIT 1 OFFSET 1').get() as any;
		const m = new Map<number, string>();
		if (!prev) return m;
		for (const r of this.db.prepare('SELECT case_id, verdict FROM replay_results WHERE run_id = ?').all(prev.id) as any[]) m.set(r.case_id, r.verdict);
		return m;
	}

	// ---- live capture helpers ----
	touchThread(threadId: string, ts: number): void {
		this.db.prepare('UPDATE threads SET last_activity_at = ? WHERE thread_id = ? AND last_activity_at < ?').run(ts, threadId, ts);
	}
	/** Any new event on a graded thread reopens it for re-grading. */
	reopenThread(threadId: string): void {
		this.db.prepare(`UPDATE threads SET status = 'open' WHERE thread_id = ? AND status = 'graded'`).run(threadId);
	}

	close(): void { this.db.close(); }
}
