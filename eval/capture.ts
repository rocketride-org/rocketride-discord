// eval/capture.ts — imported by support.ts (the PRODUCTION bot). Thin, SYNCHRONOUS, and it
// must NEVER throw into Ralph's reply path or noticeably slow it. Every export is wrapped in
// try/catch, logs `!! eval:` on failure, and returns normally. If the store can't open, capture
// disables itself and the bot keeps working exactly as before.

import type { Message, ThreadChannel, GuildMember } from 'discord.js';
import { config, ROLE_MENTION, DEAD_END_REPLY } from './config';
import { Store } from './store';
import { classifyRalphReply } from './rules';

let store: Store | null = null;
let disabled = false;
function db(): Store | null {
	if (disabled) return null;
	try { if (!store) store = new Store(config.dbPath); return store; }
	catch (e) { disabled = true; console.log('!! eval: store init failed, capture disabled:', e instanceof Error ? e.message : e); return null; }
}
function guard(fn: (s: Store) => void): void {
	try { const s = db(); if (s) fn(s); } catch (e) { console.log('!! eval:', e instanceof Error ? e.message : e); }
}

/** Team = carries the escalation role OR is in EVAL_TEAM_USER_IDS. */
export function isTeamMember(member: GuildMember | null | undefined, userId: string): boolean {
	if (config.teamUserIds.includes(userId)) return true;
	return !!member?.roles?.cache?.has(config.escalationRoleId);
}

export function recordQuestion(msg: Message, threadId: string): void {
	guard((s) => {
		const team = isTeamMember(msg.member, msg.author.id);
		s.upsertThread({ thread_id: threadId, channel_id: msg.channelId, opener_id: msg.author.id, opener_is_team: team ? 1 : 0, question: msg.content ?? '', created_at: msg.createdTimestamp, last_activity_at: msg.createdTimestamp, excluded_reason: team ? 'internal' : null });
		s.insertEvent({ thread_id: threadId, message_id: msg.id, ts: msg.createdTimestamp, type: 'question', actor_id: msg.author.id, text: msg.content });
	});
}

export function recordThreadMessage(thread: ThreadChannel, msg: Message, type: 'team_reply' | 'team_mention' | 'user_message'): void {
	guard((s) => {
		s.insertEvent({ thread_id: thread.id, message_id: msg.id, ts: msg.createdTimestamp, type, actor_id: msg.author.id, text: msg.content });
		s.touchThread(thread.id, msg.createdTimestamp);
		s.reopenThread(thread.id);
	});
}

/** One event per Ralph reply that was actually posted. `sentIds` = the sent chunk message ids. */
export function recordRalphReply(thread: ThreadChannel, sentIds: string[], replyText: string, meta?: Record<string, unknown>): void {
	guard((s) => {
		const cls = classifyRalphReply(replyText, ROLE_MENTION, DEAD_END_REPLY);
		s.insertEvent({
			thread_id: thread.id, message_id: sentIds[0] ?? `synthetic:${thread.id}:ralph:${Date.now()}`, ts: Date.now(),
			type: cls.type, actor_id: config.ralphBotId || null, text: replyText,
			data: { ...(cls.type === 'escalation' ? { reason: cls.reason } : {}), message_ids: sentIds, ...(meta ?? {}) },
		});
		s.touchThread(thread.id, Date.now());
		s.reopenThread(thread.id);
	});
}

export function recordNoReply(thread: ThreadChannel, kind: 'model_error' | 'scratchpad' | 'empty' | 'exception', error?: string): void {
	guard((s) => {
		s.insertEvent({ thread_id: thread.id, message_id: `synthetic:${thread.id}:noreply:${Date.now()}`, ts: Date.now(), type: 'no_reply', data: { kind, error } });
		s.reopenThread(thread.id);
	});
}

/** ✅/❌ on a Ralph message, from the thread opener (caller filters). */
export function recordReaction(threadId: string, targetMessageId: string, emoji: string, actorId: string, added: boolean): void {
	guard((s) => {
		s.insertEvent({ thread_id: threadId, message_id: null, ts: Date.now(), type: added ? 'reaction_add' : 'reaction_remove', actor_id: actorId, data: { target_message_id: targetMessageId, emoji } });
		s.reopenThread(threadId);
	});
}
