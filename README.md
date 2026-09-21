# rocketride-discord

Discord bots for the RocketRide community server. Each bot is a **single, standalone
file** run as its own process — there's no shared framework or import graph between
them, which keeps each one easy to reason about and deploy independently.

| Bot | File | What it does |
| --- | --- | --- |
| **Showcase** | `showcase.js` | `/submit` flow that turns project submissions into formatted cards + feedback threads. |
| **Support** (Rocket Ralph) | `support.ts` | Answers support questions in threads, powered by a RocketRide pipeline; escalates to the team. |
| **Scheduler** | `scheduler.ts` | Schedule Discord posts for later; durable via Redis. |
| **Social announcer** | `social.ts` | Posts RocketRide's latest YouTube / X / newsletter items to a channel on a schedule. |

Helper scripts `deploy.js` / `migrate.js` are one-shot showcase utilities (see
`.claude/CLAUDE.md`).

## Setup

```bash
cp .env.example .env      # then fill in the values
npm install
```

- Runtime: Node (via nvm) + `tsx` for the TypeScript bots. `.env` is loaded with `dotenv`.
- `.env` is gitignored — secrets never get committed. `.env.example` documents every var.

## Running

The bots are managed as a fleet by the shell scripts (they run detached via `nohup`,
log to `logs/*.log`, and track pids in `logs/*.pid`):

```bash
./start-bots.sh     # start any that aren't already running
./status-bots.sh    # show RUNNING / STOPPED per bot
./stop-bots.sh      # stop them all
```

`start-bots.sh` is idempotent (it skips a bot that's already up), auto-detects the
RocketRide engine's dynamic port for the support bot, and ensures the scheduler's
Redis container is up. To pick up new code, `./stop-bots.sh` first.

To run a single bot directly (node isn't on `PATH` in a bare shell — point at nvm):

```bash
export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"
node showcase.js
./node_modules/.bin/tsx support.ts
./node_modules/.bin/tsx scheduler.ts
./node_modules/.bin/tsx social.ts
```

## Social announcer (`social.ts`)

Fetches the latest posts from each configured source, and announces only **new** ones
to `SOCIAL_DISCORD_CHANNEL_ID` as embeds (posting via REST using the scheduler bot's
token — it has no gateway login of its own).

- **YouTube** — Data API v3 (`YOUTUBE_API_KEY` + `YOUTUBE_CHANNEL_ID`).
- **X / Twitter** — official API v2 (`X_BEARER_TOKEN` + `X_USER_ID`); replies (comments)
  and retweets (reposts) are excluded — only real posts.
- **Newsletter** — Ghost Content API (`GHOST_API_URL` + `GHOST_CONTENT_API_KEY`).

**Only the latest, never old:** a per-platform *watermark* (`logs/social-seen.json`)
records the newest item seen the first time each platform is checked, then only posts
items newer than that — so history is never backfilled.

**Schedule:** in-process, via Luxon in an explicit timezone (DST-correct regardless of
the host clock). Default `9, 10, 11 AM and 4, 5, 6 PM America/Los_Angeles`
(`SOCIAL_CRON_HOURS` / `SOCIAL_TZ` to override).

**Manual run / preview:**

```bash
./node_modules/.bin/tsx social.ts --social-once           # one pass now, then exit
./node_modules/.bin/tsx social.ts --social-once --dry     # show what it would post, send nothing
./node_modules/.bin/tsx social.ts --social-once --backfill # post current items (skip first-run seeding)
```

**Add a platform** (LinkedIn, Instagram, TikTok, Medium, …): write a `fetch…` function
returning `FeedItem[]` and add an entry to the `SOCIAL_SOURCES` array in `social.ts`.

## Conventions

- **One bot = one file** at the repo root. Add a new bot by dropping a new file and
  adding a line to the three `*-bots.sh` scripts. No folders needed until a single bot
  genuinely outgrows one file.
- Config lives in `.env` (mirror new vars into `.env.example`).
