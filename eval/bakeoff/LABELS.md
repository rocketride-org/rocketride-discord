# Labelling guide — Arm A vs Arm C bake-off

Two files, read together:

| File | What it is |
|---|---|
| `labels.jsonl` | 157 rows. The **empty fields are yours**. One JSON object per line; `#` lines are ignored. |
| `labels-context.md` | The evidence for each row, in the same order. Find the `## <id>` heading, read, fill the matching line. |

```bash
tsx eval/bakeoff/make-labels.ts --validate     # run this as you go; it catches typos and tells you what's left
```

Regenerating (`--generate`) is deterministic — the same rows come back — but it **overwrites your
labels**. Don't run it once you've started.

---

## Ground rules

**Nothing is pre-filled with a model's guess.** If the file had shipped with GPT-5.4's or Sonnet's
labels, you'd anchor to them and every agreement number afterwards would be inflated for whichever
model resembles them. The one exception is `outcome` on the 12 rows marked `_outcome_forced` — there
`eval/rules.ts` derives the outcome from the thread's events alone, so it's arithmetic, not a guess.
Those rows still need a `cause` from you.

**Label what you believe, not what you think the bot should have said.** You are the ground truth.
If you can't decide, put your best guess in and say why in `notes` — a flagged uncertain row is far
more useful than a confident wrong one, and I can exclude them from the headline numbers.

---

## Grader rows (60) — `outcome` + `cause`

### `outcome` — what happened to the thread

| Value | Means |
|---|---|
| `resolved_unconfirmed` | Ralph answered; nothing contradicted it, nobody confirmed it either |
| `resolved_confirmed` | The asker confirmed it worked (said so, or ✅) |
| `rejected` | The asker said it didn't work (or ❌) |
| `overridden` | No escalation, but a team member **corrected or added to** Ralph's answer |
| `deferred` | Ralph escalated **and** a team member then answered |
| `deferred_unanswered` | Ralph escalated and nobody came |
| `dead_end` | Ralph's last word was the canned *"Sorry — I could not process that."* |
| `no_reply` | Ralph never replied at all |
| `excluded` | Not a real support question — internal chatter, a test, noise |
| `reasked` | The same person asked the same thing again later because the first answer didn't land |

A team member merely saying "thanks" or "on it" is an **ack**, not an override — that stays
`resolved_unconfirmed`.

### `cause` — why it failed. **Leave blank for `resolved_*` and `excluded`.**

| Value | Means |
|---|---|
| `content_gap` | The answer isn't in the docs/KB at all — a **documentation gap** |
| `retrieval_miss` | It *is* in the KB, but Ralph didn't find it |
| `bad_answer` | Ralph had the right material in front of it and still got it wrong |
| `policy_public` | Escalated something public info could have answered (pricing, limits, public roadmap) |
| `policy_account` | Needs account access or a human decision (refunds, billing, eligibility) |
| `policy_other` | Partnership, press, internal routing |
| `product_defect` | Root cause is a real product bug |
| `feature_request` | They want something that doesn't exist yet |
| `tool_error` | Escalated because a GitHub/HTTP tool call failed |
| `engine_error` | `dead_end` or `no_reply` — the pipeline broke |
| `unknown` | Genuinely can't tell |

> Production derives `content_gap` / `retrieval_miss` / `bad_answer` from **miniLM retrieval scores**
> you can't see, not from the LLM. Label what you believe; the report will show cause agreement for
> those three separately from the causes the LLM actually decides.

---

## Judge rows (97) — `verdict`

For each row: does **reply** satisfy **golden_answer** for **question**?

| Value | Means |
|---|---|
| `pass` | Correct, and covers the golden answer's key points |
| `partial` | Partly right, or missing something that matters |
| `fail` | Wrong, off-topic, or missing the point entirely |

Judge on **substance, not wording** — a shorter reply that gets there is a `pass`.

**40 of these replies were altered on purpose** (marked `_synthetic`, with `_perturbation` set to
`swap` = another thread's answer, `truncate` = first sentence only, `corrupt` = a number or
identifier changed). The perturbation is a **hypothesis, not a label**: a truncated reply can still
genuinely answer the question, and a corrupted number might be in a part of the reply that doesn't
matter. **Judge it as you find it.** If you label a synthetic row `pass`, that is a real and useful
data point, not a mistake.

### Why the wrong replies exist

The headline metric is **false-pass rate**: how often a judge waves through a reply you called
`fail`. A judge that does this silently hides regressions — it is strictly worse than one that is
merely noisy. A set of only-good replies cannot measure it at all.

---

## How long, and what the numbers will be worth

Roughly **3 hours**: ~2 min per grader row, ~40 s per judge row.

Precision of the headline metric depends on **how many rows you label `fail`**, not on how many rows
exist. Expect ~40–55 fails (the 40 synthetic ones, minus those you pass, plus genuinely bad real
replies). That buys:

| Comparison | `fail` rows needed per arm |
|---|---|
| 5% vs 40% false-pass | 23 |
| 5% vs 25% | 51 |
| 5% vs 20% | 77 |
| 5% vs 15% | 142 |
| 5% vs 10% | 436 |

So this set can prove **"Arm C is much worse"** or **"Arm C is not much worse"**. It cannot resolve a
5-point difference, and the report will say so rather than declare a winner. If Arm C lands close to
Arm A, that is the point at which more labels are worth your time — and I'll tell you how many.

Also worth knowing before you start: with zero observed false passes, the true rate could still be
as high as **3 ÷ n**. At n = 40 fails, "we saw none" means "it's under 7.5%", not "it's zero".

---

## Privacy

`labels.jsonl` and `labels-context.md` contain real customer questions, team answers and Discord
user ids, so both are **gitignored**. The generator and this guide are committed; the data is not.
If you want the ground truth versioned, say so and I'll add an id-stripping pass first.
