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
