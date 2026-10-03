import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// GitHub contributor verification — the logic half (no discord.js in here, so it stays
// unit-testable). The Discord glue lives in github-verify-discord.ts.
//
// A member proves they own a GitHub account, and if that account has merged pull requests
// in the public server repo they get the @Contributor role. Identity is proved by GitHub's
// DEVICE FLOW: the member types a short code at github.com/login/device, we exchange it for
// a user access token, read the account id/login, and throw the token away. Device Flow
// needs only a client id — no client secret, no callback URL, no inbound HTTP.
//
// The merged-PR count deliberately uses OUR server token, not the member's: a GitHub App
// user-to-server token is not guaranteed to carry search access, and the repo is public
// anyway. The member's token is used for exactly one call (GET /user) and never stored.

const CLIENT_ID = (process.env.ROCKETRIDE_GITHUB_CLIENT_ID ?? '').trim();
const SERVER_TOKEN = (process.env.ROCKETRIDE_GITHUB_TOKEN ?? '').trim();
export const REPO = process.env.GITHUB_CONTRIB_REPO || 'rocketride-org/rocketride-server';
export const CONTRIBUTOR_ROLE_ID = (process.env.ROCKETRIDE_DISCORD_CONTRIBUTOR_ROLE_ID ?? '').trim();
// #getting-started — read-only to members, so the panel can't be buried (and needs no pin,
// which matters because Ralph has no Manage Messages anywhere).
export const PANEL_CHANNEL_ID = (process.env.VERIFY_PANEL_CHANNEL_ID || '1329633474889519144').trim();
const STORE_PATH = process.env.CONTRIB_STORE_PATH || 'data/contributors.json';
// 'device' (default) or 'bio'. The bio/gist verifier is the documented fallback for if
// Device Flow ever breaks; it needs a username up front, hence IdentityVerifier.needsLogin.
const METHOD = (process.env.GITHUB_VERIFY_METHOD || 'device').trim().toLowerCase();

const API = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const UA = 'rocketride-discord-contributor-verify';

export const hasClientId = (): boolean => CLIENT_ID.length > 0;

const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA };
const ghHeaders = (): Record<string, string> => ({
	Accept: 'application/vnd.github+json',
	'User-Agent': UA,
	...(SERVER_TOKEN ? { Authorization: `Bearer ${SERVER_TOKEN}` } : {}),
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// GitHub's own username rule: 1-39 chars, alphanumeric or single inner hyphens.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// --- store -------------------------------------------------------------------

/** One verified Discord <-> GitHub link. */
export interface ContributorRecord {
	discord_id: string;
	github_id: number;      // numeric id is the source of truth — it survives a username change
	github_login: string;   // cached for display; re-resolve from github_id if it looks stale
	verified_at: number;
	merged_prs: number;
	method: string;
}

export type ClaimConflict =
	| { kind: 'discord_linked'; existing: ContributorRecord }
	| { kind: 'github_claimed'; existing: ContributorRecord };

/**
 * Flat JSON store, same shape as data/faqs.json: small, human-readable, no new dependency.
 * Holds Discord ids, so data/contributors.json is gitignored (see contributors.example.json).
 */
export class ContributorStore {
	private records: ContributorRecord[] = [];

	constructor(private readonly path: string) {
		try {
			const raw = JSON.parse(readFileSync(this.path, 'utf8'));
			this.records = Array.isArray(raw?.records) ? raw.records : [];
		} catch {
			this.records = []; // absent or unreadable == empty; first write creates it
		}
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify({ records: this.records }, null, 2));
	}

	byDiscordId(discordId: string): ContributorRecord | null {
		return this.records.find((r) => r.discord_id === discordId) ?? null;
	}

	byGithubId(githubId: number): ContributorRecord | null {
		return this.records.find((r) => r.github_id === githubId) ?? null;
	}

	all(): ContributorRecord[] {
		return [...this.records];
	}

	/**
	 * One GitHub account per Discord user, enforced in BOTH directions: a Discord user can't
	 * link a second GitHub account, and a GitHub account can't be claimed by a second Discord
	 * user. Re-verifying the same pair is not a conflict (that's the re-check path).
	 */
	claimConflict(discordId: string, githubId: number): ClaimConflict | null {
		const byDiscord = this.byDiscordId(discordId);
		if (byDiscord && byDiscord.github_id !== githubId) return { kind: 'discord_linked', existing: byDiscord };
		const byGithub = this.byGithubId(githubId);
		if (byGithub && byGithub.discord_id !== discordId) return { kind: 'github_claimed', existing: byGithub };
		return null;
	}

	upsert(record: ContributorRecord): void {
		const i = this.records.findIndex((r) => r.discord_id === record.discord_id);
		if (i >= 0) this.records[i] = record;
		else this.records.push(record);
		this.save();
	}
}

export const store = new ContributorStore(STORE_PATH);

// --- GitHub reads ------------------------------------------------------------

export interface GithubUser {
	id: number;
	login: string;
	type: string;
	bio: string | null;
}

/** GET /users/{login} — case-insensitive, returns the canonical casing. null on 404. */
export async function resolveUser(login: string): Promise<GithubUser | null> {
	const res = await fetch(`${API}/users/${encodeURIComponent(login)}`, { headers: ghHeaders() });
	if (!res.ok) return null;
	const b = (await res.json().catch(() => null)) as any;
	if (typeof b?.id !== 'number' || typeof b?.login !== 'string') return null;
	return { id: b.id, login: b.login, type: String(b.type ?? 'User'), bio: typeof b.bio === 'string' ? b.bio : null };
}

export type PrCount = { ok: true; count: number } | { ok: false; reason: string };

/**
 * Merged PRs by `login` in REPO. Note that GitHub answers an unknown author with HTTP 422
 * ("Validation Failed"), NOT a zero count — conflating the two would hand the role out on a
 * typo, so they stay distinct here.
 */
export async function countMergedPRs(login: string): Promise<PrCount> {
	if (!LOGIN_RE.test(login)) return { ok: false, reason: `\`${login}\` is not a valid GitHub username.` };
	const q = `repo:${REPO} is:pr is:merged author:${login}`;
	let res: Response;
	try {
		res = await fetch(`${API}/search/issues?q=${encodeURIComponent(q)}&per_page=1`, { headers: ghHeaders() });
	} catch (e) {
		return { ok: false, reason: `Could not reach GitHub (${e instanceof Error ? e.message : e}).` };
	}
	if (res.status === 422) return { ok: false, reason: `GitHub does not recognise the account \`${login}\`.` };
	if (res.status === 403 || res.status === 429) return { ok: false, reason: 'GitHub rate-limited the search — try again in a minute.' };
	if (!res.ok) return { ok: false, reason: `GitHub search returned HTTP ${res.status}.` };
	const b = (await res.json().catch(() => null)) as any;
	if (typeof b?.total_count !== 'number') return { ok: false, reason: 'Unexpected response from GitHub search.' };
	return { ok: true, count: b.total_count };
}

// --- identity verification ---------------------------------------------------

export interface IdentityProof {
	githubId: number;
	githubLogin: string;
}

export type BeginResult =
	| { ok: true; instructions: string; expiresAt: number }
	| { ok: false; reason: string };

export type CheckResult =
	| { status: 'verified'; proof: IdentityProof }
	| { status: 'pending'; hint: string }
	| { status: 'expired' }
	| { status: 'denied' }
	| { status: 'none' } // nothing in flight for this member (e.g. the bot restarted)
	| { status: 'error'; message: string };

export interface IdentityVerifier {
	readonly name: string;
	/** true => the caller must collect a GitHub username (via modal) and pass it to begin(). */
	readonly needsLogin: boolean;
	begin(discordUserId: string, githubLogin?: string): Promise<BeginResult>;
	check(discordUserId: string): Promise<CheckResult>;
}

type DevicePoll =
	| { status: 'ok'; accessToken: string }
	| { status: 'pending' }
	| { status: 'slow_down'; interval: number }
	| { status: 'expired' }
	| { status: 'denied' }
	| { status: 'error'; message: string };

async function pollDevice(deviceCode: string): Promise<DevicePoll> {
	let res: Response;
	try {
		res = await fetch(DEVICE_TOKEN_URL, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: DEVICE_GRANT }),
		});
	} catch (e) {
		return { status: 'error', message: `Could not reach GitHub (${e instanceof Error ? e.message : e}).` };
	}
	const b = (await res.json().catch(() => null)) as any;
	if (!b) return { status: 'error', message: `GitHub returned HTTP ${res.status}.` };
	if (typeof b.access_token === 'string') return { status: 'ok', accessToken: b.access_token };
	switch (b.error) {
		case 'authorization_pending': return { status: 'pending' };
		// GitHub hands back a NEW interval with slow_down — honour it rather than assuming +5s.
		case 'slow_down': return { status: 'slow_down', interval: Math.max(5, Number(b.interval ?? 10)) };
		case 'expired_token': return { status: 'expired' };
		case 'access_denied': return { status: 'denied' };
		default: return { status: 'error', message: String(b.error_description ?? b.error ?? 'unknown error') };
	}
}

/** GET /user with the member's token. The token is used here and nowhere else. */
async function identify(accessToken: string): Promise<GithubUser | null> {
	const res = await fetch(`${API}/user`, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
	});
	if (!res.ok) return null;
	const b = (await res.json().catch(() => null)) as any;
	if (typeof b?.id !== 'number' || typeof b?.login !== 'string') return null;
	return { id: b.id, login: b.login, type: String(b.type ?? 'User'), bio: null };
}

interface DevicePending {
	deviceCode: string;
	interval: number;
	expiresAt: number;
}

// In-memory only, on purpose: a half-finished verification is worth nothing after a restart,
// and the member simply presses the button again. Nothing secret is persisted.
const devicePending = new Map<string, DevicePending>();

export const deviceFlowVerifier: IdentityVerifier = {
	name: 'github-device-flow',
	needsLogin: false,

	async begin(discordUserId) {
		if (!CLIENT_ID) return { ok: false, reason: 'GitHub verification is not configured (ROCKETRIDE_GITHUB_CLIENT_ID is unset).' };
		let res: Response;
		try {
			res = await fetch(DEVICE_CODE_URL, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ client_id: CLIENT_ID }) });
		} catch (e) {
			return { ok: false, reason: `Could not reach GitHub (${e instanceof Error ? e.message : e}).` };
		}
		const b = (await res.json().catch(() => null)) as any;
		if (!res.ok || typeof b?.device_code !== 'string' || typeof b?.user_code !== 'string') {
			return { ok: false, reason: String(b?.error_description ?? `GitHub returned HTTP ${res.status}.`) };
		}
		const verificationUri = String(b.verification_uri ?? 'https://github.com/login/device');
		const expiresAt = Date.now() + Number(b.expires_in ?? 900) * 1000;
		devicePending.set(discordUserId, {
			deviceCode: b.device_code,
			interval: Math.max(5, Number(b.interval ?? 5)),
			expiresAt,
		});
		const minutes = Math.max(1, Math.round(Number(b.expires_in ?? 900) / 60));
		return {
			ok: true,
			expiresAt,
			instructions: [
				`**1.** Open ${verificationUri}`,
				`**2.** Enter this code:`,
				`\`\`\`${b.user_code}\`\`\``,
				`**3.** Approve the request, then press **I've authorized** below.`,
				'',
				`_The code expires in about ${minutes} minutes. Only you can see this message._`,
			].join('\n'),
		};
	},

	async check(discordUserId) {
		const pending = devicePending.get(discordUserId);
		if (!pending) return { status: 'none' };
		if (Date.now() > pending.expiresAt) {
			devicePending.delete(discordUserId);
			return { status: 'expired' };
		}

		// Poll once; if GitHub says "not yet", wait out the interval and try a second time so
		// the common case (member authorizes, then clicks straight away) resolves on one press.
		let result = await pollDevice(pending.deviceCode);
		if (result.status === 'slow_down') {
			pending.interval = result.interval;
			result = { status: 'pending' };
		}
		if (result.status === 'pending') {
			await sleep(pending.interval * 1000);
			const retry = await pollDevice(pending.deviceCode);
			if (retry.status === 'slow_down') pending.interval = retry.interval;
			else result = retry;
		}

		switch (result.status) {
			case 'ok': {
				devicePending.delete(discordUserId);
				const who = await identify(result.accessToken);
				// result.accessToken deliberately goes out of scope here: never stored, never logged.
				if (!who) return { status: 'error', message: 'GitHub authorized the request, but the profile lookup failed.' };
				if (who.type !== 'User') return { status: 'error', message: `That is a GitHub ${who.type}, not a personal account.` };
				return { status: 'verified', proof: { githubId: who.id, githubLogin: who.login } };
			}
			case 'expired':
				devicePending.delete(discordUserId);
				return { status: 'expired' };
			case 'denied':
				devicePending.delete(discordUserId);
				return { status: 'denied' };
			case 'pending':
			case 'slow_down':
				return { status: 'pending', hint: "Not authorized yet — finish the steps above, then press **I've authorized** again." };
			default:
				return { status: 'error', message: result.message };
		}
	},
};

interface BioPending {
	login: string;
	githubId: number;
	code: string;
	expiresAt: number;
}

const bioPending = new Map<string, BioPending>();

/** Is `code` visible on the member's public profile — bio, or a public gist description/filename? */
async function codeIsPublic(login: string, code: string): Promise<boolean> {
	const needle = code.toLowerCase();
	const user = await resolveUser(login);
	if (user?.bio && user.bio.toLowerCase().includes(needle)) return true;
	// The gists LIST endpoint omits file content, so match description + filenames only —
	// that keeps this to a single request instead of one per gist.
	const res = await fetch(`${API}/users/${encodeURIComponent(login)}/gists?per_page=100`, { headers: ghHeaders() });
	if (!res.ok) return false;
	const gists = (await res.json().catch(() => null)) as any;
	if (!Array.isArray(gists)) return false;
	return gists.some((g) => {
		if (String(g?.description ?? '').toLowerCase().includes(needle)) return true;
		return Object.keys(g?.files ?? {}).some((f) => f.toLowerCase().includes(needle));
	});
}

/**
 * Fallback verifier, kept behind the same interface so it can be swapped in with
 * GITHUB_VERIFY_METHOD=bio if Device Flow ever stops working. Weaker than Device Flow
 * (it trusts whoever can edit that profile) and needs a username up front.
 */
export const bioGistVerifier: IdentityVerifier = {
	name: 'github-bio-or-gist',
	needsLogin: true,

	async begin(discordUserId, githubLogin) {
		const login = (githubLogin ?? '').trim().replace(/^@/, '');
		if (!LOGIN_RE.test(login)) return { ok: false, reason: 'That does not look like a GitHub username.' };
		const user = await resolveUser(login);
		if (!user) return { ok: false, reason: `There is no GitHub user called \`${login}\`.` };
		if (user.type !== 'User') return { ok: false, reason: `\`${user.login}\` is a GitHub ${user.type}, not a personal account.` };
		const code = `rocketride-verify-${randomBytes(6).toString('hex')}`;
		const expiresAt = Date.now() + 30 * 60 * 1000;
		bioPending.set(discordUserId, { login: user.login, githubId: user.id, code, expiresAt });
		return {
			ok: true,
			expiresAt,
			instructions: [
				`Verifying **@${user.login}**. Add this code to your GitHub **bio**, or to the description or filename of a **public gist**:`,
				`\`\`\`${code}\`\`\``,
				`Then press **I've added it** below. You can remove the code afterwards.`,
				'',
				'_This code expires in 30 minutes. Only you can see this message._',
			].join('\n'),
		};
	},

	async check(discordUserId) {
		const pending = bioPending.get(discordUserId);
		if (!pending) return { status: 'none' };
		if (Date.now() > pending.expiresAt) {
			bioPending.delete(discordUserId);
			return { status: 'expired' };
		}
		if (await codeIsPublic(pending.login, pending.code)) {
			bioPending.delete(discordUserId);
			return { status: 'verified', proof: { githubId: pending.githubId, githubLogin: pending.login } };
		}
		return { status: 'pending', hint: "Couldn't see the code yet — GitHub can take a moment to update. Press **I've added it** again." };
	},
};

/** The verifier in use, chosen by GITHUB_VERIFY_METHOD. */
export const verifier: IdentityVerifier = METHOD === 'bio' ? bioGistVerifier : deviceFlowVerifier;

// `./node_modules/.bin/tsx github-verify.ts --check <login>` — ops helper: how many merged PRs does GitHub
// credit this account with, and is the account already linked?
if (process.argv.includes('--check')) {
	const login = process.argv[process.argv.indexOf('--check') + 1];
	if (!login) {
		console.error('usage: tsx github-verify.ts --check <github-login>');
		process.exit(1);
	}
	void (async () => {
		const user = await resolveUser(login);
		if (!user) {
			console.log(`no such GitHub user: ${login}`);
			process.exit(0);
		}
		const prs = await countMergedPRs(user.login);
		const linked = store.byGithubId(user.id);
		console.log(`${user.login} (id ${user.id}, type ${user.type})`);
		console.log(`  merged PRs in ${REPO}: ${prs.ok ? prs.count : `error — ${prs.reason}`}`);
		console.log(`  linked to Discord id: ${linked ? linked.discord_id : '(not linked)'}`);
	})();
}
