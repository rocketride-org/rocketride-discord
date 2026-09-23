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
