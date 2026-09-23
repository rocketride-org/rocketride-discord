// eval/config.ts — the ONLY reader of process.env for eval code (guardrail).
// Everything else imports `config` / `ROLE_MENTION` from here.
import 'dotenv/config';

const num = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
	// eval store + bot
	dbPath: process.env.EVAL_DB_PATH || 'logs/ralph-eval.sqlite',
	botToken: process.env.EVAL_BOT_TOKEN || '',
	reviewChannelId: process.env.EVAL_REVIEW_CHANNEL_ID || '',
	ralphBotId: process.env.EVAL_RALPH_BOT_ID || '',
	teamUserIds: list(process.env.EVAL_TEAM_USER_IDS),
	feedbackReactions: (process.env.EVAL_FEEDBACK_REACTIONS || 'false') === 'true',

	// support channels / role (shared with the production bot)
	supportChannelId: process.env.SUPPORT_CHANNEL_ID || '',
	mentionChannelId: process.env.SUPPORT_MENTION_CHANNEL_ID || '',
	escalationRoleId: process.env.SUPPORT_ESCALATION_ROLE_ID || '1331418231113650196',
	testAllowBotIds: list(process.env.TEST_ALLOW_BOT_IDS),

	// tunables
	target: num(process.env.EVAL_TARGET, 0.60),          // current headline target (0.90 aspirational)
	targetAspirational: 0.90,
	windowDays: num(process.env.EVAL_WINDOW_DAYS, 28),
	matchScore: num(process.env.EVAL_MATCH_SCORE, 0.7),
	quietHours: num(process.env.EVAL_QUIET_HOURS, 48),
	reaskDays: num(process.env.EVAL_REASK_DAYS, 14),
	tz: process.env.EVAL_TZ || 'America/Los_Angeles',
	gradeHour: num(process.env.EVAL_GRADE_HOUR, 1),

	// pipes / engine (Phase 3+)
	retrievePipe: process.env.EVAL_RETRIEVE_PIPE || 'pipelines/eval-retrieve.pipe',
	graderPipe: process.env.EVAL_GRADER_PIPE || 'pipelines/eval-grader.pipe',
	judgePipe: process.env.EVAL_JUDGE_PIPE || 'pipelines/eval-judge.pipe',
	ragPipe: process.env.EVAL_RAG_PIPE || 'pipelines/rag.pipe',            // Phase 6a KB ingest (→ ROCKETRIDE_DOCS)
	// Phase 5 replay: fixed project_ids for the isolated pipe copies — MUST differ from every prod pipe.
	replayProjectIds: list(process.env.EVAL_REPLAY_PROJECT_IDS).length === 2
		? list(process.env.EVAL_REPLAY_PROJECT_IDS)
		: ['d4e8f0a2-1b3c-4d5e-8f70-a1b2c3d4e5f6', 'a1b3c5d7-9e0f-4213-8546-7b8c9d0e1f20'],
	rocketrideApiKey: process.env.ROCKETRIDE_APIKEY,
	rocketrideUri: process.env.ROCKETRIDE_URI,
};

export const ROLE_MENTION = `<@&${config.escalationRoleId}>`;

// The literal canned fallback Ralph posts when a part errors/times out (see support.ts combineIfNeeded).
export const DEAD_END_REPLY = 'Sorry — I could not process that.';
