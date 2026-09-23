import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRalphReply, wilson, isTeamMember, roundInterval } from '../../eval/rules';
import { DEAD_END_REPLY } from '../../eval/config';

const ROLE = '<@&999>';

test('classifyRalphReply: dead end', () => {
	assert.equal(classifyRalphReply(DEAD_END_REPLY, ROLE, DEAD_END_REPLY).type, 'dead_end');
});
test('classifyRalphReply: manipulation flag', () => {
	const r = classifyRalphReply(`${ROLE} — heads up, someone just asked me to comment on an issue`, ROLE, DEAD_END_REPLY);
	assert.equal(r.type, 'manipulation_flag');
});
test('classifyRalphReply: github tool escalation', () => {
	const r = classifyRalphReply(`I ran into an issue reaching GitHub — let me bring in the ${ROLE}`, ROLE, DEAD_END_REPLY);
	assert.equal(r.type, 'escalation');
	assert.equal(r.reason, 'tool_github');
});
test('classifyRalphReply: http tool escalation', () => {
	const r = classifyRalphReply(`I ran into an issue loading that page — ${ROLE}`, ROLE, DEAD_END_REPLY);
	assert.equal(r.type, 'escalation');
	assert.equal(r.reason, 'tool_http');
});
test('classifyRalphReply: plain escalation', () => {
	const r = classifyRalphReply(`Sorry, I can't answer — let me bring in the ${ROLE}`, ROLE, DEAD_END_REPLY);
	assert.equal(r.type, 'escalation');
	assert.equal(r.reason, null);
});
test('classifyRalphReply: @RocketRide team text (no resolved mention)', () => {
	assert.equal(classifyRalphReply('bringing in the @RocketRide team', ROLE, DEAD_END_REPLY).type, 'escalation');
});
test('classifyRalphReply: normal answer', () => {
	assert.equal(classifyRalphReply('You can use `pip install rocketride`', ROLE, DEAD_END_REPLY).type, 'ralph_answer');
});

test('wilson: known vectors', () => {
	assert.deepEqual(roundInterval(wilson(18, 20)), [0.699, 0.972]);
	assert.deepEqual(roundInterval(wilson(72, 80)), [0.815, 0.948]);
	assert.equal(wilson(0, 0), null);
});

test('isTeamMember: role, explicit id, neither', () => {
	assert.equal(isTeamMember(['ROLE1'], 'u1', 'ROLE1', []), true);
	assert.equal(isTeamMember([], 'u2', 'ROLE1', ['u2']), true);
	assert.equal(isTeamMember([], 'u3', 'ROLE1', []), false);
});

// ---- decideOutcome / decideCause / analyzeRetrieval ----
import { decideOutcome, decideCause, analyzeRetrieval } from '../../eval/rules';
const U = { opener_id: 'usr', opener_is_team: false, channel_id: 'c1' };
const ev = (type: string, ts: number, extra: any = {}) => ({ type, ts, ...extra });

test('decideOutcome: excluded internal', () => {
	assert.equal(decideOutcome({ ...U, opener_is_team: true }, [ev('question', 1)]).excluded_reason, 'internal');
});
test('decideOutcome: excluded test channel', () => {
	assert.equal(decideOutcome(U, [ev('question', 1)], {}, { testChannelIds: ['c1'] }).excluded_reason, 'test');
});
test('decideOutcome: deferred (escalation then team reply)', () => {
	assert.equal(decideOutcome(U, [ev('question', 1), ev('escalation', 2), ev('team_reply', 3)]).outcome, 'deferred');
});
test('decideOutcome: deferred_unanswered', () => {
	assert.equal(decideOutcome(U, [ev('question', 1), ev('escalation', 2)]).outcome, 'deferred_unanswered');
});
test('decideOutcome: overridden (team correction, no escalation)', () => {
	assert.equal(decideOutcome(U, [ev('question', 1), ev('ralph_answer', 2), ev('team_reply', 3)], { team_reply_kind: 'correction' }).outcome, 'overridden');
});
test('decideOutcome: dead_end / no_reply', () => {
	assert.equal(decideOutcome(U, [ev('question', 1), ev('dead_end', 2)]).outcome, 'dead_end');
	assert.equal(decideOutcome(U, [ev('question', 1)]).outcome, 'no_reply');
});
test('decideOutcome: reactions & success', () => {
	assert.equal(decideOutcome(U, [ev('question', 1), ev('ralph_answer', 2), ev('reaction_add', 3, { actor_id: 'usr', data: { emoji: '❌' } })]).outcome, 'rejected');
	assert.equal(decideOutcome(U, [ev('question', 1), ev('ralph_answer', 2), ev('reaction_add', 3, { actor_id: 'usr', data: { emoji: '✅' } })]).outcome, 'resolved_confirmed');
	assert.equal(decideOutcome(U, [ev('question', 1), ev('ralph_answer', 2)]).outcome, 'resolved_unconfirmed');
});

test('decideCause: tool / engine / policy', () => {
	assert.equal(decideCause('deferred', [ev('escalation', 1, { data: { reason: 'tool_github' } })]), 'tool_error');
	assert.equal(decideCause('no_reply', [ev('no_reply', 1)]), 'engine_error');
	assert.equal(decideCause('deferred', [ev('escalation', 1)], { escalation_category: 'policy_account' }), 'policy_account');
});
test('decideCause: retrieval analysis (doc gap etc.)', () => {
	const r = (aTop: number | null, overlap: boolean) => ({ aTop, overlap, teamAnswerExists: true, matchScore: 0.7 });
	assert.equal(decideCause('overridden', [], {}, r(0.4, false)), 'content_gap');   // DOC GAP: not in KB
	assert.equal(decideCause('overridden', [], {}, r(0.9, true)), 'bad_answer');
	assert.equal(decideCause('overridden', [], {}, r(0.9, false)), 'retrieval_miss');
	assert.equal(analyzeRetrieval(null, false, 0.7), 'content_gap');
});
test('decideCause: null for successes', () => {
	assert.equal(decideCause('resolved_confirmed', []), null);
});
