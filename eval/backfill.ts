// eval/backfill.ts — rebuild the event log from Discord history (read-only on Discord).
// Uses the SAME rules.classifyRalphReply as live capture, so historical labels match.

import { Client, ThreadChannel, type TextChannel } from 'discord.js';
import { config, ROLE_MENTION, DEAD_END_REPLY } from './config';
import { classifyRalphReply, isTeamMember } from './rules';
import type { Store } from './store';

type Log = (...a: unknown[]) => void;

async function fetchAllThreads(channel: TextChannel): Promise<ThreadChannel[]> {
	const out: ThreadChannel[] = [];
	try {
		const active = await channel.threads.fetchActive();
		for (const t of active.threads.values()) if (t.parentId === channel.id) out.push(t);
	} catch {}
	let before: number | undefined;
	for (let i = 0; i < 200; i++) {
		let res;
		try { res = await channel.threads.fetchArchived({ type: 'public', before, limit: 100 }); }
		catch { break; }
		for (const t of res.threads.values()) if (t.parentId === channel.id) out.push(t);
		if (!res.hasMore || !res.threads.size) break;
		const last = [...res.threads.values()].sort((a, b) => (a.archiveTimestamp ?? 0) - (b.archiveTimestamp ?? 0))[0];
		before = last?.archiveTimestamp ?? undefined;
		if (before == null) break;
	}
	// dedupe by id
	return [...new Map(out.map((t) => [t.id, t])).values()];
}

async function threadMessages(thread: ThreadChannel) {
	const all: any[] = [];
	let before: string | undefined;
	for (let i = 0; i < 100; i++) {
		const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
		if (!batch || !batch.size) break;
		all.push(...batch.values());
		before = batch.last()!.id;
		if (batch.size < 100) break;
	}
	return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

export async function backfill(client: Client, store: Store, opts: { dry?: boolean; sinceMs?: number; log: Log }) {
	const { dry, sinceMs, log } = opts;
	const guild = client.guilds.cache.first() ?? (await client.guilds.fetch()).first();
	const g = guild ? await client.guilds.fetch(guild.id) : null;
	if (!g) throw new Error('no guild');

	const roleCache = new Map<string, string[]>(); // userId -> roleIds ([] if left/unknown)
	const rolesFor = async (userId: string): Promise<string[]> => {
		if (roleCache.has(userId)) return roleCache.get(userId)!;
		const m = await g.members.fetch(userId).catch(() => null);
		const roles = m ? [...m.roles.cache.keys()] : [];
		roleCache.set(userId, roles);
		return roles;
	};
	const teamCheck = async (userId: string) => isTeamMember(await rolesFor(userId), userId, config.escalationRoleId, config.teamUserIds);

	const channelIds = [config.supportChannelId, config.mentionChannelId].filter(Boolean);
	let threadsSeen = 0, threadsKept = 0, events = 0;

	for (const chId of channelIds) {
		const channel = (await client.channels.fetch(chId).catch(() => null)) as TextChannel | null;
		if (!channel) { log(`  !! cannot fetch channel ${chId}`); continue; }
		const threads = await fetchAllThreads(channel);
		log(`  channel ${channel.name}: ${threads.length} threads`);
		for (const thread of threads) {
			threadsSeen++;
			if (thread.ownerId !== config.ralphBotId) continue; // only threads Ralph opened
			if (sinceMs && (thread.createdTimestamp ?? 0) < sinceMs) continue;
			threadsKept++;

			// question = starter message (fallback to thread name if deleted)
			const starter = await thread.fetchStarterMessage().catch(() => null);
			const openerId = starter?.author?.id ?? thread.ownerId ?? 'unknown';
			const question = (starter?.content?.trim() || thread.name || '(unknown)').slice(0, 4000);
			const createdAt = thread.createdTimestamp ?? starter?.createdTimestamp ?? Date.now();

			const msgs = await threadMessages(thread);
			let openerIsTeam = starter ? await teamCheck(openerId) : false;
			let manipulation = false;
			let sawRalph = false;
			let lastActivity = createdAt;
			const evs: { message_id?: string | null; ts: number; type: string; actor_id?: string; text?: string; data?: unknown }[] = [];

			if (starter) evs.push({ message_id: starter.id, ts: starter.createdTimestamp, type: 'question', actor_id: openerId, text: starter.content });

			for (const m of msgs) {
				if (starter && m.id === starter.id) continue;
				lastActivity = Math.max(lastActivity, m.createdTimestamp);
				if (m.author?.id === config.ralphBotId) {
					sawRalph = true;
					const cls = classifyRalphReply(m.content ?? '', ROLE_MENTION, DEAD_END_REPLY);
					if (cls.type === 'manipulation_flag') manipulation = true;
					evs.push({ message_id: m.id, ts: m.createdTimestamp, type: cls.type, actor_id: m.author.id, text: m.content, data: cls.type === 'escalation' ? { reason: cls.reason } : { message_ids: [m.id] } });
				} else if (m.author) {
					const team = await teamCheck(m.author.id);
					const mentionsRalph = m.mentions?.users?.has(config.ralphBotId) ?? false;
					const type = team ? (mentionsRalph ? 'team_mention' : 'team_reply') : 'user_message';
					evs.push({ message_id: m.id, ts: m.createdTimestamp, type, actor_id: m.author.id, text: m.content });
				}
			}
			// no Ralph message at all → synthetic no_reply (stable id for idempotency)
			if (!sawRalph) evs.push({ message_id: `synthetic:${thread.id}:noreply`, ts: createdAt, type: 'no_reply', data: { kind: 'backfill_unknown' } });

			const excluded_reason = openerIsTeam ? 'internal'
				: config.testAllowBotIds.includes(openerId) ? 'test'
				: manipulation ? 'manipulation' : null;

			events += evs.length;
			if (!dry) {
				store.upsertThread({ thread_id: thread.id, channel_id: chId, opener_id: openerId, opener_is_team: openerIsTeam ? 1 : 0, question, created_at: createdAt, last_activity_at: lastActivity, excluded_reason });
				for (const e of evs) store.insertEvent({ thread_id: thread.id, ...e });
			}
		}
	}
	log(`backfill ${dry ? '(dry) ' : ''}done: ${threadsSeen} threads seen, ${threadsKept} Ralph threads, ${events} events`);
	return { threadsSeen, threadsKept, events };
}
