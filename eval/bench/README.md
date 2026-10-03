# Eval model bake-off

Compares LLMs on the **grader** job (`eval/grader.ts` → `pipelines/eval-grader.pipe`) — the nightly
call that labels each support thread's cause and outcome — on two axes: **what it costs** and **how
far its labels drift from the reference**.

Nothing here touches production. The eval store is opened **read-only**, the pipes are read but
never written, and no bot or cron path imports anything in this directory.

---

## TL;DR — run this first, it needs no API key

```bash
tsx eval/bench/main.ts --estimate
```

Measured against the real store on 2026-09-24 (184 gradable threads over 97 days, 4,819 input
tokens/call mean, 157 output tokens/call, ~47 grader calls/month):

| Model | $/call | $/month | $/year | vs incumbent |
|---|---|---|---|---|
| Groq GPT-OSS 20B | $0.00041 | $0.02 | $0.23 | −97% |
| Groq GPT-OSS 120B | $0.00082 | $0.04 | $0.46 | −94% |
| xAI Grok 4.1 Fast | $0.00104 | $0.05 | $0.59 | −93% |
| OpenAI GPT-5.6 Luna | $0.00115 | $0.05 | $0.65 | −92% |
| DeepSeek V4.1 Flash | $0.00163 | $0.08 | $0.92 | −89% |
| OpenAI GPT-5.4 Mini | $0.00432 | $0.20 | $2.44 | −70% |
| Claude Haiku 4.5 | $0.00560 | $0.26 | $3.16 | −61% |
| **Claude Sonnet 5** | $0.0112 | $0.53 | $6.32 | −22% |
| **OpenAI GPT-5.4** *(incumbent)* | $0.0144 | $0.68 | $8.12 | — |
| Claude Sonnet 5 (adaptive thinking) | $0.0191 | $0.90 | $10.75 | +32% |

**The entire grading workload costs about 68 cents a month.** The most aggressive possible saving is
**~$8/year**, and switching to Sonnet 5 *saves* money against what runs today. At this volume, cost
is not a real constraint — pick the model that labels most accurately and stop optimising the bill.

Cost only becomes a decision if one of these changes:

| Change | New monthly cost (Sonnet 5) |
|---|---|
| Today — 47 threads/month | $0.53 |
| 10× support volume | $5.30 |
| Grade every *message*, not every thread (~4.5×) | $2.39 |
| Re-grade the full 184-thread history on each prompt change | $2.06 per sweep |
| Weekly replay, 50 golden cases | +$0.78 |

Two levers apply before model choice ever does:
- **Batch APIs halve the price.** Grading runs at 01:00 against threads already ≥48h quiet — it is
  the definition of a non-latency-sensitive job. Anthropic, OpenAI and Groq all offer 50% off.
- **Prompt caching does nothing here.** The grader's system prompt is ~530 tokens, below or around every
  provider's minimum cacheable prefix, and each thread's body is unique. Don't plan around it.

---

## What "accuracy" means here

There is no ground truth in the store today — exactly **1** of 229 threads has a human verdict. So
the bench measures five things, in descending order of how much they should move a decision:

1. **Decision agreement** — each model's signals are fed through the *real* `decideOutcome` /
   `decideCause` from `eval/rules.ts`, and the resulting outcome/cause is compared. This is the only
   metric that maps to a number the team reports on the scorecard. Reported with **Cohen's kappa**
   alongside raw agreement, because the outcome distribution is skewed enough that a model which
   always guesses the majority class scores 90% raw and κ = 0.
2. **Schema validity** — production silently drops an unparseable grade (`parse fail … left open`),
   so invalid JSON is data loss, not a cosmetic flaw.
3. **Draft discipline** — the prompt says draft a Q/A *only* when a team member supplied the answer.
   The store knows whether a team reply exists, so this is checkable with **no human labels at all**.
   Split into `missed` (a KB entry we never get) and `invented` (fiction headed for the knowledge
   base) — the second is much worse than the first.
4. **Panel consensus** — leave-one-out majority across the other arms. An outside view that doesn't
   privilege the incumbent.
5. **Self-consistency** — `--repeats 3` runs the identical prompt three times. A model that
   contradicts itself can't be trusted to label a trend.

> **Agreement with GPT-5.4 is not correctness.** It answers "would this model reproduce what we ship
> today". A cheap model can only be shown to be *better* against human labels. Run
> `--gold-template`, correct the labels by hand, save as `logs/bench/gold.jsonl`, and every
> subsequent run scores against yours instead. Ten to forty rows is enough to be useful.

---

## Commands

All run from the repo root, with the nvm node on `PATH` (see `start-bots.sh`).

```bash
tsx eval/bench/main.ts --list                    # catalog + prices + which keys are present
tsx eval/bench/main.ts --estimate                # the cost table above — no API key needed
tsx eval/bench/main.ts --estimate --volume 500   # what it would cost at 500 threads/month
tsx eval/bench/main.ts --verify-models           # check catalog ids against each provider (free GET)

tsx eval/bench/main.ts --run --models sonnet-5,haiku-4-5,gpt-5-4 --n 30 --yes
tsx eval/bench/main.ts --run --models sonnet-5 --n 20 --repeats 3 --yes   # self-consistency

tsx eval/bench/main.ts --report                  # re-render the last run → report.md + report.html
tsx eval/bench/main.ts --gold-template --n 40    # seed human labels
```

`--run` **always prints the projected spend and refuses to call anything without `--yes`.** Results,
raw model output, `report.md` and `report.html` land in `logs/bench/<timestamp>/` (gitignored).

---

## What you need to run each arm

| Arm | Key | Status |
|---|---|---|
| `gpt-5-4` (incumbent), `gpt-5-4-mini`, `gpt-5-6-luna` | `OPENAI_API_KEY`, falling back to `ROCKETRIDE_OPENAI_KEY` | **Already works** — all three ids verified against the live account |
| `sonnet-5`, `sonnet-5-thinking`, `haiku-4-5` | `ANTHROPIC_API_KEY` | Needed |
| `groq-oss-120b`, `groq-oss-20b` | `GROQ_API_KEY` | Needed |
| `grok-4-1-fast` | `XAI_API_KEY` | Needed |
| `deepseek-v4-1-flash` | `DEEPSEEK_API_KEY` | Needed |
| anything else | `OPENROUTER_API_KEY` | One key, every model — copy the `openrouter-example` entry |

A full 30-case bake-off across **all ten arms costs about $1.80** — under three months of running
the grader. Model ids outside OpenAI came from vendor pricing pages and are **not** verified; run
`--verify-models` before the first paid run.

## Adding a model

Append an entry to [`pricing.json`](pricing.json). No code change: `api.kind` is either `anthropic`
or `openai` (which covers OpenAI, Groq, xAI, DeepSeek, OpenRouter, Together, Fireworks — they all
speak `/chat/completions`). Per-entry `options` carry the quirks: `temperature: null` for models
that reject sampling params (Sonnet 5, Opus 5, the GPT-5 reasoning tiers),
`maxTokensField: "max_completion_tokens"` for newer OpenAI models, `thinking`/`effort` for Anthropic.

---

## Design notes

- **The prompt is read from `pipelines/eval-grader.pipe` at run time**, not copied. The bench can
  never score a model on a prompt production doesn't use.
- **Cases are rebuilt by the same code path as `eval/grader.ts`** — same transcript roles, same
  1,500-char clipping, same cluster list, same escalation block.
- **Threads production excludes before the LLM are excluded here too.** They cost nothing in
  production, so counting them would flatter every model's agreement score.
- **Retrieval is held fixed.** `eval-retrieve.pipe` is local miniLM — identical for every arm and
  free — so the bench replays the stored retrieval scores. The LLM's labels are the only variable.
- **No structured-output / JSON mode.** Production asks for strict JSON in the prompt and parses
  what comes back, so the bench does the same and *measures* the difference. Turning on per-provider
  JSON mode is a follow-up lever, not a hidden assumption.
- **Sampling is deterministic and stratified** by outcome class, so `--n 30` covers rare labels
  (`dead_end`, `rejected`, `policy_*`) and always picks the same 30 threads.
- **Estimate-mode output sizes come from the incumbent's stored grades**, not a guess — except for
  thinking arms, where hidden reasoning bills as output and the catalog applies a declared
  multiplier until a real run replaces it.

## Limits

- Prices are list prices captured on the catalog's `asof` date. They go stale; re-check before
  quoting one.
- Estimated token counts use a 3.9 chars/token heuristic (±15%). A `--run` reports measured usage.
- The judge job (`eval-judge.pipe`, weekly replay) isn't benchmarked: the golden set is empty, so it
  makes zero calls today. Once it's seeded, the same pattern applies — it's a smaller, cheaper task.
- A 30-case run resolves large differences, not small ones. Treat a 3-point agreement gap on n=30 as
  noise; `--repeats 3` and a bigger `--n` are cheap enough to settle it.
