# Sonnet vs Jev+Sonnet — final results

Measured 2026-09-26 on real threads from the eval store. Total spend: **$4.72**.

## Recommendation

| Task | Use | Why |
|---|---|---|
| **Judge** | **Jev + Sonnet, threshold 0.50** | Same accuracy, same false-pass rate, 15× faster, 94% cheaper |
| **Grader** | **Stay on Sonnet for now** | The cascade is not clearly better, and the cheap settings cost real accuracy |

## What it costs per month, at your volume

Measured volume: **44 support threads/month** reach the grader. The judge runs off the golden set,
which is currently **empty** — replay has never run.

| Scenario | Sonnet only | Recommended | Saving |
|---|---|---|---|
| **Today** (replay off) | **$0.66** | **$0.66** | **$0.00** |
| Replay on, 50 golden cases weekly | $1.33 | $0.71 | $0.63/mo |
| Replay on, 100 golden cases weekly | $2.01 | $0.75 | $1.26/mo |

Today the recommendation changes your bill by nothing. The judge is the only task it touches, and
the judge does not currently run; the grader stays on Sonnet either way.

**The saving does not scale with support volume.** It comes entirely from the judge, which is driven
by how many golden cases you replay, not by how many threads you get:

| Support volume | Sonnet only | Recommended | Saving |
|---|---|---|---|
| 1x — 44 threads/mo | $1.33 | $0.71 | $0.63/mo |
| 5x — 220 threads/mo | $3.98 | $3.35 | $0.63/mo |
| 10x — 440 threads/mo | $7.28 | $6.65 | $0.63/mo |

If support traffic grows, the grader becomes the whole bill and this recommendation does nothing
about it. Savings that scale with volume would need the grader on the cascade too — which the
accuracy numbers above do not currently support.

## Judge — 65 cases, 47 labelled fail

| Option | Accuracy | False passes | $/month | Latency | Escalates |
|---|---|---|---|---|---|
| Sonnet only | 88% | 1 / 47 | $0.67 | 1846ms | — |
| **Jev + Sonnet @ 0.50** | **91%** | **1 / 47** | **$0.04** | **120ms** | 5% |
| Jev + Sonnet @ 0.70 | 89% | 1 / 47 | $0.29 | 139ms | 34% |
| Jev + Sonnet @ 0.90 | 88% | 1 / 47 | $0.45 | 1776ms | 57% |

False passes are identical at every setting, so raising the threshold buys nothing but latency and
cost. Take the lowest one.

**This only works because Jev is asked a three-level question.** With a yes/no question it had no
way to say "partially right", rounded borderline replies up to "pass", and disagreed with Sonnet on
7 cases — leniently, every time. Switching to a fail/partial/pass score cut that to 2 disagreements
and moved false passes from 2/47 to 1/47. If anyone reimplements this, that detail is the whole
result.

## Grader — 60 cases, 39 winnable

| Option | Outcome | Cause | $/month | Latency | Escalates |
|---|---|---|---|---|---|
| Sonnet only | 90% | 68% | $0.71 | 2541ms | — |
| Jev + Sonnet @ 0.50 | 82% | 75% | $0.09 | 129ms | 12% |
| Jev + Sonnet @ 0.80 | 90% | 80% | $0.51 | 2539ms | 67% |

The grader is a genuinely different shape from the judge. It asks Jev **four** questions per case,
and one Sonnet call answers all four — so a single uncertain field sends the whole case to Sonnet.
At the threshold where accuracy matches Sonnet (0.80), two thirds of cases escalate, which erases
the speed advantage entirely (2539ms vs 2541ms) and leaves only a 28% cost saving on a $0.71 bill.

At 0.50 you get the speed and the savings but give up 8 points of outcome accuracy — 3 cases out of
39, which is inside the noise, but it is the wrong direction and there is no second signal
supporting it.

One real finding: **the cascade is consistently better at `cause` than Sonnet alone** (75–80% vs
68%) across every threshold. Worth a second look if cause labelling matters to you, but n=39.

## What it cost to find out

| | |
|---|---|
| Jev calibration (249 cases, no Sonnet) | $0.04 |
| Judge bake-off (65 × 3 repeats) | $1.07 |
| Judge three-level re-run (Jev only) | $0.01 |
| Grader bake-off (60 × 3 repeats) | $2.73 |
| Pilots, smoke tests, diagnostics | $0.09 |
| **Total** | **$4.72** |

For context, the decision is worth about **$0.60/month**. The experiment costs roughly eight months
of the savings, which is why the case for switching rests on latency, not price.

## Three things these numbers cannot tell you

**Accuracy is measured against one model's labels, not a human's.** The reference is Claude Opus,
chosen because it is in neither arm. Where Opus is wrong, both arms are scored wrong together. The
judge had only 2 disagreements left between the arms — settling those by hand is about five minutes
and would materially firm this up.

**The samples are small.** 65 judge cases, 39 winnable grader cases. Treat any gap under about 8
points as noise. "Jev is better" is not a supported claim anywhere here; "Jev is not worse" is.

**Reliability was a tie, on thin evidence.** Zero failures and zero unparseable responses from
either model across 390 calls. One malformed JSON response from Sonnet did appear in an early pilot
— roughly 1 in 200 — which Jev structurally cannot produce, since it returns typed answers rather
than JSON it has to format. Too rare to call from this data.

## The thing worth more than the model choice

**21 of 60 threads in the grader sample are not real support questions** — bare greetings, PR
announcements, spam, a student introduction, a freelancer advertising. They are all currently
counted as `resolved_unconfirmed`, which scores as a **win**.

The grader schema has no way to say so. `decideOutcome` emits `excluded` only from its pre-checks
(team opener, test bot, manipulation flag) — never from anything an LLM observes. So no model,
Sonnet included, can mark a greeting as noise. That is a schema gap, not a model gap.

At roughly a third of threads, this inflates the reported success rate more than any model choice
in this document affects anything. Adding a `not_a_real_question` signal to the grader prompt and a
branch in `decideOutcome` would fix it.

Two related gaps found on the way:

- **94 drafted Q/A answers are sitting unapproved**, and 0 have ever reached Ralph's knowledge base.
  `content_gap` is the single biggest failure cause, and 94 drafted fixes for it are unused.
- **The ✅/❌ reaction feedback is switched on but has never recorded anything.** 85 of 229 threads
  are scored as wins with no evidence either way; this is the mechanism meant to fix that.
