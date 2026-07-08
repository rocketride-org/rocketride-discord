import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
	Client,
	GatewayIntentBits,
	Events,
	REST,
	Routes,
	SlashCommandBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	AttachmentBuilder,
	PermissionFlagsBits,
	type Interaction,
	type ChatInputCommandInteraction,
	type ButtonInteraction,
	type TextChannel,
} from 'discord.js';
import Redis from 'ioredis';
import { DateTime } from 'luxon';

// Discord Post Scheduler — standalone bot.
// Everything is in one process: slash commands + buttons drive an in-process timer that
// fires channel.send(...) directly. Redis is the durable store (posts + the timer queue +
// the persisted timezone), so a restart just re-arms from what's already in Redis.
//
// Kept SEPARATE from bot.ts on purpose so it can be tested before being released/merged.
// It uses its own SCHEDULER_* env vars and its own Discord application/bot token.

// --- config ------------------------------------------------------------------
const CFG = {
	token: process.env.SCHEDULER_BOT_TOKEN!,
	guildId: process.env.SCHEDULER_GUILD_ID || undefined, // optional; empty → global command registration (slower to appear)
	defaultTimezone: process.env.TIMEZONE || 'America/Los_Angeles',
	redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
};
// Redis key namespace. Scopes every key to this guild so multiple deployments can share one
// Redis without colliding (falls back to a constant if no guild id is set).
const NS = `discord_sched:${CFG.guildId ?? 'global'}`;

function log(...args: unknown[]) {
	console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

// --- data model --------------------------------------------------------------
type Post = {
	id: string; // uuid hex ('' while still a draft)
	status: 'scheduled' | 'dispatching' | 'posted' | 'cancelled';
	scheduledEpoch: number; // unix seconds (absolute; tz-independent)
	createdBy: string; // user id (string! — snowflakes lose precision as JS numbers)
	content: string; // message text (\n already applied)
	channelId: string; // where to post (string!)
	imageB64?: string;
	imageMime?: string;
	imageName?: string;
	messageId?: string; // set after posting
};

// Redis layout:
//   ${NS}:post:${id}          → JSON Post record
//   ${NS}:due                 → sorted set (score = scheduledEpoch) — the durable timer queue
//   ${NS}:setting:timezone    → persisted /timezone (falls back to CFG.defaultTimezone)
const redis = new Redis(CFG.redisUrl);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Pre-confirm drafts live only in memory — a lost unconfirmed draft is harmless; only
// confirmed posts are persisted to Redis.
const drafts = new Map<string, Post>();

const postKey = (id: string) => `${NS}:post:${id}`;
const dueKey = `${NS}:due`;
const tzKey = `${NS}:setting:timezone`;
const allowedRolesKey = `${NS}:setting:allowed_roles`;

async function loadPost(id: string): Promise<Post | null> {
	const raw = await redis.get(postKey(id));
	return raw ? (JSON.parse(raw) as Post) : null;
}
async function savePost(p: Post): Promise<void> {
	await redis.set(postKey(p.id), JSON.stringify(p));
}
async function deletePost(id: string): Promise<boolean> {
	const removed = await redis.del(postKey(id));
	await redis.zrem(dueKey, id);
	return removed > 0;
}
async function getTimezone(): Promise<string> {
	return (await redis.get(tzKey)) ?? CFG.defaultTimezone;
}
async function getAllowedRoles(): Promise<string[]> {
	return redis.smembers(allowedRolesKey);
}

// --- access control ----------------------------------------------------------
// Role restriction is enforced at runtime from a Redis-backed allow-list that is editable
// IN-APP via /access (server managers only). Discord does not let a bot set per-role command
// VISIBILITY programmatically — hiding a command from the picker is a manager-only step in
// Server Settings → Integrations. So non-listed members may still SEE the commands, but any
// attempt to use them is blocked here.
function isGuildManager(i: ChatInputCommandInteraction): boolean {
	const p = i.memberPermissions;
	return !!p && (p.has(PermissionFlagsBits.ManageGuild) || p.has(PermissionFlagsBits.Administrator));
}
function memberRoleIds(i: ChatInputCommandInteraction): string[] {
	const roles = (i.member as any)?.roles;
	if (Array.isArray(roles)) return roles; // APIInteractionGuildMember → string[]
	if (roles?.cache) return [...roles.cache.keys()]; // GuildMember → GuildMemberRoleManager
	return [];
}
async function hasSchedulerAccess(i: ChatInputCommandInteraction): Promise<boolean> {
	if (isGuildManager(i)) return true; // managers always pass (never lock admins out)
	const allowed = await getAllowedRoles();
	if (!allowed.length) return false; // default-deny until a manager grants a role
	const mine = new Set(memberRoleIds(i));
	return allowed.some((r) => mine.has(r));
}

// --- command registration ----------------------------------------------------
const commands = [
	new SlashCommandBuilder().setName('ping').setDescription('Health check'),
	new SlashCommandBuilder().setName('help').setDescription('How to use (copy-pasteable)'),
	new SlashCommandBuilder()
		.setName('schedule')
		.setDescription('Schedule a post')
		.addStringOption((o) =>
			o
				.setName('message')
				.setDescription('Text — links unfurl, @mentions ping; use \\n for line breaks')
				.setRequired(true),
		)
		.addStringOption((o) =>
			o
				.setName('time')
				.setDescription(`When: YYYY-MM-DD HH:MM (${CFG.defaultTimezone})`)
				.setRequired(true),
		)
		.addChannelOption((o) => o.setName('channel').setDescription('Post to (default: here)'))
		.addAttachmentOption((o) => o.setName('image').setDescription('Optional image')),
	new SlashCommandBuilder()
		.setName('scheduled')
		.setDescription('List scheduled posts')
		.addIntegerOption((o) =>
			o.setName('limit').setDescription('How many (default 10, max 50)').setMinValue(1).setMaxValue(50),
		),
	new SlashCommandBuilder()
		.setName('cancel')
		.setDescription('Cancel by id')
		.addStringOption((o) => o.setName('id').setDescription('Post id or short prefix').setRequired(true)),
	new SlashCommandBuilder()
		.setName('timezone')
		.setDescription('Show or set timezone')
		.addStringOption((o) =>
			o.setName('location').setDescription('Place (London) or IANA name; empty to view'),
		),
	new SlashCommandBuilder()
		.setName('access')
		.setDescription('Manage which roles can use the scheduler (server managers only)')
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.addSubcommand((s) => s.setName('show').setDescription('List roles allowed to use the scheduler'))
		.addSubcommand((s) =>
			s
				.setName('allow')
				.setDescription('Allow a role to use the scheduler')
				.addRoleOption((o) => o.setName('role').setDescription('Role to allow').setRequired(true)),
		)
		.addSubcommand((s) =>
			s
				.setName('deny')
				.setDescription('Remove a role from the allow-list')
				.addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true)),
		),
].map((c) => c.toJSON());

async function registerCommands(appId: string): Promise<void> {
	const rest = new REST({ version: '10' }).setToken(CFG.token);
	if (CFG.guildId) {
		await rest.put(Routes.applicationGuildCommands(appId, CFG.guildId), { body: commands });
		// Clear any previously-registered GLOBAL commands so they don't linger as duplicates.
		await rest.put(Routes.applicationCommands(appId), { body: [] });
		log(`registered ${commands.length} guild commands (instant) in guild ${CFG.guildId}; cleared global`);
	} else {
		await rest.put(Routes.applicationCommands(appId), { body: commands });
		log(`registered ${commands.length} global commands (may take up to ~1h to appear)`);
	}
}

// --- /ping -------------------------------------------------------------------
async function onPing(i: ChatInputCommandInteraction): Promise<void> {
	await i.reply({
		content: `🏓 Pong! Gateway heartbeat: **${Math.round(client.ws.ping)}ms**.`,
		ephemeral: true,
	});
}

// --- /help -------------------------------------------------------------------
const HELP_TEXT = [
	'**📅 Post Scheduler — quick reference**',
	'',
	'**`/schedule`** — schedule a post, then preview & Confirm.',
	'• `message` — the text. Links unfurl and `@mentions` ping when it posts. Use `\\n` for a line break (`\\n\\n` for a blank line).',
	'• `time` — `YYYY-MM-DD HH:MM` in the current timezone (see `/timezone`).',
	'• `channel` — where to post (defaults to this channel).',
	'• `image` — optional attachment; it is downloaded now and stored, so the post survives a restart.',
	'**`/scheduled [limit]`** — list upcoming posts as cards, each with a 🗑️ Delete button.',
	'**`/cancel id:<id>`** — cancel a post by its full id or a short prefix.',
	'**`/timezone [location]`** — no arg shows the current tz; pass a place (e.g. `London`) or IANA name to change it (with a confirm step).',
	'**`/ping`** — health check.',
	'',
	'**🔐 Access — who can use the scheduler** _(server managers only)_',
	'The scheduler works in **any channel**, but only for allowed roles — everyone else gets a private “no access” notice. By default only members with **Manage Server** can use it. Grant or revoke roles with:',
	'• `/access allow role:@Role` — let a role use the scheduler',
	'• `/access deny role:@Role` — remove a role',
	'• `/access show` — list the roles that currently have access',
	'',
	'_Tips:_ the preview is the real post (links/image render), but previews never ping — only the delivered post does. Times are stored as an absolute instant, so changing the timezone later never shifts an already-scheduled post.',
	'',
	'Paste this into an AI assistant to have it write the command for you:',
	'```text',
	'Write a Discord /schedule command for me. Ask me for: the message text, the',
	'date and time, and (optionally) a target channel and image. Then output it as:',
	'/schedule message:<text with \\n for line breaks> time:<YYYY-MM-DD HH:MM>',
	'Keep links and @mentions inline in the message text.',
	'```',
].join('\n');

async function onHelp(i: ChatInputCommandInteraction): Promise<void> {
	await i.reply({ content: HELP_TEXT, ephemeral: true });
}

// --- /schedule → preview → Confirm ------------------------------------------
function confirmRow(draftId: string) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`confirm:${draftId}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`cancel:${draftId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
	);
}

async function onSchedule(i: ChatInputCommandInteraction): Promise<void> {
	await i.deferReply({ ephemeral: true }); // ← ACK within 3s BEFORE any slow work

	const raw = i.options.getString('message', true);
	const timeStr = i.options.getString('time', true);
	const channel = i.options.getChannel('channel') ?? i.channel!;
	const image = i.options.getAttachment('image');

	// 1) parse & validate the time in the current tz
	const tz = await getTimezone();
	const dt = DateTime.fromFormat(timeStr.trim(), 'yyyy-MM-dd HH:mm', { zone: tz });
	if (!dt.isValid) {
		await i.editReply('❌ Time must look like `YYYY-MM-DD HH:MM`.');
		return;
	}
	if (dt <= DateTime.now().setZone(tz)) {
		await i.editReply('❌ That time is in the past.');
		return;
	}

	// 2) download the image NOW (Discord CDN urls expire) → base64
	let imageB64: string | undefined;
	let imageMime: string | undefined;
	let imageName: string | undefined;
	if (image) {
		if (image.size > 8 * 1024 * 1024) {
			await i.editReply('❌ Image too large (limit 8MB).');
			return;
		}
		const buf = Buffer.from(await (await fetch(image.url)).arrayBuffer());
		imageB64 = buf.toString('base64');
		imageMime = image.contentType ?? undefined;
		imageName = image.name.replace(/[^A-Za-z0-9._-]/g, '_');
	}

	// 3) \n handling: literal "\n" → real newline (slash inputs are single-line)
	const content = raw.replace(/\\n/g, '\n');

	// 4) draft (in memory only; persisted on Confirm)
	const draftId = randomUUID().replace(/-/g, '');
	drafts.set(draftId, {
		id: '',
		status: 'scheduled',
		scheduledEpoch: Math.floor(dt.toSeconds()),
		createdBy: i.user.id,
		content,
		channelId: channel.id,
		imageB64,
		imageMime,
		imageName,
	});

	// 5) preview = the REAL post (content unfurls links; image shown), buttons under it
	const when = dt.toFormat('yyyy-MM-dd HH:mm') + ` (${tz})`;
	await i.editReply({ content: `🗓️ **Preview** — will post to <#${channel.id}> at **${when}**.` });
	await i.followUp({
		content: content || '_(no text)_',
		files: image ? [new AttachmentBuilder(Buffer.from(imageB64!, 'base64'), { name: imageName! })] : [],
		allowedMentions: { parse: [] }, // don't ping in the PREVIEW
		components: [confirmRow(draftId)],
		ephemeral: true,
	});
}

async function onConfirm(i: ButtonInteraction, draftId: string): Promise<void> {
	const d = drafts.get(draftId);
	drafts.delete(draftId);
	if (!d) {
		await i.update({ content: '⚠️ This draft has expired.', components: [], files: [], embeds: [] });
		return;
	}
	await i.deferUpdate(); // ← ACK within 3s BEFORE the Redis write
	d.id = randomUUID().replace(/-/g, '');
	d.status = 'scheduled';
	await savePost(d);
	await redis.zadd(dueKey, d.scheduledEpoch, d.id); // arm the durable timer
	await armNextTimer(); // recompute soonest fire
	const tz = await getTimezone();
	const when = DateTime.fromSeconds(d.scheduledEpoch).setZone(tz).toFormat('yyyy-MM-dd HH:mm');
	await i.editReply({
		content: `✅ **Scheduled for ${when} (${tz})**  ·  id \`${d.id.slice(0, 8)}\`\n\n${d.content}`,
		components: [],
		allowedMentions: { parse: [] }, // ephemeral echo — never ping from the confirmation
	});
}

async function onCancelDraft(i: ButtonInteraction, draftId: string): Promise<void> {
	drafts.delete(draftId);
	await i.update({ content: '🗑️ Discarded.', components: [], files: [], embeds: [] });
}

// --- /scheduled [limit] → one card per post, each with a Delete button --------
async function onScheduled(i: ChatInputCommandInteraction): Promise<void> {
	await i.deferReply({ ephemeral: true });
	const limit = i.options.getInteger('limit') ?? 10;
	const tz = await getTimezone();

	const ids = await redis.zrange(dueKey, 0, -1); // sorted by time
	const loaded = await Promise.all(ids.map(loadPost));
	const posts = loaded.filter((p): p is Post => !!p && p.status === 'scheduled');
	if (!posts.length) {
		await i.editReply('🗓️ No scheduled posts.');
		return;
	}

	const cap = Math.min(limit, 50);
	await i.editReply(
		`🗓️ **Scheduled posts** (${posts.length})${posts.length > cap ? `  ·  showing ${cap} of ${posts.length}` : ''}`,
	);
	// Discord renders all buttons at the bottom of a message, so one card per message is the
	// only way to put a Delete button under each individual card.
	for (const p of posts.slice(0, cap)) {
		const short = p.id.slice(0, 8);
		const when = DateTime.fromSeconds(p.scheduledEpoch).setZone(tz).toFormat('yyyy-MM-dd HH:mm');
		const embed = new EmbedBuilder()
			.setDescription(p.content || '_(no text)_')
			.setFooter({ text: `${short}  ·  ${when} (${tz})` });
		const files: AttachmentBuilder[] = [];
		if (p.imageB64) {
			const name = `${short}_${p.imageName ?? 'image'}`;
			files.push(new AttachmentBuilder(Buffer.from(p.imageB64, 'base64'), { name }));
			embed.setThumbnail(`attachment://${name}`);
		}
		await i.followUp({
			embeds: [embed],
			files,
			components: [
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setCustomId(`del:${p.id}`)
						.setLabel('Delete')
						.setEmoji('🗑️')
						.setStyle(ButtonStyle.Danger),
				),
			],
			ephemeral: true,
		});
	}
}

async function onDelete(i: ButtonInteraction, postId: string): Promise<void> {
	await i.deferUpdate(); // defer first
	const existed = await deletePost(postId); // DEL post + ZREM due
	await armNextTimer();
	await i.editReply({
		content: existed ? '🗑️ Deleted.' : '⚠️ Already gone.',
		components: [],
		embeds: [],
		files: [],
	});
}

// --- /cancel id: (by id or short prefix) ------------------------------------
async function onCancel(i: ChatInputCommandInteraction): Promise<void> {
	await i.deferReply({ ephemeral: true });
	const given = i.options.getString('id', true).trim();
	const ids = await redis.zrange(dueKey, 0, -1);

	let resolved: string | null = null;
	if (ids.includes(given)) {
		resolved = given;
	} else {
		const matches = ids.filter((x) => x.startsWith(given));
		if (matches.length === 1) resolved = matches[0];
		else if (matches.length > 1) {
			await i.editReply(`❌ \`${given}\` matches ${matches.length} posts — use a longer prefix.`);
			return;
		}
	}
	if (!resolved) {
		await i.editReply(`❌ No scheduled post matching \`${given}\`.`);
		return;
	}
	await deletePost(resolved);
	await armNextTimer();
	await i.editReply(`🗑️ Cancelled \`${resolved.slice(0, 8)}\`.`);
}

// --- /timezone [location] (view / set with resolve + Confirm) ----------------
// Aliases first, then IANA name, then a city-segment match against the runtime tz list.
const ALIASES: Record<string, string> = {
	california: 'America/Los_Angeles',
	sf: 'America/Los_Angeles',
	la: 'America/Los_Angeles',
	pst: 'America/Los_Angeles',
	pdt: 'America/Los_Angeles',
	nyc: 'America/New_York',
	'new york': 'America/New_York',
	est: 'America/New_York',
	edt: 'America/New_York',
	chicago: 'America/Chicago',
	denver: 'America/Denver',
	london: 'Europe/London',
	uk: 'Europe/London',
	paris: 'Europe/Paris',
	berlin: 'Europe/Berlin',
	india: 'Asia/Kolkata',
	ist: 'Asia/Kolkata',
	tokyo: 'Asia/Tokyo',
	sydney: 'Australia/Sydney',
	dubai: 'Asia/Dubai',
	singapore: 'Asia/Singapore',
	utc: 'UTC',
};

function resolveLocationToTz(loc: string): string | null {
	const s = loc.trim();
	// Aliases first: the ALIASES table intentionally includes abbreviations (est/pst/utc) that
	// are ALSO valid IANA zone names, so checking IANA first would shadow them with the raw
	// fixed-offset (no-DST) zone. Alias-first gives the friendly result (EST → America/New_York).
	const a = ALIASES[s.toLowerCase()];
	if (a) return a;
	if (DateTime.now().setZone(s).isValid) return s; // IANA name (e.g. America/New_York, UTC)
	const norm = s.toLowerCase().replace(/[ -]/g, '_');
	const zones = Intl.supportedValuesOf('timeZone'); // city-segment match
	return (
		zones.find((z) => z.split('/').pop()!.toLowerCase() === norm) ??
		zones.find((z) => z.split('/').pop()!.toLowerCase().includes(norm)) ??
		null
	);
}

function tzRow(resolved: string) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`tzok:${resolved}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId('tzno').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
	);
}

async function onTimezone(i: ChatInputCommandInteraction): Promise<void> {
	const location = i.options.getString('location');

	// View (no arg)
	if (!location) {
		const tz = await getTimezone();
		const now = DateTime.now().setZone(tz);
		await i.reply({
			ephemeral: true,
			content:
				`Your current timezone is **${now.toFormat('ZZZZ')}** (UTC ${now.toFormat('ZZ')}).\n\n` +
				`Your local time is currently **${now.toFormat('hh:mma')}**.\n\n` +
				'Run `/timezone location:<place>` to change it.',
		});
		return;
	}

	// Set (location) → resolve → confirm
	const resolved = resolveLocationToTz(location);
	if (!resolved) {
		await i.reply({ ephemeral: true, content: `❌ I couldn't find a timezone for \`${location}\`.` });
		return;
	}
	const now = DateTime.now().setZone(resolved);
	await i.reply({
		ephemeral: true,
		content:
			`I found the timezone **${now.toFormat('ZZZZ')}** (UTC ${now.toFormat('ZZ')}).\n\n` +
			`Your local time there is currently **${now.toFormat('hh:mma')}**.\n\nPlease confirm.`,
		components: [tzRow(resolved)],
	});
}

async function onTzConfirm(i: ButtonInteraction, tz: string): Promise<void> {
	await i.deferUpdate();
	await redis.set(tzKey, tz);
	const now = DateTime.now().setZone(tz);
	await i.editReply({
		content: `✅ Timezone set to **${tz}** — ${now.toFormat('ZZZZ')} (UTC ${now.toFormat('ZZ')}).`,
		components: [],
	});
}

// --- /access (server managers only) — edit the role allow-list in-app --------
async function onAccess(i: ChatInputCommandInteraction): Promise<void> {
	// default_member_permissions already hides this from non-managers; re-check at runtime so
	// it can never be used by someone without Manage Server (e.g. via a stale client).
	if (!isGuildManager(i)) {
		await i.reply({ content: '⛔ Only members with **Manage Server** can edit scheduler access.', ephemeral: true });
		return;
	}
	const sub = i.options.getSubcommand();
	if (sub === 'show') {
		const allowed = await getAllowedRoles();
		await i.reply({
			ephemeral: true,
			allowedMentions: { parse: [] },
			content: allowed.length
				? `🔐 Roles allowed to use the scheduler:\n${allowed.map((r) => `• <@&${r}>`).join('\n')}\n\n_Server managers can always use it. Non-listed members can still see the commands but are blocked on use._`
				: '🔒 No roles configured yet — only members with **Manage Server** can use the scheduler.\nUse `/access allow role:<role>` to grant a role.',
		});
		return;
	}
	if (sub === 'allow') {
		const role = i.options.getRole('role', true);
		await redis.sadd(allowedRolesKey, role.id);
		await i.reply({ ephemeral: true, allowedMentions: { parse: [] }, content: `✅ <@&${role.id}> can now use the scheduler.` });
		return;
	}
	if (sub === 'deny') {
		const role = i.options.getRole('role', true);
		const removed = await redis.srem(allowedRolesKey, role.id);
		await i.reply({
			ephemeral: true,
			allowedMentions: { parse: [] },
			content: removed ? `🗑️ <@&${role.id}> can no longer use the scheduler.` : `<@&${role.id}> wasn't on the list.`,
		});
		return;
	}
}

// --- the timer (in-process, durable via the Redis sorted set) ----------------
let timer: NodeJS.Timeout | undefined;

async function armNextTimer(): Promise<void> {
	const next = await redis.zrange(dueKey, 0, 0, 'WITHSCORES'); // [member, score] of the soonest
	clearTimeout(timer);
	timer = undefined;
	if (next.length < 2) return;
	const epoch = Number(next[1]);
	const ms = Math.max(0, epoch * 1000 - Date.now());
	// Cap at 60s so re-arming stays responsive even for far-future posts (heartbeat poll).
	timer = setTimeout(fireDue, Math.min(ms, 60_000));
}

async function fireDue(): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const due = await redis.zrangebyscore(dueKey, 0, now);
	for (const id of due) await dispatch(id);
	await armNextTimer();
}

// --- delivery + idempotency + catch-up ---------------------------------------
async function dispatch(id: string): Promise<void> {
	const p = await loadPost(id);
	const now = Math.floor(Date.now() / 1000);
	if (!p || p.status !== 'scheduled') {
		await redis.zrem(dueKey, id); // idempotent: already handled / gone
		return;
	}
	if (now - p.scheduledEpoch > 2 * 3600) {
		// catch-up guard: skip stale posts (e.g. bot was down for hours)
		p.status = 'cancelled';
		await savePost(p);
		await redis.zrem(dueKey, id);
		log(`skipped stale post ${id.slice(0, 8)} (${now - p.scheduledEpoch}s late)`);
		return;
	}
	p.status = 'dispatching'; // claim
	await savePost(p);
	try {
		const ch = (await client.channels.fetch(p.channelId)) as TextChannel | null;
		if (!ch || !ch.isTextBased()) throw new Error(`channel ${p.channelId} is not text-based`);
		const msg = await ch.send({
			content: p.content || undefined,
			files: p.imageB64
				? [new AttachmentBuilder(Buffer.from(p.imageB64, 'base64'), { name: p.imageName ?? 'image' })]
				: [],
			allowedMentions: { parse: ['users', 'roles'] }, // links unfurl, mentions ping; NO @everyone
		});
		p.status = 'posted';
		p.messageId = msg.id;
		await savePost(p);
		await redis.zrem(dueKey, id);
		log(`posted ${id.slice(0, 8)} → #${(ch as any).name ?? p.channelId} (message ${msg.id})`);
	} catch (e) {
		// Leave status 'dispatching' so it isn't silently retried into a double-post; a
		// restart / manual inspection reconciles. Log for ops.
		log(`!! dispatch failed for ${id.slice(0, 8)}: ${e instanceof Error ? e.message : e}`);
	}
}

// --- interaction routing -----------------------------------------------------
client.on(Events.InteractionCreate, async (i: Interaction) => {
	try {
		if (i.isChatInputCommand()) {
			// Access gate: operational commands require an allow-listed role (managers always
			// pass). /ping and /help stay open; /access is admin-gated by its own permissions.
			if (['schedule', 'scheduled', 'cancel', 'timezone'].includes(i.commandName)) {
				if (!(await hasSchedulerAccess(i))) {
					await i.reply({
						content:
							"⛔ You don't have access to the scheduler. Ask a server manager to grant your role with `/access allow`.",
						ephemeral: true,
					});
					return;
				}
			}
			switch (i.commandName) {
				case 'ping':
					return await onPing(i);
				case 'help':
					return await onHelp(i);
				case 'schedule':
					return await onSchedule(i);
				case 'scheduled':
					return await onScheduled(i);
				case 'cancel':
					return await onCancel(i);
				case 'timezone':
					return await onTimezone(i);
				case 'access':
					return await onAccess(i);
			}
		} else if (i.isButton()) {
			const [kind, arg] = i.customId.split(':');
			if (kind === 'confirm') return await onConfirm(i, arg);
			if (kind === 'cancel') return await onCancelDraft(i, arg);
			if (kind === 'del') return await onDelete(i, arg);
			if (kind === 'tzok') return await onTzConfirm(i, arg);
			if (kind === 'tzno')
				return await i.update({ content: 'Cancelled — timezone unchanged.', components: [] });
		}
	} catch (e) {
		// Never leave an interaction hanging on an unexpected error.
		log(`!! interaction error (${i.isCommand?.() ? (i as any).commandName : 'button'}): ${e instanceof Error ? e.message : e}`);
		try {
			if (i.isRepliable()) {
				if (i.deferred || i.replied) await i.followUp({ content: '⚠️ Something went wrong.', ephemeral: true });
				else await i.reply({ content: '⚠️ Something went wrong.', ephemeral: true });
			}
		} catch {}
	}
});

// --- main --------------------------------------------------------------------
async function main() {
	if (!CFG.token) throw new Error('Set SCHEDULER_BOT_TOKEN in .env (the scheduler bot token).');

	client.once(Events.ClientReady, async (c) => {
		log(`scheduler online as ${c.user.tag} — usable in any channel (role-gated), tz ${await getTimezone()}`);
		try {
			await registerCommands(c.user.id);
		} catch (e) {
			log(`!! command registration failed: ${e instanceof Error ? e.message : e}`);
		}
		await armNextTimer(); // rehydrate the durable timer from Redis
		log('waiting for interactions... (Ctrl+C to stop)');
	});

	const shutdown = async () => {
		log('shutting down...');
		clearTimeout(timer);
		try {
			await client.destroy();
		} catch {}
		try {
			await redis.quit();
		} catch {}
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await client.login(CFG.token);
}

main().catch((err) => {
	console.error('Fatal:', err instanceof Error ? err.message : err);
	process.exit(1);
});
