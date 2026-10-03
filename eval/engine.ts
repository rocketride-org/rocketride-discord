// eval/engine.ts — its own copy of detectEngineUri() (guardrail: don't import support.ts),
// with the Phase-0 fix, plus SerialPipe for prompt-node pipes (unique names, serialized
// sends, instance restart after each send — copies slack-router.ts classify()).

import { execSync } from 'node:child_process';
import { RocketRideClient } from 'rocketride';

/**
 * The local engine listens on a DYNAMIC port. Phase 0 finding: many ports can be listening
 * (a worker pool 20000–20011 plus the control port), and `head -1` picked the wrong one.
 * The control port that prod actually uses was the HIGHEST, so pick max — overridable by
 * ROCKETRIDE_URI (recommended on the Mac mini: set it to what support.log shows).
 */
export function detectEngineUri(): string {
	const sh = (cmd: string): string => { try { return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } };
	// Eval reads/writes the LOCAL qdrant (127.0.0.1:6333), so it MUST hit the local engine even
	// when ROCKETRIDE_URI points at Cloud (api.rocketride.ai). Prefer the eaas control port; the
	// per-pipeline task processes also listen, so match eaas specifically.
	const eaasPid = sh("ps ax -o pid=,command= | grep -i engine | grep -i eaas | grep -v grep | awk '{print $1}' | head -1");
	if (eaasPid) {
		const port = sh(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${eaasPid} 2>/dev/null | grep 127.0.0.1 | sed -E 's/.*:([0-9]+).*/\\1/' | head -1`);
		if (port) return `http://localhost:${port}`;
	}
	// Fallbacks: any local engine listener (highest), then an explicit LOCAL ROCKETRIDE_URI, else default.
	const ports = sh("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i engine | grep '127.0.0.1' | sed -E 's/.*:([0-9]+).*/\\1/' | sort -un").split('\n').map(Number).filter((n) => Number.isFinite(n) && n > 0);
	if (ports.length) return `http://localhost:${Math.max(...ports)}`;
	const env = process.env.ROCKETRIDE_URI;
	return env && /localhost|127\.0\.0\.1/.test(env) ? env : 'http://localhost:5565';
}

/**
 * A single pipe run serially: prompt nodes accumulate context across requests, so we
 * serialize sends and restart the pipe instance after each one. NEVER point this at a
 * production pipe (rocket-ralph.pipe, summariser.pipe, …) — only eval-* pipes.
 */
export class SerialPipe {
	private token: string | null = null;
	private lock: Promise<unknown> = Promise.resolve();
	constructor(private rr: RocketRideClient, private filepath: string, private ttl = 0) {}

	async start(): Promise<void> {
		try { const prev = await this.rr.use({ filepath: this.filepath, useExisting: true }); await this.rr.terminate(prev.token); } catch {}
		this.token = (await this.rr.use({ filepath: this.filepath, ttl: this.ttl })).token;
	}

	/** Serialized send; the instance is restarted afterwards so the next call starts clean. */
	send(data: string, name: string, mimetype = 'text/plain'): Promise<any> {
		const run = this.lock.then(() => this.rr.send(this.token!, data, { name } as any, mimetype));
		this.lock = run.catch(() => {}).then(async () => {
			try { await this.rr.terminate(this.token!); } catch {}
			try { this.token = (await this.rr.use({ filepath: this.filepath, ttl: this.ttl })).token; } catch {}
		});
		return run;
	}

	async stop(): Promise<void> { if (this.token) { try { await this.rr.terminate(this.token); } catch {} } }
}
