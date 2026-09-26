// eval/bakeoff/jev.ts — OpenRouter's System One / Decisions API (TypeSafe Jev).
//
// Jev is NOT a chat model and must not be sent to /chat/completions. It takes a `state` (the text
// to reason over) plus typed questions, and returns typed answers with calibrated probabilities:
//
//   POST https://openrouter.ai/api/v1/systemone
//   { model, state, questions: { key: { type: "choice"|"noul", instructions, criteria? } } }
//   → { answers: { key: {type:"choice", choice, probabilities:{...}, confidence} | {type:"noul", noul} },
//       usage: { input_tokens, output_tokens, cost } }
//
// The model id is the BARE TypeSafe id (`jev-1.13`); the API maps it onto OpenRouter's `typesafe/`
// namespace itself. We pin 1.13 rather than jev-latest so the comparison can't shift mid-run.
// There is no seed or temperature parameter — run-to-run variance is measured, not eliminated.
import { bench } from '../bench/config';

export const JEV_MODEL = process.env.BAKEOFF_JEV_MODEL || 'jev-1.13';
const URL = 'https://openrouter.ai/api/v1/systemone';

export type Question =
	| { type: 'choice'; instructions: string; criteria: Record<string, string> }
	| { type: 'noul'; instructions: string };

export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface NoulAnswer { type: 'noul'; noul: number }
export type Answer = ChoiceAnswer | NoulAnswer;

export interface JevResult {
	ok: boolean;
	answers: Record<string, Answer>;
	usage: { inTokens: number; outTokens: number; costUsd: number };
	ms: number;
	model?: string;
	error?: string;
}

const RETRY = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The winning option's probability — what THRESHOLD is compared against. */
export function topProbability(a: Answer): number {
	if (a.type === 'noul') return Math.max(a.noul, 1 - a.noul); // distance from the coin flip
	const p = Object.values(a.probabilities ?? {});
	return p.length ? Math.max(...p) : (a.confidence ?? 0);
}

/** A noul is a yes/no probability; >0.5 means yes. */
export const noulSaysYes = (a: NoulAnswer): boolean => a.noul > 0.5;

export async function askJev(
	apiKey: string,
	state: string,
	questions: Record<string, Question>,
	opts: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<JevResult> {
	const timeoutMs = opts.timeoutMs ?? bench.timeoutMs;
	const maxRetries = opts.maxRetries ?? bench.maxRetries;
	const body = { model: JEV_MODEL, state, questions };
	const t0 = Date.now();
	let last = '';
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const res = await fetch(URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await res.text();
			if (!res.ok) {
				last = `HTTP ${res.status}: ${text.slice(0, 200)}`;
				if (!RETRY.has(res.status) || attempt === maxRetries) break;
				await sleep(Math.min(30_000, 2 ** attempt * 500 + Math.random() * 400));
				continue;
			}
			const j = JSON.parse(text);
			return {
				ok: true,
				answers: j.answers ?? {},
				usage: {
					inTokens: j.usage?.input_tokens ?? 0,
					outTokens: j.usage?.output_tokens ?? 0,
					costUsd: j.usage?.cost ?? 0,
				},
				ms: Date.now() - t0,
				model: j.model,
			};
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
			if (attempt === maxRetries) break;
			await sleep(Math.min(30_000, 2 ** attempt * 500 + Math.random() * 400));
		}
	}
	return { ok: false, answers: {}, usage: { inTokens: 0, outTokens: 0, costUsd: 0 }, ms: Date.now() - t0, error: last };
}
