// eval/bench/config.ts — the ONLY reader of process.env for bench code.
// Same guardrail as eval/config.ts: nothing else under eval/bench/ touches process.env.
// Shared settings (db path, pipe paths, match score) are re-exported from the eval config
// rather than re-read, so the bench can never drift from what production grading uses.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { config as evalConfig } from '../config';

const num = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export interface Price { in: number; out: number; cacheRead?: number; cacheWrite?: number }
export interface ModelApi {
	kind: 'anthropic' | 'openai';
	baseUrl: string;
	/** Env var holding the API key. A list is tried in order — first one set wins. */
	keyEnv: string | string[];
	/** OpenAI-compatible only. Newer OpenAI models take `max_completion_tokens`; most clones still take `max_tokens`. */
	maxTokensField?: 'max_tokens' | 'max_completion_tokens';
}
export interface ModelEntry {
	key: string;
	label: string;
	role: 'incumbent' | 'candidate' | 'candidate-reference' | 'template';
	enabled?: boolean;
	api: ModelApi;
	id: string;
	price: Price;
	/** Fraction off list when run through the provider's batch API (0 = no batch API). */
	batchDiscount: number;
	context: number;
	options?: {
		thinking?: 'disabled' | 'adaptive';
		effort?: string;
		temperature?: number | null;
		/** Estimate-mode only: reasoning models bill hidden thinking as output. A measured run overrides this. */
		outTokenMultiplier?: number;
	};
	note?: string;
	source?: string;
}
export interface Catalog {
	asof: string;
	defaults: { charsPerToken: number; maxTokens: number };
	models: ModelEntry[];
}

export const bench = {
	// shared with production eval code (read-only here)
	dbPath: evalConfig.dbPath,
	graderPipe: evalConfig.graderPipe,
	judgePipe: evalConfig.judgePipe,
	matchScore: evalConfig.matchScore,
	windowDays: evalConfig.windowDays,
	testAllowBotIds: evalConfig.testAllowBotIds,

	// bench-only
	catalogPath: process.env.BENCH_CATALOG || 'eval/bench/pricing.json',
	outDir: process.env.BENCH_OUT_DIR || 'logs/bench',
	goldPath: process.env.BENCH_GOLD || 'logs/bench/gold.jsonl',
	concurrency: num(process.env.BENCH_CONCURRENCY, 3),
	timeoutMs: num(process.env.BENCH_TIMEOUT_MS, 120_000),
	maxRetries: num(process.env.BENCH_MAX_RETRIES, 3),
};

let cached: Catalog | null = null;
/** Load the model catalog. Paths resolve from the repo root — run bench commands from there. */
export function loadCatalog(path = bench.catalogPath): Catalog {
	if (cached && path === bench.catalogPath) return cached;
	let raw: string;
	try { raw = readFileSync(path, 'utf8'); }
	catch { throw new Error(`catalog not found at ${path} (run bench commands from the repo root, or set BENCH_CATALOG)`); }
	const c = JSON.parse(raw) as Catalog;
	if (!Array.isArray(c.models) || !c.models.length) throw new Error(`catalog ${path} has no models`);
	if (path === bench.catalogPath) cached = c;
	return c;
}

/** Models that are runnable candidates (templates and explicitly disabled rows are skipped). */
export const selectable = (c: Catalog): ModelEntry[] => c.models.filter((m) => m.role !== 'template' && m.enabled !== false);

/** Env var names an entry will accept, in priority order. */
export const keyEnvNames = (m: ModelEntry): string[] => (Array.isArray(m.api.keyEnv) ? m.api.keyEnv : [m.api.keyEnv]);

/** The API key for an entry, or undefined when none of its env vars are set. The only place bench code reads a secret. */
export const keyFor = (m: ModelEntry): string | undefined => {
	for (const name of keyEnvNames(m)) { const v = process.env[name]; if (v) return v; }
	return undefined;
};
