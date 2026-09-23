# Phases 4–6 + wiring — built

## Phase 4 — review queue + weekly summary ✅ built + verified
- `eval/review.ts`:
  - **Weekly summary** embed — success rate + Wilson vs the **60% target**, outcomes, failures-by-cause (`content_gap` marked 📄), **policy floor**, top clusters, **doc-gap count**, grader agreement.
  - **Review cards** — cause select, cluster select, Confirm / Mark-resolved / Mark-failed / Exclude buttons, **Edit & approve Q/A** modal, and a New-issue link button.
  - **Interaction handler** — team-gated (`@RocketRide team` role or `EVAL_TEAM_USER_IDS`); every action stamps `outcome_source`/`cause_source='review'` + reviewer; **approving a Q/A creates a golden case** (`expected=escalate` for policy_account/other, else `answer`).
- **Verified:** posted a real weekly summary **and** 3 review cards to `#ralph-eval`. Live clicks are handled by the `--serve` process.
- CLI: `--summary-once`, `--review-once`.

## Phase 5 — golden set + replay ✅ built (not run — needs seeds + gate)
- `support.ts`: added `--send-batch <file.jsonl> --json` — runs each `{id,question}` through the real answer path, prints `{id,raw,shown,escalated}`. Neither `--send-once` nor `--send-batch` starts the bot.
- `eval/replay.ts`: regenerates **isolated** copies `pipelines/.eval/*.eval.pipe` with distinct `project_id`s; `assertIsolated()` aborts on any collision with a prod pipe; spawns `support.ts --send-batch` with `PIPE`/`SYNTH_PIPE` pointed at the copies; scores (expect escalate → pass iff escalated, answering = **HARD FAIL**; expect answer + escalated → fail; else judge via `eval-judge.pipe`); stores the run (git sha + pipe sha256) + results; reports pass rate, hard fails, **regressions** vs the previous run.
- `pipelines/eval-judge.pipe` (openai-5-4); `pipelines/.eval/` gitignored.
- CLI: `--golden-from-thread <id> --expect ..`, `--golden-add`, `--export-golden`, `--replay`.
- **Not run:** golden set is empty until Joshua's Roundtable seeds + review approvals, and a first live replay is behind the Phase-5 gate (must prove prod keeps answering).

## Phase 6a — KB ingest ✅ built (not run — writes prod KB, gated on approvals)
- `eval/ingest.ts`: approved, un-ingested Q/A → temp `.md` → `rag.pipe` (→ `ROCKETRIDE_DOCS`); marks ingested (re-ingest replaces, verified Phase 0). CLI: `--ingest-approved`.
- 6b (public FAQ) is gated on Joshua — not built.

## Wiring
- `start/stop/status-bots.sh`: added **`eval`** → `tsx eval/main.ts --serve` (online: review interactions + nightly grade 01:00 + weekly summary Mon 09:00, `EVAL_TZ`).
- `package.json`: `npm test` → **22/22**.

## Still not built (decision- or input-gated)
- Phase 1 **live wiring** into `support.ts` (deploy-gated; exact patch in `PHASE3.md`).
- `decideOutcome` **escalation-success** refinement (Joshua) — currently handoff default (escalation = failure).
- Phase 6b FAQ (Joshua), Phase 7 (conditional on grader agreement).
