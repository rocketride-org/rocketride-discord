// eval/ingest.ts — Phase 6a. Feed APPROVED Q/A pairs into Ralph's KB via rag.pipe (→ ROCKETRIDE_DOCS).
// Only approved, un-ingested pairs are sent; re-ingest by the same name replaces (verified in Phase 0),
// so a pair is only ever ingested once (guarded by ingested_at). Writes to the PROD KB — gated on review approval.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RocketRideClient } from 'rocketride';
import { config } from './config';
import { detectEngineUri } from './engine';
import type { Store } from './store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Log = (...a: unknown[]) => void;

export interface IngestedPair { id: number; thread_id: string | null }

/**
 * Serialises ingest runs. Teaching several answers in a row fires one handler per click, and each
 * one calls this — concurrently they raced over the same rag.pipe instance. Queueing also makes the
 * "who ingested what" answer unambiguous, which the callers rely on to refresh the right cards.
 */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Reconcile the store against the KB: any pair claiming to be ingested whose document is not
 * actually in the collection gets un-marked, so the next ingest run retries it and its card stops
 * claiming the answer is live. Needed because marking used to happen whether or not the write
 * landed. Read-only against the KB; only the store is corrected.
 */
export async function verifyIngested(store: Store, opts: { log: Log }): Promise<{ unmarked: number[]; remarked: number[] }> {
	const { log } = opts;
	const unmarked: number[] = [], remarked: number[] = [];
	// Claims to be in the KB but is not -> un-mark, so the next run retries it.
	for (const qa of store.getIngested()) {
		if (await isInKb(`ralph-qa-${qa.id}.md`)) continue;
		store.unmarkIngested(qa.id);
		unmarked.push(qa.id);
		log(`qa ${qa.id}: marked ingested but NOT in ${config.docsCollection} — un-marked for retry`);
	}
	// Is in the KB but not marked -> mark it, so a retry does not re-write a document already there.
	for (const qa of store.getApprovedUningested()) {
		if (!(await isInKb(`ralph-qa-${qa.id}.md`))) continue;
		store.markIngested(qa.id);
		remarked.push(qa.id);
		log(`qa ${qa.id}: already in ${config.docsCollection} — marked ingested`);
	}
	log(`verify-kb done: ${unmarked.length} un-marked, ${remarked.length} marked`);
	return { unmarked, remarked };
}

export function ingestApproved(store: Store, opts: { log: Log }): Promise<IngestedPair[]> {
	const run = chain.then(() => ingestNow(store, opts), () => ingestNow(store, opts));
	chain = run.catch(() => {});
	return run;
}

/**
 * Returns the pairs it ingested — NOT just a count. A run picks up every pending pair, so the pair
 * it writes is often not the one whose click triggered it; the caller needs the thread ids to
 * refresh those cards, or they sit on "adding it to Ralph's KB…" forever with nobody to update them.
 */
/**
 * Is this document actually in the KB collection?
 *
 * The task-status poll below never reports completion — it runs out all 60 attempts every time —
 * so "the loop ended" is no evidence the write landed. A pair was once marked ingested whose
 * document never reached the collection at all, which made the review card claim an answer was in
 * Ralph's KB when it was not. Marking is now gated on this check instead.
 */
async function isInKb(name: string): Promise<boolean> {
	let offset: unknown;
	for (let page = 0; page < 40; page++) {
		const res = await fetch(`${config.qdrantUrl}/collections/${config.docsCollection}/points/scroll`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ limit: 256, with_payload: ['meta'], with_vector: false, offset }),
		});
		const j: any = await res.json();
		const pts: any[] = j?.result?.points ?? [];
		// meta is an OBJECT when selected by field name (and a stringified dict with with_payload:true),
		// so stringify rather than String() — the latter yields "[object Object]" and never matches.
		if (pts.some((p) => JSON.stringify(p?.payload?.meta ?? '').includes(name))) return true;
		offset = j?.result?.next_page_offset;
		if (!offset) return false;
	}
	return false;
}

async function ingestNow(store: Store, opts: { log: Log }): Promise<IngestedPair[]> {
	const { log } = opts;
	const pending = store.getApprovedUningested();
	if (!pending.length) { log('no approved, un-ingested Q/A pairs'); return []; }
	const rr = new RocketRideClient({ uri: detectEngineUri(), auth: config.rocketrideApiKey } as any);
	await rr.connect();
	const done: IngestedPair[] = [];
	try {
		try { const prev = await rr.use({ filepath: config.ragPipe, useExisting: true }); await rr.terminate(prev.token); } catch {}
		const { token } = await rr.use({ filepath: config.ragPipe });
		for (const qa of pending) {
			const name = `ralph-qa-${qa.id}.md`;
			const file = join(tmpdir(), name);
			writeFileSync(file, `# ${qa.question}\n\n${qa.answer}\n`);
			const f = new File([readFileSync(file)], name, { type: 'text/markdown' });
			await rr.sendFiles([{ file: f, mimetype: 'text/markdown', objinfo: { name } } as any], token);
			// Wait on the COLLECTION, not the task status. getTaskStatus never reports completion for
			// this pipe, so the old loop burned its full 60x2s on every single pair and then marked
			// the pair done regardless — 2 minutes per answer, and no evidence the write landed.
			// The document showing up is the evidence, and it usually appears in seconds.
			let landed = false;
			for (let i = 0; i < 60 && !landed; i++) { landed = await isInKb(name); if (!landed) await sleep(1000); }
			try { unlinkSync(file); } catch {}
			// Only claim it is in the KB because the collection says so. An unverified pair stays
			// pending, so a retry picks it up rather than the card quietly lying about it.
			if (landed) {
				store.markIngested(qa.id);
				done.push({ id: qa.id, thread_id: qa.thread_id ?? null });
				log(`ingested qa ${qa.id}`);
			} else {
				log(`qa ${qa.id}: write never reached ${config.docsCollection} — left pending for a retry`);
			}
		}
		await rr.terminate(token);
	} finally { await rr.disconnect(); }
	log(`ingest-approved done: ${done.length}`);
	return done;
}
