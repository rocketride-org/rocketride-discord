# Phase 0 — verify before building (findings)

Verification status for the Rocket Ralph eval system, per the implementation handoff.
This file is the Phase 0 PR description. ✅ = verified · 🟡 = partial · 🔴 = blocked on Joshua.

## Verification answers

1. **Team role coverage — 🟡 partial.** Joshua's Discord user id = `1331407698159341583` → goes in `EVAL_TEAM_USER_IDS`. Still open: confirm every *other* #support answerer carries `@RocketRide team` (`SUPPORT_ESCALATION_ROLE_ID`), or list their ids. *(owner: Joshua)*
2. **Guardrail seeds — 🔴 open.** Need the July 16 OC Startup Roundtable thread IDs to seed guardrail golden cases (Phase 5). *(owner: Joshua)*
3. **Retrieval output — ✅ verified.** Built `pipelines/eval-retrieve.pipe`: `webhook → parse → question → embedding_transformer(miniLM) → qdrant(ROCKETRIDE_DOCS_EVAL, score 0.3) → response_documents`.
   - Response provider = **`response_documents`**, lane = **`documents`**.
   - Each returned doc carries: **`page_content`** (text), **`score`** (rescaled similarity 0–1), and a stable id via **`metadata.objectId`** (per source file) + **`metadata.chunkId`** (per chunk). Use `${objectId}:${chunkId}` — no sha256 fallback needed.
   - **Doc-gap signal:** querying *"connect to staging + developer ID"* returns clients/CLI/Sequelize chunks (top score 0.68), **not** staging/dev-id setup — confirms the meeting-notes gap that staging/cloud/dev-id isn't in llms.txt.
4. **Instance isolation — ✅ verified (principle).** A separate pipe with its own `project_id` (`rag-eval.pipe`, `eval-retrieve.pipe`) runs on the shared engine (port 62299) alongside the **live production support bot** without disturbing it. Distinct `project_id` → distinct pipeline token, so `use({useExisting})` on an eval pipe never touches `rocket-ralph`'s token. Phase-5 replay copies must still use distinct `project_id`s + the `.eval/` path guard.
   - ⚠ **Finding for `eval/engine.ts`:** `detectEngineUri()`'s `head -1` is unreliable here — **13 engine ports** are listening (20000–20011, 53600, 62299); it picked `20006`, but prod actually uses **62299**. The eval copy must pick the control port deterministically (match what support logs / health-check), not `head -1`.
5. **`node:sqlite` — ✅ verified.** `DatabaseSync` works under **Node v26.3.0 via tsx** (no flag). No `better-sqlite3`, no new npm dependency.
6. **Re-ingest semantics — ✅ verified: replaces, not duplicates.** Ingesting the same upload name twice via `rag-eval.pipe` left `ROCKETRIDE_DOCS_EVAL` at **14 points** both times. Phase 6 KB ingest can safely re-ingest by name; edits = re-ingest same name (or delete-then-ingest).
7. **Bot setup — ✅ done.** New application **Rocket-Ralph-Eval** (bot user id `1551839144572092446`); `EVAL_BOT_TOKEN` + `EVAL_REVIEW_CHANNEL_ID` + `EVAL_RALPH_BOT_ID` set in `.env`. Privileged **Message Content** + **Server Members** intents enabled. Verified it **reads #support** (View + Read History) and **posts embeds to the private #ralph-eval review channel**.
   - Separate follow-up (Phase 1): Ralph's/support bot needs the non-privileged **`GuildMessageReactions`** intent for ✅/❌ capture.

## Artifacts produced
- `pipelines/rag-eval.pipe` — ingest into `ROCKETRIDE_DOCS_EVAL` (`project_id e7a1c9d4-…`)
- `pipelines/eval-retrieve.pipe` — retrieval-analysis query (`project_id b2c8f5a1-…`)
- Collection **`ROCKETRIDE_DOCS_EVAL`** built from https://docs.rocketride.org/llms.txt (14 chunks)
- `EVAL_*` config added to `.env.example`

## Amendments to reconcile (from the "Ralph Performance" meeting notes)
- **Target:** notes say **60–70%** (current ~30%); handoff says **~90%**. Align the headline number.
- **Escalation ≠ always failure:** some escalations are *correct* (interview/hiring token → Joe/Ben; policy per Ben's app-policy doc). `decideOutcome`/`decideCause` must treat those as **success/neutral**, not a `deferred` failure. This **contradicts the locked "policy escalations count as failures" decision** → needs Joshua's sign-off before Phase 1 `rules.ts`.
- **Doc gaps are a first-class output** (staging/cloud/dev-id) — already covered by the `content_gap` retrieval analysis; item 3 above shows it working.

## Remaining before the Phase 0 gate
- 🔴 [Joshua] Roundtable thread IDs (item 2)
- 🔴 [Joshua] Full team-role coverage confirmation (item 1)
- 🔴 [Joshua] Escalation-success definition (the amendment)
- **Gate:** Joshua reviews these answers → Phase 1 (store + rules + live capture) begins.
