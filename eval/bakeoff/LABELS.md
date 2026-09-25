# Labelling guide — Arm A vs Arm C bake-off

Ground truth for the bake-off. **Review a proposed answer per row and approve or override it** —
you should not have to fill anything in from scratch.

```bash
export PATH="/Users/discordbot/.nvm/versions/node/v26.3.0/bin:$PATH"
tsx eval/bakeoff/make-review.ts      # (re)build the page
open eval/bakeoff/review.html        # ← do the work here
```

The page holds all 142 rows. Each one shows the evidence, the **current answer**, my **proposed
answer**, and a one-line reason. Accept it, change it, or add a note. Progress is saved in your
browser as you go, so you can close the tab. When the counter says complete, hit **Export
labels.jsonl** and drop the file at `eval/bakeoff/labels.jsonl`, replacing the skeleton.

```bash
tsx eval/bakeoff/make-labels.ts --validate   # check the exported file
```

Keyboard: `a` accept · `1`/`2`/`3` pass/partial/fail · `s` skip · `j`/`k` move. There's an
**Accept all remaining** button if you get to a point where you trust the rest.

---

## What you're reviewing

| | Rows | What the proposal is |
|---|---|---|
| **Grader** | 60 | An outcome + cause per thread. **33 of the 60 disagree with what production stored** — those are the ones worth your attention. |
| **Judge** | 82 | pass / partial / fail / skip. 42 real replies + **40 deliberately wrong ones**. |

Filter by **Low confidence** and **I changed** to spend your time where it matters. Rows tagged
`outcome fixed by rules.ts` (12 of them) have an outcome that is arithmetic, not a judgement — the
dropdown is locked and only the cause is yours.

### Where the proposals come from, and the catch

They're mine (Opus), which is deliberately **neither arm** — not Sonnet 5 (Arm A) and not Jev
(Arm C), so neither side gets a home-field advantage. The **current answer** column is what
production's GPT-5.4 grader actually stored.

The honest catch: a proposal anchors you, so this gold set is no longer fully independent. The
report will split every agreement number across rows you **approved** and rows you **changed**, so
you can see whether the anchor moved the result. If the two subsets disagree sharply, I'll say the
gold set is compromised rather than quietly report the average.

---

## Grader rows — `outcome` then `cause`

### `outcome`

| Value | Means |
|---|---|
| `resolved_unconfirmed` | Ralph answered; nothing contradicted it, nobody confirmed it |
| `resolved_confirmed` | The asker confirmed it worked (said so, or ✅) |
| `rejected` | The asker said it didn't work (or ❌) |
| `overridden` | No escalation, but a team member **corrected or added to** Ralph's answer |
| `deferred` | Ralph escalated **and** a team member then answered |
| `deferred_unanswered` | Ralph escalated and nobody came |
| `dead_end` | Ralph's last word was the canned *"Sorry — I could not process that."* |
| `no_reply` | Ralph never replied |
| `excluded` | Not a real support question — greetings, intros, spam, PR announcements |
| `reasked` | The same person asked again later because the first answer didn't land |

A team member saying "thanks" or "on it" is an **ack**, not an override — that stays
`resolved_unconfirmed`. A team member posting a bare cross-link ("replied here →") is a pointer,
also an ack.

**Two grouped judgement calls** show up repeatedly, and my proposals assume an answer. Decide once
and apply it with the group:

- **8 bare greetings** (`hi`, `hii`, `Hello everyone`, `Yes`) — proposed `excluded`.
- **6 PR announcements** ("PR #2062 needs approval") — proposed `excluded`, since there is no
  support question for Ralph to resolve. If you'd rather count them, they'd be
  `resolved_unconfirmed`, and Ralph's success rate rises.

### `cause` — **leave blank for `resolved_*` and `excluded`**

| Value | Means |
|---|---|
| `content_gap` | The answer isn't in the docs/KB at all — a **documentation gap** |
| `retrieval_miss` | It *is* in the KB, but Ralph didn't find it |
| `bad_answer` | Ralph had the right material and still got it wrong |
| `policy_public` | Escalated something public info could answer (pricing, limits, status, roadmap) |
| `policy_account` | Needs account access or a human decision (refunds, billing, promo codes) |
| `policy_other` | Partnership, press, event logistics |
| `product_defect` | Root cause is a real product bug |
| `feature_request` | They want something that doesn't exist yet |
| `tool_error` | Escalation triggered by a GitHub/HTTP tool failure — **computed, not chosen** |
| `engine_error` | `dead_end` or `no_reply` — **computed, not chosen** |
| `unknown` | Genuinely can't tell |

> `content_gap` / `retrieval_miss` / `bad_answer` are decided in production from **miniLM retrieval
> scores** you can't see. Label what you believe; the report will show agreement on those three
> separately from the causes the LLM actually picks.

---

## Judge rows — `verdict`

Does **reply** satisfy **golden_answer** for **question**? Judge on substance, not wording.

| Value | Means |
|---|---|
| `pass` | Correct, covers the golden's key points |
| `partial` | Partly right, or missing something that matters |
| `fail` | Wrong, off-topic, or missing the point |
| `skip` | **The case is broken** — see below. Not "I'm unsure". |

The golden answers come from `qa_pairs` — standalone Q/As the grader drafted from the team's
messages. That is what production's judge is actually fed (`replay.ts` → `golden_cases.golden_answer`),
so it's the faithful thing to measure. Raw team messages were the first attempt and turned out to be
mostly routing chatter ("can you check this?"), which cannot serve as a golden.

### The 17 broken cases

On 17 rows the drafted golden answers a *different* question than the thread opener — the grader
built the Q/A from a later turn. Example: the question is "websocket issues it looks like" and the
golden is about a Google OAuth redirect URL. Those are proposed `skip` and drop out of every metric.

**This is itself a finding.** Roughly a fifth of the drafted Q/As don't match their thread, which
means the golden set that Phase 5 replay would be seeded from needs a review gate before it's
trusted. Worth fixing regardless of which arm wins.

### The 40 wrong replies

`swap` (another thread's answer), `truncate` (first sentence only), `corrupt` (a number or
identifier changed — the review page **highlights the change** so you don't have to hunt for it).

The perturbation is a **hypothesis, not a label**. Two truncations in this set still answer the
question and are proposed `pass`; one corruption renames a package to `kds-resal`, which reads
perfectly and is completely wrong. Label what you find.

---

## What this buys — the honest version

My proposals come out at **47 fail, 10 pass, 8 partial, 17 skip**. The headline metric's precision
depends on the number of `fail` rows, so assume roughly 45–50 after your review:

| Comparison | `fail` rows needed |
|---|---|
| 5% vs 40% false-pass | 23 ✅ |
| 5% vs 25% | 51 — marginal |
| 5% vs 20% | 77 ✗ |
| 5% vs 15% | 142 ✗ |
| 5% vs 10% | 436 ✗ |

So this set can show **"Arm C is clearly worse"** or **"Arm C is not clearly worse"**. It cannot
resolve a 5-point gap, and the report will say that instead of picking a winner. With zero observed
false passes the true rate could still be as high as `3 ÷ n` — at 47 fails, "we saw none" means
"under 6.4%", not "zero".

Time: about **an hour**, most of it on the 33 grader rows where my proposal and production disagree.

---

## Privacy

`labels.jsonl`, `labels-context.md` and `review.html` are **gitignored** — they carry real customer
questions, team answers and Discord user ids. The generators and `proposals-*.json` are committed
(checked: no user ids, emails or channel links). If you want the ground truth versioned, say so and
I'll add an id-stripping pass first.
