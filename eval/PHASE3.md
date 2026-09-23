# Phase 3 (grader) + Phase 1 (capture module) — built & verified

Built decision-free, using the settled calls: **target 60%** (90% aspirational), **escalation = failure**
(handoff default; success-refinement deferred), and **doc gaps recorded** as `content_gap`.

## Phase 3 — nightly grader ✅ built + smoke-tested
- `pipelines/eval-grader.pipe` — webhook → prompt → `llm_openai` (**openai-5-4**) → response_answers; own `project_id`.
- `eval/rules.ts` — `decideOutcome` + `decideCause` + `analyzeRetrieval` (**`content_gap` = the DOC GAP signal**). Unit-tested.
- `eval/engine.ts` — `detectEngineUri()` with the Phase-0 fix (pick the highest engine port; `ROCKETRIDE_URI` overrides) + `SerialPipe` (unique names, serialized sends, restart after each — for prompt-node pipes).
- `eval/grader.ts` — `gradeOnce`: selects quiet open threads, excludes the cheap ones without an LLM call, LLM-grades, clusters, runs `eval-retrieve` on the question **and** the team answer to detect doc gaps, then `decideOutcome`/`decideCause`, saves outcome/cause/scores/qa_draft, reopens on new events.
- CLI: `tsx eval/main.ts --grade-once [--limit N]`. The report now shows graded outcomes, causes, **DOC GAPS**, and the confirmed-success rate vs the 60% target.
- **Smoke test (3 threads):** `resolved_unconfirmed` · `overridden → product_defect` · `deferred → content_gap` — the Sachin staging/OpenAI-key thread was auto-flagged a **DOC GAP**. Works end-to-end.

## Phase 1 — capture ✅ module built; ⏳ prod wiring is a deploy step
- `eval/capture.ts` — thin, synchronous, **never throws**; `recordQuestion` / `recordThreadMessage` / `recordRalphReply` / `recordNoReply` / `recordReaction` + `isTeamMember`. Store `touchThread`/`reopenThread` added.
- **Remaining = wire it into `support.ts` (the PROD bot).** That edits the live bot, so it's behind Joshua's review + deploy. The patch:
  1. Case 1 (after `startThread`): `capture.recordQuestion(msg, thread.id)`
  2. Case 2 (before the paused check): team-reply pause + `recordThreadMessage` — also fixes Ralph answering engineers
  3. `handle()`: extract `DEAD_END_REPLY` const; `recordRalphReply(sentIds, reply, …)` on post, `recordNoReply` on the empty/error early-return and the `catch`
  4. Add `GuildMessageReactions` intent + partials + reaction listeners → `capture.recordReaction` (opener ✅/❌ on Ralph messages)
  5. Optional `EVAL_FEEDBACK_REACTIONS` flag → Ralph adds ✅/❌
  (Not applied here — can't test live on the prod mini without a dev bot/test channel.)

## Remaining decision-free work (next)
- **Phase 4** — review cards + weekly summary in `#ralph-eval` (buttons/modals). Building it is decision-free; "going live" is a gate.
- **Phase 5** — golden set + replay. Needs Joshua's **Roundtable seed thread IDs** to be useful; then `--send-batch` + `eval-judge.pipe` + isolated replay copies.
- **Phase 6** — 6a KB ingest of approved Q/A (needs Phase 4 approvals to have input); 6b FAQ is gated on Joshua.

## Commands
```
npm test                                   # 22/22
tsx eval/main.ts --backfill                # rebuild event log
tsx eval/main.ts --grade-once [--limit N]  # nightly grader (records doc gaps)
tsx eval/main.ts --report --window 28|all  # baseline + graded + doc gaps
```
