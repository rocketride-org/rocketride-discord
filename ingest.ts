import 'dotenv/config';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { RocketRideClient } from 'rocketride';

// Usage: PIPE=pipelines/rag.pipe tsx ingest.ts <file> [uploadName] [mimetype]
const PIPE = process.env.PIPE || 'pipelines/rag.pipe';
const FILE_PATH = process.argv[2];
if (!FILE_PATH) { console.error('Usage: tsx ingest.ts <file> [uploadName] [mimetype]'); process.exit(1); }
const UPLOAD_NAME = process.argv[3] || basename(FILE_PATH);
const MIME = process.argv[4] || 'text/plain';

async function main() {
	const client = new RocketRideClient({
		uri: process.env.ROCKETRIDE_URI,
		auth: process.env.ROCKETRIDE_APIKEY,
		onEvent: (ev: any) => {
			if (ev?.event === 'apaevt_status_upload' && ev.body?.action === 'complete') console.log('  upload complete:', ev.body.filepath);
		},
	} as any);
	await client.connect();
	try {
		try { const p = await client.use({ filepath: PIPE, useExisting: true }); await client.terminate(p.token); } catch {}
		const { token } = await client.use({ filepath: PIPE });
		console.log(`pipeline ${PIPE} started (token ${token})`);

		const buf = readFileSync(FILE_PATH);
		const file = new File([buf], UPLOAD_NAME, { type: MIME });
		console.log(`uploading ${UPLOAD_NAME} (${buf.length} bytes)…`);
		const results: any[] = await client.sendFiles([{ file, mimetype: MIME, objinfo: { name: UPLOAD_NAME } } as any], token);
		for (const r of results) console.log('  result:', r.action, r.filepath ?? '', r.error ? `ERROR: ${r.error}` : '');

		// poll until processing settles (large file may chunk into many embeddings)
		for (let i = 0; i < 120; i++) {
			const st: any = await client.getTaskStatus(token);
			if (st?.completed || st?.state === 'COMPLETED') { console.log('processing complete'); break; }
			await new Promise((r) => setTimeout(r, 2000));
		}
		await client.terminate(token);
		console.log('done.');
	} finally { await client.disconnect(); }
}
main().catch((e) => { console.error('Error:', e instanceof Error ? e.message : e); process.exit(1); });
