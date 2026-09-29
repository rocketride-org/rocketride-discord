// eval/rules.ts — PURE functions, fully unit-tested. Backfill and the live grader call the
// same functions so historical and live labels are identical (handoff requirement).
//
// Phase 2 scope: reply classification, team membership, exclusion, and Wilson.
// decideOutcome/decideCause are deferred to Phase 3 (they depend on grader signals and on
// the still-open "escalation = success" decision).

export type RalphReplyType = 'ralph_answer' | 'escalation' | 'manipulation_flag' | 'dead_end';
export type EscReason = 'tool_github' | 'tool_http' | null;
export interface ReplyClass { type: RalphReplyType; reason?: EscReason; }

// Escalation phrasings from the agent instructions in pipelines/rocket-ralph.pipe (stable enough to regex).
const RE_MANIPULATION = /heads up, someone just asked me to/i;
const RE_TOOL_GITHUB = /issue reaching GitHub/i;
const RE_TOOL_HTTP = /issue loading that page/i;
const RE_TEAM_TEXT = /@RocketRide\s+team/i;

/** Classify a Ralph reply. `roleMention` is the resolved <@&role> string; `deadEndReply` the canned fallback. */
export function classifyRalphReply(reply: string, roleMention: string, deadEndReply: string): ReplyClass {
	const r = (reply ?? '').trim();
	if (deadEndReply && r === deadEndReply.trim()) return { type: 'dead_end' };
	const escalated = (roleMention && r.includes(roleMention)) || RE_TEAM_TEXT.test(r);
	if (escalated) {
		if (RE_MANIPULATION.test(r)) return { type: 'manipulation_flag' };
		let reason: EscReason = null;
		if (RE_TOOL_GITHUB.test(r)) reason = 'tool_github';
		else if (RE_TOOL_HTTP.test(r)) reason = 'tool_http';
		return { type: 'escalation', reason };
	}
	return { type: 'ralph_answer' };
}

/** A responder counts as team if they carry the escalation role OR are in the explicit id list. */
export function isTeamMember(roleIds: string[], userId: string, escalationRoleId: string, teamUserIds: string[]): boolean {
	if (teamUserIds.includes(userId)) return true;
	return !!escalationRoleId && roleIds.includes(escalationRoleId);
}

/** Wilson score interval. Returns [low, high] in [0,1], or null when n <= 0. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] | null {
	if (n <= 0) return null;
	const p = successes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Round a [lo,hi] interval to 3dp for display/tests (null-safe). */
export function roundInterval(iv: [number, number] | null, dp = 3): [number, number] | null {
	if (!iv) return null;
	const f = 10 ** dp;
	return [Math.round(iv[0] * f) / f, Math.round(iv[1] * f) / f];
}

// ---- Outcome + cause (Phase 3). Escalation-success refinement is DEFERRED per decision:
// for now every escalation is a failure (handoff default). ----

export type Outcome =
	| 'excluded' | 'deferred' | 'deferred_unanswered' | 'overridden' | 'dead_end'
	| 'no_reply' | 'rejected' | 'reasked' | 'resolved_confirmed' | 'resolved_unconfirmed';
export type Cause =
	| 'tool_error' | 'engine_error' | 'policy_public' | 'policy_account' | 'policy_other'
	| 'product_defect' | 'feature_request' | 'content_gap' | 'bad_answer' | 'retrieval_miss' | 'unknown';

export interface EvalEvent { type: string; actor_id?: string | null; ts: number; data?: any; }
export interface ThreadInfo { opener_id: string; opener_is_team: boolean; channel_id?: string; }
export interface GraderSignals {
	team_reply_kind?: 'none' | 'ack' | 'correction' | 'addition';
	user_signal?: 'confirmed' | 'rejected' | 'neutral';
	escalation_category?: 'policy_public' | 'policy_account' | 'policy_other' | 'knowledge' | null;
	llm_cause?: 'product_defect' | 'feature_request' | null;
}

const FAILURES = new Set<Outcome>(['deferred', 'deferred_unanswered', 'overridden', 'dead_end', 'no_reply', 'rejected', 'reasked']);
export const isFailure = (o: Outcome) => FAILURES.has(o);
export const isExcluded = (o: Outcome) => o === 'excluded';

/** Latest ✅/❌ reaction added by the opener. */
function latestOpenerReaction(events: EvalEvent[], openerId: string): '✅' | '❌' | null {
	let r: '✅' | '❌' | null = null;
	for (const e of events) if (e.type === 'reaction_add' && e.actor_id === openerId && (e.data?.emoji === '✅' || e.data?.emoji === '❌')) r = e.data.emoji;
	return r;
}

export function decideOutcome(
	thread: ThreadInfo,
	events: EvalEvent[],
	g: GraderSignals = {},
	opts: { testAllowBotIds?: string[]; testChannelIds?: string[] } = {},
): { outcome: Outcome; excluded_reason?: string } {
	const ev = [...events].sort((a, b) => a.ts - b.ts);
	// excluded
	if (thread.opener_is_team) return { outcome: 'excluded', excluded_reason: 'internal' };
	if ((opts.testAllowBotIds ?? []).includes(thread.opener_id) || (opts.testChannelIds ?? []).includes(thread.channel_id ?? '')) return { outcome: 'excluded', excluded_reason: 'test' };
	if (ev.some((e) => e.type === 'manipulation_flag')) return { outcome: 'excluded', excluded_reason: 'manipulation' };

	const escIdx = ev.findIndex((e) => e.type === 'escalation');
	const hasEsc = escIdx >= 0;
	const teamReplyAfterEsc = hasEsc && ev.slice(escIdx + 1).some((e) => e.type === 'team_reply');
	const hasTeamReply = ev.some((e) => e.type === 'team_reply');
	const ralphEvents = ev.filter((e) => ['ralph_answer', 'escalation', 'manipulation_flag', 'dead_end', 'no_reply'].includes(e.type));
	const lastRalph = ralphEvents[ralphEvents.length - 1];
	const reaction = latestOpenerReaction(ev, thread.opener_id);

	// failures (first match wins)
	if (hasEsc && teamReplyAfterEsc) return { outcome: 'deferred' };
	if (hasEsc && !teamReplyAfterEsc) return { outcome: 'deferred_unanswered' };
	if (hasTeamReply && !hasEsc && (g.team_reply_kind === 'correction' || g.team_reply_kind === 'addition')) return { outcome: 'overridden' };
	if (lastRalph?.type === 'dead_end') return { outcome: 'dead_end' };
	if (!lastRalph || lastRalph.type === 'no_reply') return { outcome: 'no_reply' };
	if (reaction === '❌' || g.user_signal === 'rejected') return { outcome: 'rejected' };
	// successes
	if (reaction === '✅' || g.user_signal === 'confirmed') return { outcome: 'resolved_confirmed' };
	return { outcome: 'resolved_unconfirmed' };
}

/** Retrieval analysis. `aTop` = top score for the team-answer text; `overlap` = a top chunk was already in the question's retrieval. */
export function analyzeRetrieval(aTop: number | null, overlap: boolean, matchScore: number): Cause {
	if (aTop == null || aTop < matchScore) return 'content_gap'; // ← the KB doesn't have it: a DOC GAP
	if (overlap) return 'bad_answer'; // Ralph had it in context and still failed
	return 'retrieval_miss'; // it's in the KB but retrieval didn't surface it
}

export function decideCause(
	outcome: Outcome,
	events: EvalEvent[],
	g: GraderSignals = {},
	retrieval?: { aTop: number | null; overlap: boolean; teamAnswerExists: boolean; matchScore: number },
): Cause | null {
	if (!isFailure(outcome)) return null;
	const esc = events.find((e) => e.type === 'escalation');
	if (esc?.data?.reason === 'tool_github' || esc?.data?.reason === 'tool_http') return 'tool_error';
	if (outcome === 'dead_end' || outcome === 'no_reply') return 'engine_error';
	if ((outcome === 'deferred' || outcome === 'deferred_unanswered') && g.escalation_category && g.escalation_category !== 'knowledge') return g.escalation_category as Cause;
	if (g.llm_cause === 'product_defect' || g.llm_cause === 'feature_request') return g.llm_cause;
	if (retrieval && retrieval.teamAnswerExists) return analyzeRetrieval(retrieval.aTop, retrieval.overlap, retrieval.matchScore);
	return 'unknown';
}
