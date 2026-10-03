// eval/bakeoff/sonnet.ts — Arm A's model, over whichever backend has a key.
//
// Anthropic direct is preferred when ANTHROPIC_API_KEY is set; OpenRouter is the fallback. The
// difference that matters is cost reporting: OpenRouter returns `usage.cost` per response, while
// Anthropic returns token counts only. So for the Anthropic path we take the MEASURED tokens and
// multiply by LIVE per-token prices fetched from OpenRouter's models API at start-up — nothing is
// hardcoded, and nothing is estimated except the multiplication itself.
//
// Sonnet 5 specifics: it rejects `temperature` outright (400), and omitting `thinking` runs
// adaptive thinking, whose tokens bill as output. Production's grader does no extended thinking,
// so the default here is thinking disabled — like for like. `--thinking adaptive` tests the ceiling.
export const SONNET_ANTHROPIC = process.env.BAKEOFF_SONNET_MODEL_ANTHROPIC || 'claude-sonnet-5';
export const SONNET_OPENROUTER = process.env.BAKEOFF_SONNET_MODEL || 'anthropic/claude-sonnet-5';

export interface Call { costUsd: number; ms: number; inTokens: number; outTokens: number }
export interface SonnetResult { ok: boolean; text: string; call: Call; backend: string; error?: string }

export interface Prices { inPerToken: number; outPerToken: number; source: string; asof: string }
let prices: Prices | null = null;

/** Live Sonnet 5 prices from OpenRouter's public models API (no key needed). Fetched once. */
export async function livePrices(): Promise<Prices> {
	if (prices) return prices;
	const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`could not fetch live prices: HTTP ${res.status}`);
	const m = (await res.json()).data.find((x: any) => x.id === SONNET_OPENROUTER);
	if (!m) throw new Error(`${SONNET_OPENROUTER} not found in OpenRouter's model list`);
	prices = {
		inPerToken: Number(m.pricing.prompt),
		outPerToken: Number(m.pricing.completion),
		source: 'openrouter /api/v1/models',
		asof: new Date().toISOString(),
	};
	return prices;
}

export interface SonnetOpts { thinking?: 'disabled' | 'adaptive'; maxTokens?: number; timeoutMs?: number }

export async function askSonnet(system: string, user: string, opts: SonnetOpts = {}): Promise<SonnetResult> {
	const maxTokens = opts.maxTokens ?? 1200;
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const orKey = process.env.OPENROUTER_API_KEY;
	const t0 = Date.now();

	if (anthropicKey) {
		try {
			const body: Record<string, unknown> = {
				model: SONNET_ANTHROPIC,
				max_tokens: maxTokens,
				system,
				messages: [{ role: 'user', content: user }],
				thinking: { type: opts.thinking ?? 'disabled' },
			};
			const res = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await res.text();
			if (!res.ok) return { ok: false, text: '', call: { costUsd: 0, ms: Date.now() - t0, inTokens: 0, outTokens: 0 }, backend: 'anthropic', error: `HTTP ${res.status}: ${text.slice(0, 250)}` };
			const j = JSON.parse(text);
			const u = j.usage ?? {};
			const inTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
			const outTokens = u.output_tokens ?? 0;
			const p = await livePrices();
			return {
				ok: true,
				text: (j.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join(''),
				call: { costUsd: inTokens * p.inPerToken + outTokens * p.outPerToken, ms: Date.now() - t0, inTokens, outTokens },
				backend: 'anthropic',
			};
		} catch (e) {
			return { ok: false, text: '', call: { costUsd: 0, ms: Date.now() - t0, inTokens: 0, outTokens: 0 }, backend: 'anthropic', error: e instanceof Error ? e.message : String(e) };
		}
	}

	if (!orKey) return { ok: false, text: '', call: { costUsd: 0, ms: 0, inTokens: 0, outTokens: 0 }, backend: 'none', error: 'neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set' };
	try {
		const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${orKey}` },
			body: JSON.stringify({ model: SONNET_OPENROUTER, max_tokens: maxTokens, usage: { include: true }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		if (!res.ok) return { ok: false, text: '', call: { costUsd: 0, ms: Date.now() - t0, inTokens: 0, outTokens: 0 }, backend: 'openrouter', error: `HTTP ${res.status}: ${text.slice(0, 250)}` };
		const j = JSON.parse(text);
		const u = j.usage ?? {};
		return {
			ok: true,
			text: String(j.choices?.[0]?.message?.content ?? ''),
			call: { costUsd: u.cost ?? 0, ms: Date.now() - t0, inTokens: u.prompt_tokens ?? 0, outTokens: u.completion_tokens ?? 0 },
			backend: 'openrouter',
		};
	} catch (e) {
		return { ok: false, text: '', call: { costUsd: 0, ms: Date.now() - t0, inTokens: 0, outTokens: 0 }, backend: 'openrouter', error: e instanceof Error ? e.message : String(e) };
	}
}
