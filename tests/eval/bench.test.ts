import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreement, cohenKappa, consensusLabel, decisionFor, parseGrade, signalsOf, scoreModel, type CaseResult } from '../../eval/bench/score';
import { costOf, estimateTokens, project, shapeGraderWorkload, usd } from '../../eval/bench/cost';
import { anthropicBody, openaiBody, readAnthropic, readOpenai } from '../../eval/bench/providers';
import { loadPipePrompt, stratify, type GraderCase } from '../../eval/bench/tasks';
import { loadCatalog, selectable, type ModelEntry } from '../../eval/bench/config';

const entry = (over: Partial<ModelEntry> = {}): ModelEntry => ({
	key: 'test', label: 'Test', role: 'candidate',
	api: { kind: 'anthropic', baseUrl: 'https://example.invalid/v1', keyEnv: 'NOPE' },
	id: 'test-1', price: { in: 2, out: 10 }, batchDiscount: 0.5, context: 1000,
	...over,
});

// ---- parsing -------------------------------------------------------------------------------
const VALID = {
	cluster: { id: 3 }, escalation_category: null, team_reply_kind: 'correction',
	user_signal: 'neutral', llm_cause: null, qa_draft: { question: 'q', answer: 'a' }, summary: 's',
};

test('parseGrade: accepts a clean grade', () => {
	const p = parseGrade(JSON.stringify(VALID));
	assert.equal(p.schemaOk, true);
	assert.deepEqual(p.problems, []);
});
test('parseGrade: salvages JSON wrapped in prose/fences, like production does', () => {
	const p = parseGrade('Sure!\n```json\n' + JSON.stringify(VALID) + '\n```\n');
	assert.equal(p.schemaOk, true);
	assert.equal(p.obj.team_reply_kind, 'correction');
});
test('parseGrade: flags an out-of-enum label rather than passing it through', () => {
	const p = parseGrade(JSON.stringify({ ...VALID, user_signal: 'happy' }));
	assert.equal(p.schemaOk, false);
	assert.ok(p.problems.some((x) => x.startsWith('user_signal=')));
});
test('parseGrade: unparseable output is not schema-ok', () => {
	assert.equal(parseGrade('I could not do that.').schemaOk, false);
});
test('parseGrade: missing qa_draft key is a problem (null is fine)', () => {
	const { qa_draft, ...without } = VALID;
	assert.ok(parseGrade(JSON.stringify(without)).problems.includes('qa_draft missing'));
	assert.equal(parseGrade(JSON.stringify({ ...VALID, qa_draft: null })).schemaOk, true);
});

// ---- statistics ----------------------------------------------------------------------------
test('agreement counts exact matches', () => {
	assert.equal(agreement([['a', 'a'], ['a', 'b'], ['b', 'b'], ['c', 'c']]), 0.75);
});
test('cohenKappa: perfect agreement is 1, chance-level is ~0', () => {
	assert.equal(cohenKappa([['a', 'a'], ['b', 'b'], ['a', 'a'], ['b', 'b']]), 1);
	const chance = cohenKappa([['a', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'b']]);
	assert.ok(chance !== null && Math.abs(chance) < 1e-9);
});
test('cohenKappa: undefined when a rater only ever uses one label', () => {
	assert.equal(cohenKappa([['a', 'a'], ['a', 'a']]), null);
});
test('cohenKappa: punishes a majority-class guesser that raw agreement flatters', () => {
	// 9 of 10 cases are 'x'; the model always says 'x' → 90% agreement, zero skill.
	const pairs: [string, string][] = Array.from({ length: 10 }, (_, i) => ['x', i === 0 ? 'y' : 'x']);
	assert.equal(agreement(pairs), 0.9);
	assert.equal(cohenKappa(pairs), 0); // chance-corrected: 90% agreement, zero actual skill
});
test('consensusLabel: majority of the OTHER arms, null on a tie or a lone vote', () => {
	const votes = new Map([['a', 'x'], ['b', 'x'], ['c', 'y']]);
	assert.equal(consensusLabel(votes, 'c'), 'x');
	assert.equal(consensusLabel(new Map([['a', 'x'], ['b', 'y'], ['c', 'z']]), 'c'), null);
	assert.equal(consensusLabel(new Map([['a', 'x'], ['b', 'y']]), 'b'), null);
});

// ---- decisions -----------------------------------------------------------------------------
const caseFor = (over: Partial<GraderCase> = {}): GraderCase => ({
	threadId: 't1', question: 'q', input: '{}',
	thread: { opener_id: 'u1', opener_is_team: false, channel_id: 'c1' },
	events: [
		{ type: 'question', actor_id: 'u1', ts: 1 },
		{ type: 'ralph_answer', actor_id: 'bot', ts: 2 },
		{ type: 'team_reply', actor_id: 'team', ts: 3 },
	],
	reference: null, refOutcome: null, refCause: null,
	retrieval: { aTop: 0.9, overlap: true, teamAnswerExists: true },
	...over,
});

test('decisionFor: a team correction becomes overridden/bad_answer, as in production', () => {
	const d = decisionFor(caseFor(), signalsOf({ team_reply_kind: 'correction', user_signal: 'neutral' }), 0.7);
	assert.equal(d.outcome, 'overridden');
	assert.equal(d.cause, 'bad_answer');
});
test('decisionFor: the same thread with team_reply_kind=ack is a success, not a failure', () => {
	const d = decisionFor(caseFor(), signalsOf({ team_reply_kind: 'ack', user_signal: 'neutral' }), 0.7);
	assert.equal(d.outcome, 'resolved_unconfirmed');
	assert.equal(d.cause, null);
});
test('decisionFor: a weak retrieval score turns the same miss into a doc gap', () => {
	const c = caseFor({ retrieval: { aTop: 0.2, overlap: false, teamAnswerExists: true } });
	const d = decisionFor(c, signalsOf({ team_reply_kind: 'correction' }), 0.7);
	assert.equal(d.cause, 'content_gap');
});

// ---- cost ----------------------------------------------------------------------------------
test('costOf: input and output are priced separately per 1M tokens', () => {
	const c = costOf(entry(), { inTokens: 1_000_000, outTokens: 1_000_000, cachedInTokens: 0 });
	assert.equal(c.input, 2);
	assert.equal(c.output, 10);
	assert.equal(c.total, 12);
});
test('costOf: batch discount applies to both halves', () => {
	assert.equal(costOf(entry(), { inTokens: 1_000_000, outTokens: 0, cachedInTokens: 0 }, true).total, 1);
});
test('costOf: cached input bills at the cache-read rate when the model has one', () => {
	const m = entry({ price: { in: 2, out: 10, cacheRead: 0.2 } });
	assert.equal(costOf(m, { inTokens: 0, outTokens: 0, cachedInTokens: 1_000_000 }).total, 0.2);
	// no cacheRead in the price book → cached tokens bill at the full input rate (conservative)
	assert.equal(costOf(entry(), { inTokens: 0, outTokens: 0, cachedInTokens: 1_000_000 }).total, 2);
});
test('project: scales output for a thinking arm and compares against the incumbent', () => {
	const shape = { n: 1, inTokensMean: 1000, inTokensP90: 1000, outTokensMean: 100, charsPerToken: 3.9, outSource: 'default' as const };
	const plain = project(entry(), shape, 100);
	const thinking = project(entry({ options: { outTokenMultiplier: 6 } }), shape, 100, plain.perCall);
	assert.equal(plain.perCall, 0.002 + 0.001);
	assert.equal(thinking.perCall, 0.002 + 0.006);
	assert.ok(thinking.vsIncumbentPct! > 160);
	assert.equal(plain.perMonth, plain.perCall * 100);
});
test('estimateTokens rounds up and tracks the chars/token ratio', () => {
	assert.equal(estimateTokens('x'.repeat(390), 3.9), 100);
	assert.equal(estimateTokens('x'.repeat(391), 3.9), 101);
});
test('shapeGraderWorkload prefers the incumbent output size over the fallback', () => {
	const cases = [caseFor({ reference: { summary: 'x'.repeat(390), _auto_outcome: 'deferred' } })];
	const s = shapeGraderWorkload(cases, '', 3.9, 999);
	assert.equal(s.outSource, 'measured-incumbent');
	assert.ok(s.outTokensMean < 999);
	assert.equal(shapeGraderWorkload([caseFor()], '', 3.9, 999).outTokensMean, 999);
});
test('usd stays readable at sub-cent amounts', () => {
	assert.equal(usd(0), '$0');
	assert.equal(usd(0.000412), '$0.00041');
	assert.equal(usd(12.5), '$12.50');
});

// ---- provider request/response shapes ------------------------------------------------------
test('anthropicBody: temperature omitted unless the catalog sets a number (Sonnet 5 rejects it)', () => {
	const call = { system: 's', user: 'u', maxTokens: 500 };
	assert.equal('temperature' in anthropicBody(entry({ options: { temperature: null } }), call), false);
	assert.equal(anthropicBody(entry({ options: { temperature: 0 } }), call).temperature, 0);
});
test('anthropicBody: thinking + effort are passed through in the shapes the API expects', () => {
	const b = anthropicBody(entry({ options: { thinking: 'adaptive', effort: 'low' } }), { system: 's', user: 'u', maxTokens: 9 });
	assert.deepEqual(b.thinking, { type: 'adaptive' });
	assert.deepEqual(b.output_config, { effort: 'low' });
	assert.equal(b.max_tokens, 9);
});
test('openaiBody: honours the per-provider max-tokens field name', () => {
	const call = { system: 's', user: 'u', maxTokens: 700 };
	const openai = entry({ api: { kind: 'openai', baseUrl: 'x', keyEnv: 'K', maxTokensField: 'max_completion_tokens' } });
	assert.equal(openaiBody(openai, call).max_completion_tokens, 700);
	const clone = entry({ api: { kind: 'openai', baseUrl: 'x', keyEnv: 'K' } });
	assert.equal(openaiBody(clone, call).max_tokens, 700);
	assert.equal((openaiBody(openai, call).messages as any[])[0].role, 'system');
});
test('readAnthropic: cache-creation counts as input, cache reads are tracked separately', () => {
	const r = readAnthropic({
		content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '{"a":1}' }],
		stop_reason: 'end_turn',
		usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 40, output_tokens: 20 },
	});
	assert.equal(r.text, '{"a":1}');
	assert.equal(r.usage.inTokens, 110);
	assert.equal(r.usage.cachedInTokens, 40);
	assert.equal(r.usage.outTokens, 20);
});
test('readOpenai: cached tokens are subtracted from prompt_tokens, not double-counted', () => {
	const r = readOpenai({
		choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 12 } },
	});
	assert.equal(r.usage.inTokens, 60);
	assert.equal(r.usage.cachedInTokens, 40);
	assert.equal(r.usage.reasoningTokens, 12);
});

// ---- sampling + catalog --------------------------------------------------------------------
test('stratify: deterministic, and covers rare classes at small n', () => {
	const cases = [
		...Array.from({ length: 20 }, (_, i) => caseFor({ threadId: `common-${i}`, refOutcome: 'resolved_unconfirmed' })),
		caseFor({ threadId: 'rare-1', refOutcome: 'dead_end' }),
		caseFor({ threadId: 'rare-2', refOutcome: 'rejected' }),
	];
	const a = stratify(cases, 6).map((c) => c.threadId);
	const b = stratify(cases, 6).map((c) => c.threadId);
	assert.deepEqual(a, b, 'same input + n must select the same cases');
	assert.equal(a.length, 6);
	assert.ok(a.includes('rare-1') && a.includes('rare-2'), 'rare classes must survive a small sample');
	assert.equal(stratify(cases, 99).length, cases.length);
});
test('loadPipePrompt reads the live production grader prompt', () => {
	const p = loadPipePrompt('pipelines/eval-grader.pipe');
	assert.ok(p.includes('Return STRICT JSON'), 'prompt should be the grader instruction block');
	assert.ok(p.length > 500);
});
test('catalog: ids are unique, prices are positive, every runnable arm names a key env', () => {
	const c = loadCatalog();
	const keys = c.models.map((m) => m.key);
	assert.equal(new Set(keys).size, keys.length, 'duplicate catalog key');
	assert.ok(selectable(c).some((m) => m.role === 'incumbent'), 'need an incumbent to compare against');
	for (const m of selectable(c)) {
		assert.ok(m.price.in > 0 && m.price.out > 0, `${m.key} has no price`);
		assert.ok(m.api.keyEnv.length, `${m.key} has no key env`);
		assert.ok(m.id && m.id !== 'REPLACE-ME', `${m.key} has a placeholder id`);
	}
});

// ---- aggregation ---------------------------------------------------------------------------
const row = (over: Partial<CaseResult> = {}): CaseResult => ({
	caseId: 'c1', ok: true, schemaOk: true, problems: [], signals: { team_reply_kind: 'ack', user_signal: 'neutral' },
	outcome: 'deferred', cause: null, draftGiven: false, draftExpected: false,
	ms: 100, costUsd: 0.001, inTokens: 10, outTokens: 5, ...over,
});

test('scoreModel: a failed call drags down call success but is not scored as a disagreement', () => {
	const ref = new Map([['c1', { outcome: 'deferred', cause: null, fields: {} }], ['c2', { outcome: 'deferred', cause: null, fields: {} }]]);
	const s = scoreModel('m', [row(), row({ caseId: 'c2', ok: false, schemaOk: false })], ref);
	assert.equal(s.callSuccessRate, 0.5);
	assert.equal(s.schemaValidRate, 1);       // of the calls that came back, 1/1 was valid
	assert.equal(s.outcomeAgreement, 1);       // the failed call is not counted as a wrong label
	assert.equal(s.n, 2);
});
test('scoreModel: draft discipline separates missed drafts from invented ones', () => {
	const ref = new Map<string, any>();
	const s = scoreModel('m', [
		row({ caseId: 'a', draftExpected: true, draftGiven: false }),
		row({ caseId: 'b', draftExpected: false, draftGiven: true }),
		row({ caseId: 'c', draftExpected: true, draftGiven: true }),
		row({ caseId: 'd', draftExpected: false, draftGiven: false }),
	], ref);
	assert.equal(s.draftMissed, 1);
	assert.equal(s.draftInvented, 1);
	assert.equal(s.draftDisciplineRate, 0.5);
});
test('scoreModel: self-consistency is the share of cases whose repeats all agree', () => {
	const repeats = new Map([['a', ['x', 'x', 'x']], ['b', ['x', 'y', 'x']], ['c', ['z']]]);
	const s = scoreModel('m', [row()], new Map(), repeats);
	assert.equal(s.selfConsistency, 0.5); // 'c' has a single sample → not judged
});
