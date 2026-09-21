import 'dotenv/config';
import { REST, Routes, EmbedBuilder } from 'discord.js';
import type { RawFile } from '@discordjs/rest';
import { DateTime } from 'luxon';
import { readFileSync, writeFileSync } from 'node:fs';

// SOCIAL FEED ANNOUNCER — standalone bot (its own process, like scheduler.ts).
// Fetches RocketRide's latest YouTube videos, X posts, newsletter issues,
// Instagram posts, and LinkedIn posts and announces NEW ones to a Discord channel
// on a schedule. Posts via REST as the
// scheduler bot (SOCIAL/SCHEDULER token) — no gateway login of its own.
// "Only latest, not old": a per-platform watermark (logs/social-seen.json) records
// the newest item seen at first run and never backfills older ones. X replies
// (comments) + retweets (reposts) are excluded.
// To add a platform: write a fetch fn returning FeedItem[] and push an entry into
// SOCIAL_SOURCES.
//
//   ./node_modules/.bin/tsx social.ts                       # run on schedule (start-bots.sh does this)
//   ./node_modules/.bin/tsx social.ts --social-once [--dry] [--backfill]   # one pass, then exit

function log(...args: unknown[]) {
	console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

const sNum = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const sBool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : v !== 'false' && v !== '0');
const sStr = (v: string | undefined) => { const t = v?.trim(); return t ? t : undefined; };

const SOCIAL = {
	limit: sNum(process.env.SOCIAL_FETCH_LIMIT, 5),
	tz: sStr(process.env.SOCIAL_TZ) ?? sStr(process.env.TIMEZONE) ?? 'America/Los_Angeles',
	hours: (process.env.SOCIAL_CRON_HOURS || '10,11,12,16,17,18')
		.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23).sort((a, b) => a - b),
	channelId: sStr(process.env.SOCIAL_DISCORD_CHANNEL_ID),
	botToken: sStr(process.env.SOCIAL_DISCORD_TOKEN) ?? sStr(process.env.SCHEDULER_BOT_TOKEN) ?? sStr(process.env.DISCORD_BOT_TOKEN),
	statePath: process.env.SOCIAL_SEEN_PATH || 'logs/social-seen.json',
	youtube: { apiKey: sStr(process.env.YOUTUBE_API_KEY), channelId: sStr(process.env.YOUTUBE_CHANNEL_ID), handle: sStr(process.env.YOUTUBE_HANDLE) },
	x: {
		bearerToken: sStr(process.env.X_BEARER_TOKEN), userId: sStr(process.env.X_USER_ID), username: sStr(process.env.X_USERNAME)?.replace(/^@/, ''),
		excludeReplies: sBool(process.env.X_EXCLUDE_REPLIES, true), excludeRetweets: sBool(process.env.X_EXCLUDE_RETWEETS, true),
	},
	newsletter: { apiUrl: sStr(process.env.GHOST_API_URL), contentApiKey: sStr(process.env.GHOST_CONTENT_API_KEY) },
	instagram: {
		accountId: sStr(process.env.INSTAGRAM_ACCOUNT_ID),
		token: sStr(process.env.INSTAGRAM_ACCESS_TOKEN),
		apiVersion: sStr(process.env.INSTAGRAM_API_VERSION) || 'v22.0',
	},
	linkedin: {
		// A refresh token (in either var) is exchanged for a short-lived access token
		// each run via client id+secret — access tokens expire ~60d, so a daemon must refresh.
		token: sStr(process.env.LINKEDIN_ACCESS_TOKEN),
		refreshToken: sStr(process.env.LINKEDIN_REFRESH_TOKEN),
		clientId: sStr(process.env.LINKEDIN_CLIENT_ID),
		clientSecret: sStr(process.env.LINKEDIN_CLIENT_SECRET),
		orgId: sStr(process.env.LINKEDIN_ORG_ID),
		authorUrn: sStr(process.env.LINKEDIN_AUTHOR_URN),
		apiVersion: sStr(process.env.LINKEDIN_API_VERSION) || '202508',
	},
};

type FeedItem = { platform: string; id: string; title: string; text?: string; url: string; published: Date; author?: string; thumbnail?: string };

// --- http (timeout + typed error) ---
class HttpError extends Error {
	readonly url: string;
	constructor(readonly status: number, rawUrl: string, readonly body: string) {
		// Redact secrets carried as query params (YouTube key=, Ghost key=, any token=)
		// BEFORE they enter the message/url — otherwise a routine 4xx (e.g. YouTube quota)
		// would write the API key verbatim into logs/social.log.
		const safe = rawUrl.replace(/([?&](?:key|api[_-]?key|token|access[_-]?token)=)[^&#]*/gi, '$1<redacted>');
		super(`HTTP ${status} for ${safe}${body ? ` — ${body.slice(0, 200)}` : ''}`);
		this.name = 'HttpError';
		this.url = safe;
	}
}
async function httpGet(url: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'rocketride-social/1.0', ...init?.headers } });
	if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
	return res;
}
const getJson = async <T = any>(url: string, init?: RequestInit) => (await httpGet(url, init)).json() as Promise<T>;

// --- sources ---
async function fetchYouTube(limit: number): Promise<FeedItem[]> {
	const key = SOCIAL.youtube.apiKey!;
	const idParam = SOCIAL.youtube.channelId
		? `id=${encodeURIComponent(SOCIAL.youtube.channelId)}`
		: `forHandle=${encodeURIComponent((SOCIAL.youtube.handle ?? '').replace(/^@/, ''))}`;
	const ch = await getJson(`https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&${idParam}&key=${key}`);
	const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
	const title = ch.items?.[0]?.snippet?.title;
	if (!uploads) throw new Error('YouTube channel not found (check YOUTUBE_CHANNEL_ID / YOUTUBE_HANDLE)');
	const max = Math.min(50, Math.max(1, limit));
	const pl = await getJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=${max}&playlistId=${uploads}&key=${key}`);
	return (pl.items ?? []).map((it: any): FeedItem => {
		const vid = it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId;
		const th = it.snippet?.thumbnails ?? {};
		return {
			platform: 'youtube', id: vid ?? '', title: it.snippet?.title ?? '(untitled)', url: `https://www.youtube.com/watch?v=${vid}`,
			published: new Date(it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt ?? Date.now()),
			author: it.snippet?.videoOwnerChannelTitle ?? title,
			// Prefer `high` (always generated on upload) over `maxres`: maxresdefault.jpg 404s
			// for the first minutes of a new upload (and often forever for Shorts), which made
			// fresh videos post with a broken preview. hqdefault is the guaranteed fallback.
			thumbnail: (th.high ?? th.medium ?? th.default ?? th.maxres)?.url ?? (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : undefined),
		};
	}).filter((x: FeedItem) => x.id).sort((a: FeedItem, b: FeedItem) => b.published.getTime() - a.published.getTime()).slice(0, limit);
}

async function fetchX(limit: number): Promise<FeedItem[]> {
	const headers = { authorization: `Bearer ${SOCIAL.x.bearerToken}` };
	let userId = SOCIAL.x.userId;
	if (!userId) {
		if (!SOCIAL.x.username) throw new Error('no X_USER_ID or X_USERNAME');
		const u = await getJson(`https://api.twitter.com/2/users/by/username/${encodeURIComponent(SOCIAL.x.username)}`, { headers });
		userId = u.data?.id;
		if (!userId) throw new Error(`could not resolve X user @${SOCIAL.x.username}`);
	}
	const max = Math.min(100, Math.max(5, limit));
	const exclude = [SOCIAL.x.excludeReplies && 'replies', SOCIAL.x.excludeRetweets && 'retweets'].filter(Boolean) as string[];
	const params = new URLSearchParams({ max_results: String(max), 'tweet.fields': 'created_at' });
	if (exclude.length) params.set('exclude', exclude.join(','));
	let resp: any;
	try {
		resp = await getJson(`https://api.twitter.com/2/users/${userId}/tweets?${params}`, { headers });
	} catch (e) {
		if (e instanceof HttpError) {
			if (e.status === 401) throw new Error('X 401 — check X_BEARER_TOKEN');
			if (e.status === 429) throw new Error('X 429 — rate limited');
			if (e.status === 403) throw new Error('X 403 — API tier lacks this endpoint');
		}
		throw e;
	}
	const handle = SOCIAL.x.username;
	return (resp.data ?? []).slice(0, limit).map((t: any): FeedItem => {
		const body = typeof t.text === 'string' ? t.text : ''; // guard: some tweets can lack `text`
		return {
			platform: 'x', id: t.id, title: (body.split('\n')[0] || '(post)').slice(0, 120), text: body || undefined,
			url: handle ? `https://x.com/${handle}/status/${t.id}` : `https://twitter.com/i/web/status/${t.id}`,
			published: new Date(t.created_at), author: handle ? `@${handle}` : undefined,
		};
	});
}

async function fetchNewsletter(limit: number): Promise<FeedItem[]> {
	const base = SOCIAL.newsletter.apiUrl!.replace(/\/+$/, '');
	const params = new URLSearchParams({
		key: SOCIAL.newsletter.contentApiKey!, limit: String(limit), order: 'published_at desc',
		fields: 'id,title,url,excerpt,published_at,feature_image', include: 'authors',
	});
	const resp = await getJson(`${base}/ghost/api/content/posts/?${params}`, { headers: { 'accept-version': 'v5.0' } });
	return (resp.posts ?? []).map((p: any): FeedItem => ({
		platform: 'newsletter', id: p.id, title: p.title ?? '(untitled)', text: p.custom_excerpt ?? p.excerpt ?? undefined,
		url: p.url ?? base, published: new Date(p.published_at ?? p.created_at ?? Date.now()), author: p.primary_author?.name, thumbnail: p.feature_image ?? undefined,
	}));
}

async function fetchInstagram(limit: number): Promise<FeedItem[]> {
	const { accountId, token, apiVersion } = SOCIAL.instagram;
	const fields = 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,username';
	const max = Math.min(50, Math.max(1, limit));
	const url = `https://graph.facebook.com/${apiVersion}/${accountId}/media?fields=${fields}&limit=${max}&access_token=${token}`;
	let resp: any;
	try {
		resp = await getJson(url);
	} catch (e) {
		// Graph API returns 400 for a bad account id or expired/invalid token.
		if (e instanceof HttpError && e.status === 400) throw new Error('Instagram 400 — check INSTAGRAM_ACCOUNT_ID / access token (expired?)');
		throw e;
	}
	return (resp.data ?? []).map((m: any): FeedItem => {
		const caption = typeof m.caption === 'string' ? m.caption : '';
		return {
			platform: 'instagram', id: m.id,
			title: (caption.split('\n')[0] || 'New Instagram post').slice(0, 120),
			text: caption || undefined,
			url: m.permalink || 'https://www.instagram.com/',
			published: new Date(m.timestamp),
			author: m.username ? `@${m.username}` : undefined,
			// VIDEO/REEL → thumbnail_url (media_url is the mp4); IMAGE/CAROUSEL → media_url.
			thumbnail: m.thumbnail_url || m.media_url,
		};
	});
}

// LinkedIn: a refresh token can't be used as a Bearer token — exchange it for a
// short-lived access token (client id+secret) fresh on each run. LI_ACCESS holds
// the current pass's token for the posts call + image URN resolutions below.
let LI_ACCESS: string | undefined;
async function linkedinAccessToken(): Promise<string> {
	const li = SOCIAL.linkedin;
	const refresh = li.refreshToken ?? li.token; // the refresh token may sit in either var
	if (refresh && li.clientId && li.clientSecret) {
		const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: li.clientId, client_secret: li.clientSecret });
		const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(12_000) });
		const data: any = await res.json().catch(() => ({}));
		if (!res.ok || !data.access_token) throw new Error(`LinkedIn token exchange failed (HTTP ${res.status})${data?.error ? ` — ${data.error}` : ''}`);
		return data.access_token as string;
	}
	if (li.token) return li.token; // assume it's already an access token
	throw new Error('LinkedIn: need LINKEDIN_ACCESS_TOKEN, or LINKEDIN_REFRESH_TOKEN + LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET');
}
function linkedinHeaders(): Record<string, string> {
	return { authorization: `Bearer ${LI_ACCESS}`, 'linkedin-version': SOCIAL.linkedin.apiVersion, 'x-restli-protocol-version': '2.0.0' };
}
// LinkedIn returns media as URNs; resolve to a real https URL (best-effort — skip on failure).
// Images resolve via /rest/images (downloadUrl); videos/reels via /rest/videos (its cover thumbnail).
async function linkedinMediaUrl(ref: unknown): Promise<string | undefined> {
	if (typeof ref !== 'string' || !ref) return undefined;
	if (/^https?:\/\//.test(ref)) return ref; // already a URL
	try {
		if (/^urn:li:(image|digitalmediaAsset)/.test(ref)) {
			const d = await getJson<any>(`https://api.linkedin.com/rest/images/${encodeURIComponent(ref)}`, { headers: linkedinHeaders() });
			return typeof d?.downloadUrl === 'string' ? d.downloadUrl : undefined;
		}
		if (/^urn:li:video:/.test(ref)) {
			const d = await getJson<any>(`https://api.linkedin.com/rest/videos/${encodeURIComponent(ref)}`, { headers: linkedinHeaders() });
			return typeof d?.thumbnail === 'string' ? d.thumbnail : undefined; // video/reel cover image
		}
	} catch { /* fall through → undefined */ }
	return undefined;
}
async function linkedinThumb(content: any): Promise<string | undefined> {
	if (!content || typeof content !== 'object') return undefined;
	for (const c of [content.article?.thumbnail, content.media?.id, content.media?.thumbnail, content.multiImage?.images?.[0]?.id]) {
		const u = await linkedinMediaUrl(c); if (u) return u;
	}
	return undefined;
}
async function fetchLinkedIn(limit: number): Promise<FeedItem[]> {
	LI_ACCESS = await linkedinAccessToken();
	const li = SOCIAL.linkedin;
	const author = li.authorUrn || (li.orgId ? `urn:li:organization:${li.orgId}` : undefined);
	if (!author) throw new Error('LinkedIn: set LINKEDIN_ORG_ID or LINKEDIN_AUTHOR_URN');
	const want = Math.min(50, Math.max(1, limit));
	// Over-fetch: reshares (reposts) are dropped below, so pull extra to still surface `want` originals.
	const count = Math.min(50, Math.max(want * 3, 15));
	const url = `https://api.linkedin.com/rest/posts?q=author&author=${encodeURIComponent(author)}&count=${count}&sortBy=LAST_MODIFIED`;
	let resp: any;
	try {
		resp = await getJson<any>(url, { headers: linkedinHeaders() });
	} catch (e) {
		if (e instanceof HttpError) {
			if (e.status === 401) throw new Error('LinkedIn 401 — token invalid/expired');
			if (e.status === 403) throw new Error('LinkedIn 403 — token lacks r_organization_social or no admin on this org');
			if (e.status === 426 || e.status === 400) throw new Error(`LinkedIn ${e.status} — bump LINKEDIN_API_VERSION (currently ${li.apiVersion})`);
		}
		throw e;
	}
	const elements: any[] = Array.isArray(resp?.elements) ? resp.elements : [];
	const items: FeedItem[] = [];
	for (const el of elements) {
		// ORIGINAL posts only. A reshare/repost carries `reshareContext` (the parent/root of the
		// post it shares) and no own `content`; original posts have neither. Skip reshares so the
		// announcer only posts RocketRide's own content, never things it merely reposted.
		if (el.reshareContext) continue;
		const commentary = typeof el.commentary === 'string' ? el.commentary : '';
		const urn: string = el.id || '';
		const when = el.createdAt ?? el.publishedAt ?? el.firstPublishedAt ?? el.lastModifiedAt;
		items.push({
			platform: 'linkedin', id: urn,
			title: (commentary.split('\n').find((l: string) => l.trim()) || el.content?.article?.title || 'New LinkedIn post').slice(0, 120),
			text: commentary || undefined, // Version 2 (title + image only) ignores this, but keep it for the record
			url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : 'https://www.linkedin.com/company/',
			published: when ? new Date(Number(when)) : new Date(),
			thumbnail: await linkedinThumb(el.content),
		});
		if (items.length >= want) break;
	}
	return items;
}

const SOCIAL_SOURCES: Array<{ platform: string; requires: string; configured: () => boolean; fetch: (n: number) => Promise<FeedItem[]> }> = [
	{ platform: 'youtube', requires: 'YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID', configured: () => Boolean(SOCIAL.youtube.apiKey && (SOCIAL.youtube.channelId || SOCIAL.youtube.handle)), fetch: fetchYouTube },
	{ platform: 'x', requires: 'X_BEARER_TOKEN + X_USER_ID', configured: () => Boolean(SOCIAL.x.bearerToken && (SOCIAL.x.userId || SOCIAL.x.username)), fetch: fetchX },
	{ platform: 'newsletter', requires: 'GHOST_API_URL + GHOST_CONTENT_API_KEY', configured: () => Boolean(SOCIAL.newsletter.apiUrl && SOCIAL.newsletter.contentApiKey), fetch: fetchNewsletter },
	{ platform: 'instagram', requires: 'INSTAGRAM_ACCOUNT_ID + INSTAGRAM_ACCESS_TOKEN', configured: () => Boolean(SOCIAL.instagram.accountId && SOCIAL.instagram.token), fetch: fetchInstagram },
	// LinkedIn posts ORIGINAL/main posts only — reshares (reposts) are filtered in fetchLinkedIn.
	{
		platform: 'linkedin',
		requires: 'LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET + LINKEDIN_REFRESH_TOKEN + LINKEDIN_ORG_ID',
		configured: () => Boolean((SOCIAL.linkedin.refreshToken || SOCIAL.linkedin.token) && SOCIAL.linkedin.clientId && SOCIAL.linkedin.clientSecret && (SOCIAL.linkedin.orgId || SOCIAL.linkedin.authorUrn)),
		fetch: fetchLinkedIn,
	},
];

// --- watermark + seen store (only the LATEST posts, never old ones) ---
type SocialState = { watermark: Record<string, string>; seen: Set<string> };
function loadSocialState(): SocialState {
	try { const d = JSON.parse(readFileSync(SOCIAL.statePath, 'utf8')); return { watermark: d.watermark ?? {}, seen: new Set<string>(d.seen ?? []) }; }
	catch (e: any) { if (e?.code === 'ENOENT') return { watermark: {}, seen: new Set() }; throw e; }
}
function saveSocialState(s: SocialState): void {
	try { writeFileSync(SOCIAL.statePath, JSON.stringify({ watermark: s.watermark, seen: [...s.seen].slice(-500) }, null, 2)); }
	catch (e) { log('[social] !! could not persist state:', e instanceof Error ? e.message : e); }
}

// --- embed + post ---
const SOCIAL_COLORS: Record<string, number> = { youtube: 0xff0000, x: 0x1d9bf0, newsletter: 0x15171a, instagram: 0xe4405f, linkedin: 0x0a66c2 };
// Small brand icon shown next to the title. Must be a raster URL (Discord can't render SVG).
const SOCIAL_ICONS: Record<string, string> = {
	youtube: 'https://www.gstatic.com/youtube/img/branding/favicon/favicon_144x144.png',
	instagram: 'https://upload.wikimedia.org/wikipedia/commons/a/a5/Instagram_icon.png',
	linkedin: 'https://upload.wikimedia.org/wikipedia/commons/c/ca/LinkedIn_logo_initials.png',
};
const SOCIAL_LABELS: Record<string, string> = { youtube: 'New RocketRide video on YouTube', x: '𝕏  New RocketRide post on X', newsletter: '✉  New RocketRide newsletter', instagram: 'New RocketRide post on Instagram', linkedin: 'New RocketRide post on LinkedIn' };
const socialKey = (it: FeedItem) => `${it.platform}:${it.id}`;

// Download the preview image so we can upload it AS a Discord attachment instead of
// handing Discord an external URL to proxy. Fixes two failure modes:
//   1) Discord resolves an external embed image ONCE, at post time. If that server-side
//      fetch fails/times out (a burst of posts, or a just-published image the CDN isn't
//      serving yet), Discord records width/height = 0 and never retries — the preview is
//      permanently blank even though the URL later works. An uploaded file is measured
//      from its bytes and always renders.
//   2) Instagram/LinkedIn media URLs are signed and expire (~weeks), after which even a
//      previously-good preview goes blank. A Discord-hosted attachment never expires.
// Best-effort: returns undefined on any failure so the caller falls back to the URL.
const IMG_MAGIC: Array<[string, (b: Buffer) => boolean]> = [
	['jpg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
	['png', (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
	['gif', (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
	['webp', (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
];
const MAX_ATTACH_BYTES = 8 * 1024 * 1024; // stay well under Discord's upload cap
async function fetchImageAttachment(url: string): Promise<RawFile | undefined> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'rocketride-social/1.0' } });
		if (!res.ok) return undefined;
		const buf = Buffer.from(await res.arrayBuffer());
		if (!buf.length || buf.length > MAX_ATTACH_BYTES) return undefined;
		const ext = IMG_MAGIC.find(([, test]) => test(buf))?.[0];
		if (!ext) return undefined; // not a recognized image (e.g. an HTML error page) — fall back to URL
		return { name: `preview.${ext}`, data: buf, contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` };
	} catch { return undefined; }
}

// Build the message payload for one item: the minimal card (brand icon + linked title +
// image) and, when the image downloaded, the file to upload alongside it. For video/reels
// the API gives a preview image — Discord can't inline-play the video.
async function buildSocialPost(it: FeedItem): Promise<{ embed: any; files: RawFile[] }> {
	const e = new EmbedBuilder()
		.setColor(SOCIAL_COLORS[it.platform] ?? 0x5865f2)
		.setAuthor({ name: SOCIAL_LABELS[it.platform] ?? it.platform, iconURL: SOCIAL_ICONS[it.platform] })
		.setTitle(it.title.slice(0, 256))
		.setURL(it.url);
	// X (post body) and newsletter (excerpt) show a description; YouTube, Instagram, and
	// LinkedIn stay title + image only.
	if ((it.platform === 'x' || it.platform === 'newsletter') && it.text) e.setDescription(it.text.slice(0, 4096));
	const files: RawFile[] = [];
	if (it.thumbnail) {
		const att = await fetchImageAttachment(it.thumbnail);
		if (att) { e.setImage(`attachment://${att.name}`); files.push(att); }
		else e.setImage(it.thumbnail); // download failed — hand Discord the URL as a best-effort fallback
	}
	return { embed: e.toJSON(), files };
}

// One pass: fetch every configured source, then post only items newer than each
// platform's watermark (seeding the baseline the first time, so old posts never dump).
async function announceOnce(opts: { dryRun?: boolean; backfill?: boolean; only?: string } = {}): Promise<void> {
	if (!SOCIAL.channelId) { log('[social] no SOCIAL_DISCORD_CHANNEL_ID — skipping'); return; }
	if (!SOCIAL.botToken && !opts.dryRun) { log('[social] no bot token (SCHEDULER_BOT_TOKEN / SOCIAL_DISCORD_TOKEN) — skipping'); return; }

	const items: FeedItem[] = [];
	for (const src of SOCIAL_SOURCES) {
		if (opts.only && src.platform !== opts.only) continue; // --only <platform> restricts the pass
		if (!src.configured()) { log(`[social] ${src.platform} not configured (needs ${src.requires}) — skipped`); continue; }
		try { items.push(...(await src.fetch(SOCIAL.limit))); }
		catch (e) { log(`[social] ${src.platform} fetch failed:`, e instanceof Error ? e.message : e); }
	}

	const state = loadSocialState();
	const byPlatform = new Map<string, FeedItem[]>();
	for (const it of items) { const a = byPlatform.get(it.platform) ?? []; a.push(it); byPlatform.set(it.platform, a); }

	const toPost: FeedItem[] = []; const seeded: string[] = [];
	for (const [platform, list] of byPlatform) {
		if (state.watermark[platform] === undefined && !opts.backfill) {
			const newest = list.reduce((a, b) => (a.published > b.published ? a : b));
			state.watermark[platform] = newest.published.toISOString();
			list.forEach((it) => state.seen.add(socialKey(it)));
			seeded.push(`${platform} (${list.length})`);
			continue;
		}
		const cutoff = state.watermark[platform] ? new Date(state.watermark[platform]).getTime() : 0;
		// Strict > : an item exactly at the watermark was already handled, so it's
		// excluded by the timestamp gate alone — no reliance on the (bounded, evictable)
		// seen-set to avoid reposting the boundary item. A brand-new item sharing the
		// exact watermark timestamp isn't realistic for these feeds.
		for (const it of list) if (it.published.getTime() > cutoff && !state.seen.has(socialKey(it))) toPost.push(it);
	}
	toPost.sort((a, b) => a.published.getTime() - b.published.getTime()); // oldest first → chronological
	if (seeded.length) log(`[social] seeded baseline, posted nothing: ${seeded.join(', ')}`);

	if (opts.dryRun) {
		log(`[social] [dry-run] would post ${toPost.length} item(s):`);
		toPost.forEach((it) => log(`   - [${it.platform}] ${it.title}  ${it.url}`));
		return;
	}
	if (!toPost.length) { if (seeded.length) saveSocialState(state); else log('[social] nothing new to post.'); return; }

	const rest = new REST({ version: '10' }).setToken(SOCIAL.botToken!);
	let posted = 0;
	for (const it of toPost) {
		try {
			const { embed, files } = await buildSocialPost(it);
			await rest.post(Routes.channelMessages(SOCIAL.channelId), { body: { embeds: [embed] }, files });
			state.seen.add(socialKey(it));
			const wm = state.watermark[it.platform];
			if (!wm || it.published.getTime() > new Date(wm).getTime()) state.watermark[it.platform] = it.published.toISOString();
			posted++;
			log(`[social] posted [${it.platform}] ${it.title}`);
		} catch (e) { log(`[social] failed to post ${socialKey(it)}:`, e instanceof Error ? e.message : e); }
	}
	saveSocialState(state);
	log(`[social] done — posted ${posted}/${toPost.length} new item(s) to channel ${SOCIAL.channelId}.`);
}

// --- scheduler (in-process, Luxon; TZ-explicit so the host's timezone doesn't matter) ---
function socialNextFire(now: DateTime): DateTime {
	const z = now.setZone(SOCIAL.tz);
	for (const h of SOCIAL.hours) { const c = z.set({ hour: h, minute: 0, second: 0, millisecond: 0 }); if (c > z) return c; }
	return z.plus({ days: 1 }).set({ hour: SOCIAL.hours[0], minute: 0, second: 0, millisecond: 0 });
}
// Serialize runs: if a pass is still in flight when the next fire (or startup) triggers,
// skip this tick rather than overlap — two concurrent passes could clobber each other's
// state save. Never rejects (errors are logged), so callers can fire-and-forget.
let socialRunning = false;
async function runAnnounce(): Promise<void> {
	if (socialRunning) { log('[social] previous run still in progress — skipping this tick'); return; }
	socialRunning = true;
	try { await announceOnce(); }
	catch (e) { log('[social] run error:', e instanceof Error ? e.message : e); }
	finally { socialRunning = false; }
}
function scheduleSocial(): void {
	const now = DateTime.now(); const fire = socialNextFire(now); const ms = fire.toMillis() - now.toMillis();
	log(`[social] next run: ${fire.toFormat('ccc yyyy-LL-dd HH:mm')} ${SOCIAL.tz} (in ${(ms / 60000).toFixed(0)} min)`);
	setTimeout(() => { void runAnnounce(); scheduleSocial(); }, ms);
}
function startSocialAnnouncer(): void {
	if (!SOCIAL.hours.length) { log('[social] no valid SOCIAL_CRON_HOURS — scheduler disabled'); return; }
	log(`[social] announcer up — hours [${SOCIAL.hours.join(', ')}] ${SOCIAL.tz}, channel ${SOCIAL.channelId ?? '(unset)'}`);
	void runAnnounce(); // seed / catch-up
	scheduleSocial();
}

// --- entry (its own process) -------------------------------------------------
if (process.argv.includes('--social-once')) {
	// One pass, then exit — manual trigger / testing. `--only <platform>` restricts it.
	const argv = process.argv;
	const only = argv.find((a) => a.startsWith('--only='))?.split('=')[1]
		?? (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined);
	announceOnce({ dryRun: argv.includes('--dry'), backfill: argv.includes('--backfill'), only })
		.then(() => process.exit(0))
		.catch((err) => { console.error(err); process.exit(1); });
} else {
	startSocialAnnouncer();
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.on(sig, () => { log(`[social] ${sig} — shutting down.`); process.exit(0); });
	}
}
