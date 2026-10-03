import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../eval/store';
import { buildWeeklySummary } from '../../eval/review';

const now = Date.now();
const thread = (id: string) => ({ thread_id: id, channel_id: 'c1', opener_id: 'u1', opener_is_team: 0, question: 'q', created_at: now, last_activity_at: now });
const grade = (s: Store, id: string, cause: string) =>
	s.saveGrade(id, { outcome: 'deferred', cause, q_top_score: 0.5, a_top_score: null, grader_json: JSON.stringify({ _auto_outcome: 'deferred', _auto_cause: cause }), cluster_id: null });
const agreement = (s: Store) => (buildWeeklySummary(s) as any).data.fields.find((f: any) => f.name === 'Grader agreement')?.value;

// Clicking 👍 "Yes, a miss" is the reviewer AGREEING with the grader's reason, and it re-writes the
// same cause so the thread lands in this denominator. Before that, only a dropdown CHANGE set
// cause_source='review' — so agreement was computed on corrections alone and read low by
// construction, ignoring every cheap confirmation.
test('review: confirming a miss counts as grader agreement, correcting it does not', () => {
	const s = new Store(':memory:');
	s.upsertThread(thread('t1'));
	grade(s, 't1', 'content_gap');
	assert.equal(agreement(s), 'n/a', 'nothing reviewed yet');

	// what the confirm button now does: re-write the identical cause
	s.applyReview('t1', { cause: 'content_gap' }, 'josh');
	assert.equal(agreement(s), '100.0% (1/1)', 'a confirmed grade is an agreement');

	// a corrected reason still has to read as a disagreement
	s.upsertThread(thread('t2'));
	grade(s, 't2', 'content_gap');
	s.applyReview('t2', { cause: 'product_defect' }, 'josh');
	assert.equal(agreement(s), '50.0% (1/2)', 'one agreed, one corrected');

	// a success carries no cause, so confirming it must not enter the denominator at all
	s.upsertThread(thread('t3'));
	s.saveGrade('t3', { outcome: 'resolved_confirmed', cause: null, q_top_score: 0.9, a_top_score: 0.9, grader_json: '{}', cluster_id: null });
	s.applyReview('t3', {}, 'josh');
	assert.equal(agreement(s), '50.0% (1/2)', 'unchanged by a confirmed success');
	s.close();
});
