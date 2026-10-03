// eval/bench/providers.ts — one thin adapter per API shape, driven entirely by the catalog.
// Two shapes cover every candidate: Anthropic Messages, and OpenAI-compatible /chat/completions
// (OpenAI, Groq, xAI, DeepSeek, OpenRouter, Together, Fireworks... all speak it).
//
// Deliberately NOT using structured-output / JSON modes: production (eval-grader.pipe) asks for
// strict JSON in the prompt and parses what comes back, so the bench does the same. "Did it return
// parseable JSON" is a real difference between models and we want to measure it, not paper over it.
import { keyEnvNames, keyFor, type ModelEntry } from './config';

export interface LlmCall { system: string; user: string; maxTokens: number }
export interface LlmUsage { inTokens: number; outTokens: number; cachedInTokens: number; reasoningTokens: number }
export interface LlmResult {
	ok: boolean;
	text: string;
	usage: LlmUsage;
	ms: number;
	attempts: number;
	finishReason?: string;
	error?: string;
}

const ZERO: LlmUsage = { inTokens: 0, outTokens: 0, cachedInTokens: 0, reasoningTokens: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

class HttpError extends Error {
	constructor(readonly status: number, readonly body: string, readonly retryAfterMs?: number) {
		super(`HTTP ${status}: ${body.slice(0, 300)}`);
	}
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	if (!res.ok) {
		const ra = Number(res.headers.get('retry-after'));
		throw new HttpError(res.status, text, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
	}
	return JSON.parse(text);
}

export function anthropicBody(m: ModelEntry, call: LlmCall): Record<string, unknown> {
	const o = m.options ?? {};
	const body: Record<string, unknown> = {
		model: m.id,
		max_tokens: call.maxTokens,
		system: call.system,
		messages: [{ role: 'user', content: call.user }],
	};
	// Sonnet 5 / Opus 5 reject temperature outright, so it is opt-in per catalog entry.
	if (typeof o.temperature === 'number') body.temperature = o.temperature;
	if (o.thinking) body.thinking = { type: o.thinking };
	if (o.effort) body.output_config = { effort: o.effort };
	return body;
}

export function openaiBody(m: ModelEntry, call: LlmCall): Record<string, unknown> {
	const o = m.options ?? {};
	const body: Record<string, unknown> = {
		model: m.id,
		messages: [
			{ role: 'system', content: call.system },
			{ role: 'user', content: call.user },
		],
	};
	body[m.api.maxTokensField ?? 'max_tokens'] = call.maxTokens;
	if (typeof o.temperature === 'number') body.temperature = o.temperature;
	return body;
}

export function readAnthropic(json: any): { text: string; usage: LlmUsage; finishReason?: string } {
	const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
	const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
	const u = json?.usage ?? {};
	return {
		text,
		finishReason: json?.stop_reason,
		usage: {
			inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
			outTokens: u.output_tokens ?? 0,
			cachedInTokens: u.cache_read_input_tokens ?? 0,
			reasoningTokens: 0, // Anthropic bills thinking inside output_tokens
		},
	};
}

export function readOpenai(json: any): { text: string; usage: LlmUsage; finishReason?: string } {
	const choice = json?.choices?.[0];
	const u = json?.usage ?? {};
	const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
	return {
		text: String(choice?.message?.content ?? ''),
		finishReason: choice?.finish_reason,
		usage: {
			inTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
			outTokens: u.completion_tokens ?? 0,
			cachedInTokens: cached,
			reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
		},
	};
}

/** One call, with retry on transient failures. Never throws — failures come back as ok:false. */
export async function callModel(
	m: ModelEntry,
	call: LlmCall,
	opts: { timeoutMs: number; maxRetries: number },
): Promise<LlmResult> {
	const key = keyFor(m);
	if (!key) return { ok: false, text: '', usage: { ...ZERO }, ms: 0, attempts: 0, error: `${keyEnvNames(m).join(' / ')} not set` };

	const anthropic = m.api.kind === 'anthropic';
	const url = `${m.api.baseUrl.replace(/\/$/, '')}${anthropic ? '/messages' : '/chat/completions'}`;
	const headers = anthropic
		? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
		: { authorization: `Bearer ${key}` };
	const body = anthropic ? anthropicBody(m, call) : openaiBody(m, call);

	const t0 = Date.now();
	let lastErr = '';
	for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
		try {
			const json = await post(url, headers, body, opts.timeoutMs);
			const r = anthropic ? readAnthropic(json) : readOpenai(json);
			return { ok: true, ...r, ms: Date.now() - t0, attempts: attempt };
		} catch (e) {
			const http = e instanceof HttpError ? e : null;
			lastErr = e instanceof Error ? e.message : String(e);
			const retryable = !http || RETRY_STATUS.has(http.status);
			if (!retryable || attempt === opts.maxRetries) break;
			// exponential backoff with jitter; honour Retry-After when the provider sends one
			await sleep(http?.retryAfterMs ?? Math.min(30_000, 2 ** attempt * 500 + Math.random() * 400));
		}
	}
	return { ok: false, text: '', usage: { ...ZERO }, ms: Date.now() - t0, attempts: opts.maxRetries, error: lastErr };
}

/** GET the provider's model list — used by --verify-models to catch stale ids before a paid run. */
export async function listModelIds(m: ModelEntry, timeoutMs: number): Promise<{ ok: boolean; ids?: string[]; error?: string }> {
	const key = keyFor(m);
	if (!key) return { ok: false, error: `${keyEnvNames(m).join(' / ')} not set` };
	const anthropic = m.api.kind === 'anthropic';
	try {
		const res = await fetch(`${m.api.baseUrl.replace(/\/$/, '')}/models?limit=100`, {
			headers: anthropic ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
		const json = JSON.parse(text);
		const ids: string[] = (json?.data ?? json?.models ?? []).map((x: any) => x?.id).filter(Boolean);
		return { ok: true, ids };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
