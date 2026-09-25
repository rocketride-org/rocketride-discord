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

export async function ingestApproved(store: Store, opts: { log: Log }): Promise<number> {
	const { log } = opts;
	const pending = store.getApprovedUningested();
	if (!pending.length) { log('no approved, un-ingested Q/A pairs'); return 0; }
	const rr = new RocketRideClient({ uri: detectEngineUri(), auth: config.rocketrideApiKey } as any);
	await rr.connect();
	let done = 0;
	try {
		try { const prev = await rr.use({ filepath: config.ragPipe, useExisting: true }); await rr.terminate(prev.token); } catch {}
		const { token } = await rr.use({ filepath: config.ragPipe });
		for (const qa of pending) {
			const name = `ralph-qa-${qa.id}.md`;
			const file = join(tmpdir(), name);
			writeFileSync(file, `# ${qa.question}\n\n${qa.answer}\n`);
			const f = new File([readFileSync(file)], name, { type: 'text/markdown' });
			await rr.sendFiles([{ file: f, mimetype: 'text/markdown', objinfo: { name } } as any], token);
			for (let i = 0; i < 60; i++) { const st: any = await rr.getTaskStatus(token); if (st?.completed || st?.state === 'COMPLETED') break; await sleep(2000); }
			store.markIngested(qa.id);
			try { unlinkSync(file); } catch {}
			done++;
			log(`ingested qa ${qa.id}`);
		}
		await rr.terminate(token);
	} finally { await rr.disconnect(); }
	log(`ingest-approved done: ${done}`);
	return done;
}
