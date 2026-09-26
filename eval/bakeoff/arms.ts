// eval/bakeoff/arms.ts — the two arms, on identical inputs.
//
//   Arm A  Claude Sonnet 5 does grader + judge + reason (the reference, not ground truth).
//   Arm C  Jev decides; anything below THRESHOLD escalates to Sonnet 5; reason from Sonnet 5.
//
// Both arms are driven through OpenRouter so cost comes from each response's own `usage.cost`
// rather than a price table, and one key covers both. Sonnet 5 rejects `temperature`, and neither
// model exposes a seed — variance is measured with --repeats, not configured away.
import { askJev, noulSaysYes, topProbability, type Answer, type ChoiceAnswer, type NoulAnswer, type Question } from './jev';
import { loadPipePrompt } from '../bench/tasks';
import { bench } from '../bench/config';

export const SONNET = process.env.BAKEOFF_SONNET_MODEL || 'anthropic/claude-sonnet-5';
const CHAT = 'https://openrouter.ai/api/v1/chat/completions';

export interface Call { costUsd: number; ms: number; inTokens: number; outTokens: number }
const zero = (): Call => ({ costUsd: 0, ms: 0, inTokens: 0, outTokens: 0 });
const add = (a: Call, b: Call): Call => ({
	costUsd: a.costUsd + b.costUsd, ms: a.ms + b.ms,
	inTokens: a.inTokens + b.inTokens, outTokens: a.outTokens + b.outTokens,
});

/** One Sonnet call through OpenRouter. `usage.include` makes OpenRouter return the real cost. */
export async function askSonnet(apiKey: string, system: string, user: string, maxTokens = 1200): Promise<{ ok: boolean; text: string; call: Call; error?: string }> {
	const t0 = Date.now();
	try {
		const res = await fetch(CHAT, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model: SONNET,
				max_tokens: maxTokens,
				usage: { include: true },
				messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
			}),
			signal: AbortSignal.timeout(bench.timeoutMs),
		});
		const text = await res.text();
		if (!res.ok) return { ok: false, text: '', call: { ...zero(), ms: Date.now() - t0 }, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
		const j = JSON.parse(text);
		const u = j.usage ?? {};
		return {
			ok: true,
			text: String(j.choices?.[0]?.message?.content ?? ''),
			call: { costUsd: u.cost ?? 0, ms: Date.now() - t0, inTokens: u.prompt_tokens ?? 0, outTokens: u.completion_tokens ?? 0 },
		};
	} catch (e) {
		return { ok: false, text: '', call: { ...zero(), ms: Date.now() - t0 }, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Same salvage as production: first {...} block, else the whole string. */
const parseJson = (s: string): any | null => { try { const m = s.match(/\{[\s\S]*\}/); return JSON.parse(m ? m[0] : s); } catch { return null; } };

// --- the rubric, stated once and used by both arms ------------------------------------------
// Wording is lifted from pipelines/eval-grader.pipe so Jev and Sonnet are held to the same
// definitions. The pipe prompt itself is read at run time for the Sonnet arm (no copy to drift).
export const GRADER_QUESTIONS: Record<string, Question> = {
	team_reply_kind: {
		type: 'choice',
		instructions: 'Did a team member correct the bot, add to an already-correct answer, merely acknowledge, or not reply at all?',
		criteria: {
			none: 'No team member replied in the thread.',
			ack: 'A team member replied but only acknowledged — thanks, on it, a bare cross-link to another thread, or a question back to the asker.',
			correction: 'A team member contradicted or replaced what the bot said.',
			addition: 'The bot was right as far as it went and a team member added missing information.',
		},
	},
	user_signal: {
		type: 'choice',
		instructions: 'Did the person who asked confirm the answer worked, say it did not, or neither?',
		criteria: {
			confirmed: 'The asker said it worked or thanked in a way that shows it resolved.',
			rejected: 'The asker said it did not work or came back with the same problem.',
			neutral: 'Neither — the asker said nothing conclusive.',
		},
	},
	escalation_category: {
		type: 'choice',
		instructions: 'If the bot escalated to a human, what kind of question was it? Answer "knowledge" when the bot should have handled it itself, "none" when there was no escalation.',
		criteria: {
			policy_public: 'Public information could answer it — pricing, limits, live status, public event pages, public roadmap.',
			policy_account: 'Needs account access or a human decision — refunds, billing, eligibility, promo codes, account changes.',
			policy_other: 'Partnership, press, recruiting, event logistics or internal routing.',
			knowledge: 'A normal product or documentation question the bot SHOULD have answered.',
			none: 'The bot did not escalate.',
		},
	},
	llm_cause: {
		type: 'choice',
		instructions: 'Is the root cause a real product bug, a request for something that does not exist yet, or neither?',
		criteria: {
			product_defect: 'The root cause is a genuine bug in the product.',
			feature_request: 'The person wants something that has not been built.',
			none: 'Neither — it is a usage, documentation or policy matter.',
		},
	},
};

export const JUDGE_QUESTION: Record<string, Question> = {
	satisfies: {
		type: 'noul',
		instructions: 'Does the reply answer the question and cover the key points of the golden answer? Judge on substance, not wording. A shorter reply that gets there still counts as yes.',
	},
};

// Jev uses "none" where the production schema uses null.
const denull = (v: string) => (v === 'none' ? null : v);

export interface GraderOut {
	team_reply_kind?: string; user_signal?: string;
	escalation_category?: string | null; llm_cause?: string | null;
}

export interface ArmGraderResult {
	ok: boolean;
	signals: GraderOut | null;
	parseFail: boolean;
	call: Call;
	/** Arm C only: per-field top probability, and which fields escalated to Sonnet. */
	probabilities?: Record<string, Record<string, number> | number>;
	escalatedFields?: string[];
	error?: string;
}

export interface ArmJudgeResult {
	ok: boolean;
	verdict: 'pass' | 'partial' | 'fail' | null;
	parseFail: boolean;
	call: Call;
	reason?: string;
	/** Arm C only. */
	noul?: number;
	escalated?: boolean;
	error?: string;
}

// --- Arm A --------------------------------------------------------------------------------
export async function armA_grade(apiKey: string, input: string): Promise<ArmGraderResult> {
	const r = await askSonnet(apiKey, loadPipePrompt(bench.graderPipe), input);
	if (!r.ok) return { ok: false, signals: null, parseFail: false, call: r.call, error: r.error };
	const g = parseJson(r.text);
	if (!g) return { ok: true, signals: null, parseFail: true, call: r.call };
	return {
		ok: true, parseFail: false, call: r.call,
		signals: {
			team_reply_kind: g.team_reply_kind, user_signal: g.user_signal,
			escalation_category: g.escalation_category ?? null, llm_cause: g.llm_cause ?? null,
		},
	};
}

export async function armA_judge(apiKey: string, payload: { question: string; golden_answer: string; reply: string }): Promise<ArmJudgeResult> {
	const r = await askSonnet(apiKey, loadPipePrompt(bench.judgePipe), JSON.stringify(payload));
	if (!r.ok) return { ok: false, verdict: null, parseFail: false, call: r.call, error: r.error };
	const j = parseJson(r.text);
	if (!j?.verdict) return { ok: true, verdict: null, parseFail: true, call: r.call };
	return { ok: true, verdict: j.verdict, parseFail: false, call: r.call, reason: j.notes ?? '' };
}

// --- Arm C --------------------------------------------------------------------------------
export async function armC_grade(apiKey: string, input: string, threshold: number): Promise<ArmGraderResult> {
	const j = await askJev(apiKey, input, GRADER_QUESTIONS);
	if (!j.ok) return { ok: false, signals: null, parseFail: false, call: { costUsd: j.usage.costUsd, ms: j.ms, inTokens: j.usage.inTokens, outTokens: j.usage.outTokens }, error: j.error };

	let call: Call = { costUsd: j.usage.costUsd, ms: j.ms, inTokens: j.usage.inTokens, outTokens: j.usage.outTokens };
	const probs: Record<string, Record<string, number> | number> = {};
	const signals: GraderOut = {};
	const lowConfidence: string[] = [];

	for (const key of Object.keys(GRADER_QUESTIONS)) {
		const a = j.answers[key] as ChoiceAnswer | undefined;
		if (!a) { lowConfidence.push(key); continue; }
		probs[key] = a.probabilities ?? {};
		if (topProbability(a) < threshold) { lowConfidence.push(key); continue; }
		(signals as any)[key] = key === 'escalation_category' || key === 'llm_cause' ? denull(a.choice) : a.choice;
	}

	// Any field Jev was not confident about is re-decided by Sonnet, in one call for all of them.
	let escalatedFields: string[] = [];
	if (lowConfidence.length) {
		const s = await armA_grade(apiKey, input);
		call = add(call, s.call);
		escalatedFields = lowConfidence;
		if (s.signals) for (const k of lowConfidence) (signals as any)[k] = (s.signals as any)[k];
		else return { ok: true, signals: null, parseFail: true, call, probabilities: probs, escalatedFields };
	}
	return { ok: true, signals, parseFail: false, call, probabilities: probs, escalatedFields };
}

export async function armC_judge(
	apiKey: string,
	payload: { question: string; golden_answer: string; reply: string },
	threshold: number,
	reasonPolicy: 'always' | 'on-miss' | 'never',
): Promise<ArmJudgeResult> {
	const state = JSON.stringify(payload);
	const j = await askJev(apiKey, state, JUDGE_QUESTION);
	if (!j.ok) return { ok: false, verdict: null, parseFail: false, call: { costUsd: j.usage.costUsd, ms: j.ms, inTokens: j.usage.inTokens, outTokens: j.usage.outTokens }, error: j.error };

	let call: Call = { costUsd: j.usage.costUsd, ms: j.ms, inTokens: j.usage.inTokens, outTokens: j.usage.outTokens };
	const a = j.answers.satisfies as NoulAnswer | undefined;
	if (!a) return { ok: true, verdict: null, parseFail: true, call };

	let verdict: 'pass' | 'partial' | 'fail';
	let escalated = false;
	if (topProbability(a) < threshold) {
		// Not confident enough — hand the whole decision to Sonnet.
		const s = await armA_judge(apiKey, payload);
		call = add(call, s.call);
		escalated = true;
		if (!s.verdict) return { ok: true, verdict: null, parseFail: true, call, noul: a.noul, escalated };
		verdict = s.verdict;
		// Sonnet already wrote the reason as part of that call.
		return { ok: true, verdict, parseFail: false, call, noul: a.noul, escalated, reason: s.reason };
	}
	// A noul is binary, so Jev can never return `partial` — the tri-state collapses here.
	verdict = noulSaysYes(a) ? 'pass' : 'fail';

	// REASON. Unconditional makes Arm C cost the same as Arm A (the Sonnet call dominates), which
	// is why `on-miss` is the default: only losing verdicts get prose.
	let reason: string | undefined;
	const wantReason = reasonPolicy === 'always' || (reasonPolicy === 'on-miss' && verdict !== 'pass');
	if (wantReason) {
		const r = await askSonnet(
			apiKey,
			'You explain a judging decision in one short sentence. You are told the question, the golden answer, the reply under test, and the verdict that was already reached. Do not change the verdict — justify it. Reply with the sentence only.',
			`${state}\n\nVerdict: ${verdict}`,
			200,
		);
		call = add(call, r.call);
		reason = r.ok ? r.text.trim() : undefined;
	}
	return { ok: true, verdict, parseFail: false, call, noul: a.noul, escalated, reason };
}
