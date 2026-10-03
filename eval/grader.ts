// eval/grader.ts — Phase 3. Grades quiet threads: LLM labels cause + drafts a KB answer,
// retrieval analysis records DOC GAPS (content_gap), then decideOutcome/decideCause + save.
// Escalation-success refinement is deferred (handoff default: escalations are failures).

import { RocketRideClient } from 'rocketride';
import { config } from './config';
import { detectEngineUri, SerialPipe } from './engine';
import type { Store } from './store';
import { decideOutcome, decideCause, type EvalEvent, type GraderSignals } from './rules';

type Log = (...a: unknown[]) => void;
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}.txt`;

const roleOf = (t: string) => (t === 'ralph_answer' || t === 'escalation' || t === 'dead_end' ? 'ralph' : t === 'team_reply' || t === 'team_mention' ? 'team' : t === 'question' || t === 'user_message' ? 'user' : 'other');

function firstAnswer(res: any): string {
	const rt = res?.result_types ?? {};
	for (const [k, v] of Object.entries(rt)) if (v === 'answers' && Array.isArray(res[k])) return String(res[k][0] ?? '');
	return Array.isArray(res?.answers) ? String(res.answers[0] ?? '') : '';
}
function parseJson(s: string): any | null { try { const m = s.match(/\{[\s\S]*\}/); return JSON.parse(m ? m[0] : s); } catch { return null; } }

async function retrieve(pipe: SerialPipe, text: string): Promise<{ top: number; ids: Set<string> }> {
	const res: any = await pipe.send(text.slice(0, 4000), uniq('retr'));
	const docs: any[] = res?.documents ?? [];
	const top = docs.length ? Math.max(...docs.map((d) => d.score ?? 0)) : 0;
	const ids = new Set(docs.filter((d) => (d.score ?? 0) >= 0.7).map((d) => `${d.metadata?.objectId}:${d.metadata?.chunkId}`));
	return { top, ids };
}

const toEvents = (rows: any[]): EvalEvent[] => rows.map((r) => ({ type: r.type, actor_id: r.actor_id, ts: r.ts, data: r.data ? JSON.parse(r.data) : undefined }));

export async function gradeOnce(store: Store, opts: { limit?: number; log: Log }) {
	const { limit, log } = opts;
	const rr = new RocketRideClient({ uri: detectEngineUri(), auth: config.rocketrideApiKey } as any);
	await rr.connect();
	const grader = new SerialPipe(rr, config.graderPipe);
	const retr = new SerialPipe(rr, config.retrievePipe);
	await grader.start();
	await retr.start();
	let graded = 0, excluded = 0, failed = 0;
	const causes: Record<string, number> = {};
	try {
		const threads = store.getOpenThreadsForGrading(Date.now() - config.quietHours * 3600_000, limit);
		log(`grading ${threads.length} thread(s)`);
		for (const t of threads) {
			const rows = store.getThreadEvents(t.thread_id);
			const events = toEvents(rows);
			const thread = { opener_id: t.opener_id, opener_is_team: !!t.opener_is_team, channel_id: t.channel_id };
			const exOpts = { testAllowBotIds: config.testAllowBotIds, testChannelIds: [] as string[] };

			// cheap: excluded threads need no LLM
			const pre = decideOutcome(thread, events, {}, exOpts);
			if (pre.excluded_reason) { store.saveExcluded(t.thread_id, pre.excluded_reason); excluded++; continue; }

			// grader LLM
			const transcript = rows.filter((r) => r.text).map((r) => ({ role: roleOf(r.type), text: String(r.text).slice(0, 1500) }));
			const escEv = rows.find((r) => r.type === 'escalation');
			const input = JSON.stringify({ question: t.question, transcript, escalation: { present: !!escEv, text: escEv?.text ?? '' }, clusters: store.getClustersList() });
			const g = parseJson(firstAnswer(await grader.send(input, uniq('grade'))));
			if (!g) { failed++; log(`  parse fail ${t.thread_id} — left open`); continue; }

			let clusterId: number | null = g.cluster?.id ?? null;
			if (g.cluster?.new?.label) clusterId = store.upsertCluster(g.cluster.new.label, g.cluster.new.description);

			// retrieval analysis (doc-gap detection)
			const qR = await retrieve(retr, t.question);
			const teamText = rows.filter((r) => r.type === 'team_reply' || r.type === 'team_mention').map((r) => r.text).filter(Boolean).join('\n\n');
			let aTop: number | null = null, overlap = false, teamAnswerExists = false;
			if (teamText) { teamAnswerExists = true; const aR = await retrieve(retr, teamText); aTop = aR.top; overlap = [...aR.ids].some((id) => qR.ids.has(id)); }

			const signals: GraderSignals = { team_reply_kind: g.team_reply_kind, user_signal: g.user_signal, escalation_category: g.escalation_category, llm_cause: g.llm_cause };
			const { outcome } = decideOutcome(thread, events, signals, exOpts);
			const cause = decideCause(outcome, events, signals, { aTop, overlap, teamAnswerExists, matchScore: config.matchScore });
			store.saveGrade(t.thread_id, { outcome, cause, q_top_score: qR.top, a_top_score: aTop, grader_json: JSON.stringify({ ...g, _auto_outcome: outcome, _auto_cause: cause }), cluster_id: clusterId });
			if (g.qa_draft?.answer) store.insertQaDraft(t.thread_id, g.qa_draft.question ?? t.question, g.qa_draft.answer);
			graded++;
			causes[cause ?? '(success)'] = (causes[cause ?? '(success)'] ?? 0) + 1;
			log(`  ${t.thread_id}: ${outcome} / ${cause ?? '-'}${cause === 'content_gap' ? '  <-- DOC GAP' : ''}`);
		}
	} finally {
		await grader.stop().catch(() => {});
		await retr.stop().catch(() => {});
		await rr.disconnect().catch(() => {});
	}
	log(`grade-once done: ${graded} graded, ${excluded} excluded, ${failed} parse-failed`);
	log(`  causes: ${Object.entries(causes).map(([k, v]) => `${k}:${v}`).join(', ') || '(none)'}`);
	return { graded, excluded, failed, causes };
}
