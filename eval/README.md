# Rocket Ralph Eval — measurement & feedback loop

A closed loop that measures how well the Discord support bot (**Rocket Ralph**, `support.ts`)
does, explains *why* it misses, and feeds good human answers back into its knowledge base and a
regression set.

**Goal:** raise how often Ralph resolves a thread **on its own** (no human needed) from a
**~27.5% baseline** (28-day upper bound, measured from history) toward the **60% target**
(90% aspirational).

Everything here is **best-effort and gated**: capture never throws into Ralph's reply path, and
nothing writes to production (the KB, the public FAQ) without a human approval step.

---

## The loop

```
 Discord support thread
      │   capture.ts  (imported by support.ts — guarded, node:sqlite)
      ▼
 [1] CAPTURE ─────────► logs/ralph-eval.sqlite
      │   every question · Ralph reply (+classification) · team reply · no-reply · ✅/❌ reaction
      ▼
 [2] GRADE  (nightly 01:00)      eval-grader.pipe  (OpenAI GPT-5.4)
      │   labels cause + outcome, flags documentation gaps, drafts a better answer
      ▼
 [3] REVIEW  #ralph-eval         review cards + weekly scorecard  (team-gated buttons)
      │   a human confirms/corrects the grade, and can approve a canonical Q/A
      ├──────────────► [4] REPLAY (weekly, gated)   eval-judge.pipe (GPT-5.4)
      │                    re-runs the golden questions through isolated pipe copies,
      │                    reports pass-rate + regressions (never touches prod pipes)
      └──────────────► [5] KB WRITEBACK             rag.pipe → qdrant ROCKETRIDE_DOCS
                           approved Q/A is embedded so Ralph retrieves it next time
```

---

## Files

| File | Role |
|------|------|
| `capture.ts` | Thin, synchronous, **import-safe** recorder used by `support.ts`. Every export is guarded — it can never throw into or slow Ralph's reply path. |
| `store.ts` | SQLite repository (built-in `node:sqlite`, WAL + busy_timeout). Every SQL statement lives here. DB at `logs/ralph-eval.sqlite`. |
| `rules.ts` | Pure logic: classify a Ralph reply (answer / escalation / dead-end), outcome/failure taxonomy, Wilson interval. |
| `config.ts` | The **only** reader of `process.env` for eval code (guardrail). Everything else imports `config`. |
| `grader.ts` | Phase 3 — calls the grader pipe to label cause/outcome, flag doc gaps, draft answers. |
| `review.ts` | Phase 4 — review cards + weekly scorecard in `#ralph-eval`; team-gated buttons/selects/modals. |
| `replay.ts` | Phase 5 — regenerates **isolated** pipe copies (`pipelines/.eval/*.eval.pipe`, distinct `project_id`s, gitignored), runs the golden set through `support.ts --send-batch`, judges, reports regressions. Aborts if a copy's id collides with a prod pipe. |
| `ingest.ts` | Phase 6a — approved Q/A → `rag.pipe` → `ROCKETRIDE_DOCS` (Ralph's KB). Idempotent (guarded by `ingested_at`). |
| `engine.ts` | Local-engine detection (targets the `eaas` control port — eval uses the **local** qdrant, so it must hit the local engine even if `ROCKETRIDE_URI` points at Cloud) + `SerialPipe` (serialized sends, instance restart after each — prompt nodes accumulate context otherwise). |
| `backfill.ts` | Phase 2 — reconstruct history into the store to compute the baseline. |
| `main.ts` | CLI entrypoint + the `--serve` daemon. |
| `replay-seeds.md` | Candidate regression questions (drawn from real threads) for the golden set. |
| `PHASE*.md` | Build notes per phase (how each was verified). |
| `../pipelines/eval-grader.pipe` · `eval-judge.pipe` · `eval-retrieve.pipe` · `rag-eval.pipe` | The RocketRide pipes the eval drives. |
| `../tests/eval/*.test.ts` | Unit tests for `rules` and `store` (`npm test`). |

---

## Running it

The **`eval` bot** is `tsx eval/main.ts --serve`, registered in `start-bots.sh`:

```bash
./start-bots.sh eval        # start   (./stop-bots.sh eval / ./status-bots.sh eval)
```

`--serve` stays online and: handles review-card clicks, **grades nightly at 01:00**, and posts the
**weekly scorecard Mon 09:00** (`EVAL_TZ`, default `America/Los_Angeles`).

One-off commands (run with the nvm node on `PATH` — see `start-bots.sh`):

```bash
tsx eval/main.ts --report [--window 28|all]   # current numbers on demand
tsx eval/main.ts --grade-once [--limit N]     # grade ungraded threads now
tsx eval/main.ts --summary-once               # post the weekly scorecard now
tsx eval/main.ts --review-once                # post pending review cards now
tsx eval/main.ts --replay [--limit N]         # run the golden set (gated)
tsx eval/main.ts --ingest-approved            # push approved Q/A into the KB
tsx eval/main.ts --backfill                   # rebuild history (baseline)
# golden set: --golden-from-thread <id> --expect escalate|answer | --golden-add … | --export-golden
```

---

## How capture is wired into the support bot (`support.ts`)

`support.ts` imports `eval/capture.ts` and calls it at these points (all guarded):

- **`recordQuestion`** — when a new support thread is opened.
- **`recordThreadMessage`** — on every follow-up message in a thread, classified `team_reply` /
  `team_mention` / `user_message` (recorded **before** any early return, so a team member helping
  in a paused thread still counts as "a human stepped in").
- **`recordRalphReply`** — after Ralph posts, with the sent message ids + the reply's classification.
- **`recordNoReply`** — when a reply is suppressed (model error / empty / exception).
- **`recordReaction`** — via a `MessageReactionAdd/Remove` listener, when someone puts ✅/❌ on one
  of Ralph's messages.

**✅/❌ feedback** is opt-in via `EVAL_FEEDBACK_REACTIONS=true`: Ralph then adds ✅/❌ to each answer
so the asker can grade it in one click. This requires the `GuildMessageReactions` intent +
`Partials` (both added in `support.ts`).

"Team" = anyone with the escalation role (`SUPPORT_ESCALATION_ROLE_ID`) **or** listed in
`EVAL_TEAM_USER_IDS`. Team members' own posts are excluded from "real questions," and a team reply
marks a thread as human-resolved (not a Ralph solo win).

---

## Operating: the review flow (`#ralph-eval`)

**Weekly scorecard** — success rate vs the 60% target (with a 95% Wilson interval), outcomes,
failures-by-cause (`content_gap` marked 📄), policy floor, top clusters, doc-gap count, and grader
agreement.

**Review cards** — one per gradable thread, team-gated. Each card leads with its current state
and a one-line prompt so the reviewer knows the ask before clicking:

- 🔵 **Needs a verdict** — Ralph answered but nothing confirmed it worked; you decide.
- 🔴 **Counted as a miss** (with the reason) — confirm it, flip it, or teach the fix.
- ✅ **Counted as resolved** / 🚫 **Excluded** — after a decision; can be flipped back.

The controls are worded as plain outcomes (no enum jargon), and the **layout is always
`[agree/keep] · [flip] · [exclude]`**:

| Button | What happens when you click it |
|---|---|
| ✅ **Ralph resolved it** / 👍 **Yes, resolved** | Counts the thread as a **success**. |
| ❌ **Ralph missed it** / **Actually a miss** | Counts it **against** the success rate. |
| 👍 **Yes, a miss** | Confirms the graded miss, **keeping** its specific reason. |
| ✅ **Actually resolved** | Flips a graded miss to a **success**. |
| 🚫 **Not a real question** | **Excludes** it from the metric (noise/internal). |
| 📚 **Teach Ralph the answer** | Modal (question + answer). On submit: approves the Q/A, seeds a **golden regression case**, and **ingests it straight into Ralph's KB** (`ROCKETRIDE_DOCS`) — no CLI step. |
| 🐛 **File a GitHub issue** | Opens a pre-filled *new issue* page (a link — it does **not** auto-create; the bot is read-only on GitHub). |
| **reason ▾** (dropdown) | Sets/corrects why Ralph missed, in plain language (Doc gap, Retrieval miss, Bad answer, Policy…). |

**Every click replies with a short ephemeral note** (visible only to the clicker) stating the effect —
e.g. *"✅ Marked resolved — now counts as a success"* — and the card itself refreshes to the new
state. Clicks acknowledge instantly (deferred) so they never hit Discord's 3-second timeout — the
`eval` bot must be running for them to respond.

---

## Configuration (`.env`)

| Var | Meaning |
|---|---|
| `EVAL_BOT_TOKEN` | The eval bot's Discord token (separate from Ralph's). |
| `EVAL_REVIEW_CHANNEL_ID` | Channel for review cards + scorecards (`#ralph-eval`). |
| `EVAL_RALPH_BOT_ID` | Ralph's user id (attributes Ralph's replies in capture). |
| `EVAL_TEAM_USER_IDS` | Comma-separated user ids that count as "team" (in addition to the role). |
| `EVAL_FEEDBACK_REACTIONS` | `true` → Ralph adds ✅/❌ + records grades. |
| `EVAL_DB_PATH` | SQLite path (default `logs/ralph-eval.sqlite`). |
| `EVAL_TARGET` / `EVAL_WINDOW_DAYS` / `EVAL_TZ` / `EVAL_GRADE_HOUR` | Tunables (defaults 0.60 / 28 / America/Los_Angeles / 1). |
| `EVAL_*_PIPE`, `EVAL_REPLAY_PROJECT_IDS` | Pipe paths + isolated replay project ids. |
| `ROCKETRIDE_OPENAI_KEY` | Used by the grader/judge pipes (via `${...}` substitution). |
| shared: `SUPPORT_CHANNEL_ID`, `SUPPORT_MENTION_CHANNEL_ID`, `SUPPORT_ESCALATION_ROLE_ID` | Channels + team role. |

> `.env` and `data/slack-experts.json` are **gitignored** (secrets / real member ids). The eval
> store (`logs/ralph-eval.sqlite`) is local.

---

## Models

| Job | Model |
|---|---|
| Grader + Judge (`eval-grader.pipe`, `eval-judge.pipe`) | OpenAI **GPT-5.4** (`openai-5-4`) |
| Retrieval / q-a similarity (`eval-retrieve.pipe`) | **miniLM** embeddings (same as Ralph's RAG; matches the 384-dim `ROCKETRIDE_DOCS` collection) |
| Ralph's own answers (`rocket-ralph.pipe`) | `gpt-4-1` |

All eval pipes run on the **local** engine and read/write the **local** qdrant `ROCKETRIDE_DOCS`.

---

## What's gated (open decisions)

- **Escalation = success or failure?** — currently counts hand-offs as **failures** (default) until
  the team decides which escalations are "correct."
- **Replay** — needs the golden set seeded (approve Q/As, or use `replay-seeds.md`) + a first-run gate.
- **KB writeback (Phase 6a)** — happens on Q/A approval; **public FAQ (6b)** is intentionally
  document-only for now.

---

## Also in this PR (outside `eval/`)

- **`social.ts`** — the social announcer now dedups by **normalized content**, not just tweet id, so
  the same post republished under a new id isn't announced twice.
