# Phase 2 — backfill + baseline report

Built the eval **data layer** (Phase 1's pure/store parts) and Phase 2 (backfill + baseline report),
**without** the prod-touching live capture (`capture.ts` + `support.ts` edits) — that needs Joshua + a deploy.
`decideOutcome`/`decideCause` are deferred to Phase 3 (they hinge on the open escalation-success decision;
the baseline uses the raw "upper bound" instead).

## What was built
- `eval/config.ts` — sole `process.env` reader.
- `eval/rules.ts` — pure: `classifyRalphReply`, `isTeamMember`, `wilson`. Fully unit-tested.
- `eval/store.ts` — `node:sqlite` repository (all tables; WAL; idempotent event insert via the unique `message_id` index).
- `eval/backfill.ts` — rebuilds the event log from Discord history using the same `classifyRalphReply` as live capture.
- `eval/main.ts` — CLI: `--backfill [--since YYYY-MM-DD] [--dry]`, `--report [--window 28|all]`.
- `tests/eval/rules.test.ts`, `tests/eval/store.test.ts` — **12/12 pass** (`npm test` → `tsx --test`).

## How to reproduce
```
npm test
tsx eval/main.ts --backfill --dry     # read-only, counts only
tsx eval/main.ts --backfill           # writes logs/ralph-eval.sqlite (gitignored)
tsx eval/main.ts --report --window all
tsx eval/main.ts --report --window 28
```
Backfill: 243 threads scanned, **229 opened by Ralph**, 1394 events. Read-only on Discord; touches no engine/pipe.

## Baseline (2026-09-22)

**All-time (Ralph era, 12.5 wks, 18.3 threads/wk)**
| metric | value |
|---|---|
| threads | 229 (45 excluded as internal/team-opened) |
| decidable | 184 |
| escalation rate | 53/184 = **28.8%** |
| dead-end / no-reply | 0% / 0% |
| team-involvement | 99/184 = **53.8%** |
| **upper-bound success** | 82/184 = **44.6%**  (95% Wilson [37.6%, 51.8%]) |

**Last 28 days**
| metric | value |
|---|---|
| decidable | 51 |
| escalation rate | 20/51 = **39.2%** |
| team-involvement | 37/51 = **72.5%** |
| **upper-bound success** | 14/51 = **27.5%**  (95% Wilson [17.1%, 40.9%]) |

## Reading it
- **This confirms the "completely reversed" state** from the Ralph-performance notes: recent upper-bound success is **~27.5%** (best case), escalations are up to **39%**, and a human touches **72.5%** of recent threads.
- "Upper bound" treats *any* escalation or team reply as non-success, so it's the ceiling — true resolution will be **lower** once Phase 3 grading runs, but the pending **escalation-success** refinement (some escalations are correct) will relax it. Net: the real number sits below this ceiling, comfortably in the ~30% range the team observed.
- **Gap vs target:** notes want 60–70%; baseline ceiling is 27.5% (28d). Big lift needed — consistent with the llms.txt doc gaps found in Phase 0.

## Notes / follow-ups
- `SUPPORT_MENTION_CHANNEL_ID` was unset, so only #support was backfilled. Set it to include the mention channel.
- 0 dead-ends / 0 no-replies in history: every Ralph thread had a reply, and the exact canned fallback never appeared — the live capture (Phase 1) will catch those going forward.
- `logs/ralph-eval.sqlite` is gitignored (under `logs/`). Re-running backfill is idempotent.

## Next
- **Phase 1 live capture** — `capture.ts` + minimal `support.ts` edits (+ `GuildMessageReactions` intent). Needs Joshua review + deploy.
- **Phase 3 grader** — needs the escalation-success decision to finalize `decideOutcome`/`decideCause`.
