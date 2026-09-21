#!/usr/bin/env bash
# Start Discord bots detached (survive logout via nohup). One process per bot.
#   showcase      -> showcase.js       (showcase moderator)
#   support       -> support.ts        (Rocket Ralph → LOCAL engine, webhook + multi-modal)
#   support-test  -> support-test.ts   (Rocket Ralph → CLOUD pipeline via webhook, multi-modal)
#   scheduler     -> scheduler.ts      (Post Scheduler; needs Redis)
#   social        -> social.ts         (Social announcer; in-process schedule)
#   faq           -> faq.ts            (FAQ builder → LOCAL engine; nightly, writes data/faqs.json)
#
# Usage:
#   ./start-bots.sh                    # start ALL bots
#   ./start-bots.sh support            # start just one
#   ./start-bots.sh support support-test   # start several
# Logs → logs/<bot>.log, PIDs → logs/<bot>.pid. Re-running skips already-running bots.
set -uo pipefail
cd "$(dirname "$0")"

# nvm node is not on PATH for non-login shells — point at it explicitly.
export PATH="/Users/discordbot/.nvm/versions/node/v26.3.0/bin:$PATH"
mkdir -p logs

ALL="showcase support support-test scheduler social faq"

# The launch command for a given bot (portable case, not a bash-4 assoc array).
launch_cmd() {
  case "$1" in
    showcase)     echo "node showcase.js" ;;
    support)      echo "./node_modules/.bin/tsx support.ts" ;;
    support-test) echo "./node_modules/.bin/tsx support-test.ts" ;;
    scheduler)    echo "./node_modules/.bin/tsx scheduler.ts" ;;
    social)       echo "./node_modules/.bin/tsx social.ts" ;;
    faq)          echo "./node_modules/.bin/tsx faq.ts" ;;
    *)            echo "" ;;
  esac
}

start_one() {
  local name="$1" pidfile="logs/$1.pid" cmd
  cmd="$(launch_cmd "$name")"
  if [ -z "$cmd" ]; then echo "unknown bot: $name  (valid: $ALL)"; return 1; fi
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"; return 0
  fi
  # The scheduler needs Redis; ensure its container is up (guarded — never aborts).
  if [ "$name" = scheduler ] && command -v docker >/dev/null 2>&1; then
    docker start sched-redis >/dev/null 2>&1 \
      || docker run -d --name sched-redis -p 6379:6379 redis:7 >/dev/null 2>&1 \
      || echo "WARNING: could not start Redis (sched-redis) — scheduler will fail until Redis is up."
  fi
  nohup $cmd >> "logs/$name.log" 2>&1 &
  echo $! > "$pidfile"
  echo "$name started (pid $!) -> logs/$name.log"
}

for name in ${*:-$ALL}; do start_one "$name"; done
