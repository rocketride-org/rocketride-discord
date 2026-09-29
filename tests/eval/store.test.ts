import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../eval/store';

const thread = (id: string) => ({ thread_id: id, channel_id: 'c1', opener_id: 'u1', opener_is_team: 0, question: 'q', created_at: 1, last_activity_at: 1 });

test('store: thread upsert is idempotent', () => {
	const s = new Store(':memory:');
	s.upsertThread(thread('t1'));
	s.upsertThread({ ...thread('t1'), last_activity_at: 2 });
	assert.equal(s.countThreads(), 1);
	s.close();
});

test('store: event insert dedupes on message_id', () => {
	const s = new Store(':memory:');
	s.upsertThread(thread('t1'));
	s.insertEvent({ thread_id: 't1', message_id: 'm1', ts: 1, type: 'ralph_answer' });
	s.insertEvent({ thread_id: 't1', message_id: 'm1', ts: 1, type: 'ralph_answer' });
	assert.equal(s.countEvents(), 1);
	s.close();
});

test('store: synthetic event with stable id dedupes; null message_id allows many', () => {
	const s = new Store(':memory:');
	s.upsertThread(thread('t1'));
	s.insertEvent({ thread_id: 't1', message_id: 'synthetic:t1:noreply', ts: 1, type: 'no_reply', data: { kind: 'backfill_unknown' } });
	s.insertEvent({ thread_id: 't1', message_id: 'synthetic:t1:noreply', ts: 1, type: 'no_reply', data: { kind: 'backfill_unknown' } });
	assert.equal(s.countEvents(), 1);
	s.close();
});

// Regression: "Teach Ralph the answer" on a thread the grader never drafted for (nobody from the
// team had answered) used to skip the KB write silently — the answer reached nothing.
test('store: a hand-written Q/A with no grader draft still becomes ingestable', () => {
	const s = new Store(':memory:');
	s.upsertThread(thread('t1'));
	assert.equal(s.getLatestQaDraft('t1'), undefined, 'no draft to start');

	const id = s.insertQaDraft('t1', 'How do I install it?', 'Run npm install rocketride.');
	assert.ok(id > 0, 'insertQaDraft returns the new row id');
	s.approveQa(id, 'reviewer', 'How do I install it?', 'Run npm install rocketride.');

	const pending = s.getApprovedUningested();
	assert.equal(pending.length, 1);
	assert.equal(pending[0].answer, 'Run npm install rocketride.');

	// Once ingested it is not offered again.
	s.markIngested(id);
	assert.equal(s.getApprovedUningested().length, 0);
	s.close();
});

// Re-teaching the same thread must add a NEW pair, not edit an already-ingested row that
// getApprovedUningested() would never return again.
test('store: an already-ingested pair is detectable so re-teaching creates a new one', () => {
	const s = new Store(':memory:');
	s.upsertThread(thread('t1'));
	const first = s.insertQaDraft('t1', 'q1', 'a1');
	s.approveQa(first, 'reviewer', 'q1', 'a1');
	s.markIngested(first);

	const latest = s.getLatestQaDraft('t1');
	assert.ok(latest.ingested_at, 'latest pair is flagged as ingested');

	const second = s.insertQaDraft('t1', 'q1', 'a1 corrected');
	s.approveQa(second, 'reviewer', 'q1', 'a1 corrected');
	const pending = s.getApprovedUningested();
	assert.equal(pending.length, 1);
	assert.equal(pending[0].answer, 'a1 corrected');
	s.close();
});

// The review card shows who taught Ralph an answer and whether it reached the KB, so every query
// that feeds a card has to carry the latest APPROVED pair. A draft must not light it up, and
// re-teaching has to move the card onto the newer pair.
test('store: card queries expose the latest approved Q/A, not drafts', () => {
	const s = new Store(':memory:');
	s.upsertThread(thread('t1'));
	s.saveGrade('t1', { outcome: 'rejected', cause: 'content_gap', q_top_score: 0.5, a_top_score: null, grader_json: '{}', cluster_id: null });

	const first = s.insertQaDraft('t1', 'q', 'a');
	assert.equal(s.getThreadFull('t1').qa_approved_by, null, 'a draft is not a taught answer');
	assert.equal(s.getReviewQueue()[0].qa_approved_by, null, 'and not on a queued card either');

	s.approveQa(first, 'josh', 'q', 'a');
	assert.equal(s.getThreadFull('t1').qa_approved_by, 'josh');
	assert.equal(s.getThreadFull('t1').qa_ingested_at, null, 'approved, not yet in the KB');

	s.markIngested(first);
	assert.ok(s.getThreadFull('t1').qa_ingested_at, 'reaching the KB is visible on the card');

	// Re-teaching adds a pair rather than editing the ingested one, so the card follows the new one.
	const second = s.insertQaDraft('t1', 'q', 'a corrected');
	s.approveQa(second, 'mith', 'q', 'a corrected');
	const row = s.getThreadFull('t1');
	assert.equal(row.qa_approved_by, 'mith');
	assert.equal(row.qa_ingested_at, null, 'the newer pair has not been ingested yet');

	// getCardedThreads() renders already-posted cards, so it needs the same columns.
	s.setReviewMessageId('t1', 'm1');
	assert.equal(s.getCardedThreads()[0].qa_approved_by, 'mith');
	s.close();
});
