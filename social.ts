import 'dotenv/config';
import { REST, Routes, EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import { readFileSync, writeFileSync } from 'node:fs';

// SOCIAL FEED ANNOUNCER — standalone bot (its own process, like scheduler.ts).
// Fetches RocketRide's latest YouTube videos, X posts, and newsletter issues and
// announces NEW ones to a Discord channel on a schedule. Posts via REST as the
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
	hours: (process.env.SOCIAL_CRON_HOURS || '9,10,11,16,17,18')
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
			thumbnail: (th.maxres ?? th.high ?? th.medium ?? th.default)?.url ?? (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : undefined),
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

const SOCIAL_SOURCES: Array<{ platform: string; requires: string; configured: () => boolean; fetch: (n: number) => Promise<FeedItem[]> }> = [
	{ platform: 'youtube', requires: 'YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID', configured: () => Boolean(SOCIAL.youtube.apiKey && (SOCIAL.youtube.channelId || SOCIAL.youtube.handle)), fetch: fetchYouTube },
	{ platform: 'x', requires: 'X_BEARER_TOKEN + X_USER_ID', configured: () => Boolean(SOCIAL.x.bearerToken && (SOCIAL.x.userId || SOCIAL.x.username)), fetch: fetchX },
	{ platform: 'newsletter', requires: 'GHOST_API_URL + GHOST_CONTENT_API_KEY', configured: () => Boolean(SOCIAL.newsletter.apiUrl && SOCIAL.newsletter.contentApiKey), fetch: fetchNewsletter },
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
const SOCIAL_COLORS: Record<string, number> = { youtube: 0xff0000, x: 0x1d9bf0, newsletter: 0x15171a };
const SOCIAL_HEADERS: Record<string, string> = { youtube: 'New YouTube video', x: '𝕏  New post on X', newsletter: '✉  New newsletter' };
// Author-icon must be a raster URL (Discord's embed proxy won't render SVG).
const SOCIAL_ICONS: Record<string, string> = { youtube: 'https://www.gstatic.com/youtube/img/branding/favicon/favicon_144x144.png' };
const socialKey = (it: FeedItem) => `${it.platform}:${it.id}`;

function socialEmbed(it: FeedItem) {
	const e = new EmbedBuilder()
		.setColor(SOCIAL_COLORS[it.platform] ?? 0x5865f2)
		.setAuthor({ name: SOCIAL_HEADERS[it.platform] ?? it.platform, iconURL: SOCIAL_ICONS[it.platform] })
		.setTitle(it.title.slice(0, 256)).setURL(it.url).setTimestamp(it.published);
	if (it.text && it.text !== it.title) e.setDescription(it.text.slice(0, 500));
	if (it.author) e.setFooter({ text: it.author });
	if (it.thumbnail) e.setImage(it.thumbnail);
	return e.toJSON();
}

// One pass: fetch every configured source, then post only items newer than each
// platform's watermark (seeding the baseline the first time, so old posts never dump).
async function announceOnce(opts: { dryRun?: boolean; backfill?: boolean } = {}): Promise<void> {
	if (!SOCIAL.channelId) { log('[social] no SOCIAL_DISCORD_CHANNEL_ID — skipping'); return; }
	if (!SOCIAL.botToken && !opts.dryRun) { log('[social] no bot token (SCHEDULER_BOT_TOKEN / SOCIAL_DISCORD_TOKEN) — skipping'); return; }

	const items: FeedItem[] = [];
	for (const src of SOCIAL_SOURCES) {
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
			await rest.post(Routes.channelMessages(SOCIAL.channelId), { body: { embeds: [socialEmbed(it)] } });
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
	// One pass, then exit — manual trigger / testing.
	announceOnce({ dryRun: process.argv.includes('--dry'), backfill: process.argv.includes('--backfill') })
		.then(() => process.exit(0))
		.catch((err) => { console.error(err); process.exit(1); });
} else {
	startSocialAnnouncer();
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.on(sig, () => { log(`[social] ${sig} — shutting down.`); process.exit(0); });
	}
}
