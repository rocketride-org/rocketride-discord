#!/usr/bin/env bash
# Start the Discord bots detached (survive logout via nohup).
#   showcase   -> showcase.js   (showcase moderator)
#   support    -> support.ts    (Rocket Ralph, run via tsx)
#   scheduler  -> scheduler.ts  (Post Scheduler, run via tsx; needs Redis)
#   social     -> social.ts     (Social announcer: in-process schedule, run via tsx)
# Logs go to logs/*.log, PIDs to logs/*.pid. Safe to re-run: skips a bot
# that is already running.
set -euo pipefail
cd "$(dirname "$0")"

# nvm node is not on PATH for non-login shells — point at it explicitly.
export PATH="/Users/discordbot/.nvm/versions/node/v26.3.0/bin:$PATH"
mkdir -p logs

# The RocketRide engine (started by the VSCode extension) listens on a DYNAMIC
# port (--port=0), so the port in .env goes stale on every engine restart.
# Auto-detect the engine's IPv4 listen port and point the SDK at it.
ENGINE_PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i engine | grep '127.0.0.1' | sed -E 's/.*:([0-9]+).*/\1/' | head -1)
if [ -n "$ENGINE_PORT" ]; then
  export ROCKETRIDE_URI="http://localhost:${ENGINE_PORT}"
  echo "engine detected on port $ENGINE_PORT -> ROCKETRIDE_URI=$ROCKETRIDE_URI"
else
  echo "WARNING: RocketRide engine not found listening — start it in the VSCode extension."
  echo "         (support bot will fail to connect; showcase is unaffected.)"
fi

start() {
  local name="$1"; shift
  local pidfile="logs/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"
    return
  fi
  nohup "$@" >> "logs/$name.log" 2>&1 &
  echo $! > "$pidfile"
  echo "$name started (pid $!) -> logs/$name.log"
}

# The scheduler needs Redis; ensure its container is up (guarded — never aborts the script).
if command -v docker >/dev/null 2>&1; then
  docker start sched-redis >/dev/null 2>&1 \
    || docker run -d --name sched-redis -p 6379:6379 redis:7 >/dev/null 2>&1 \
    || echo "WARNING: could not start Redis (sched-redis) — scheduler will fail until Redis is up."
else
  echo "WARNING: docker not found — ensure Redis is reachable for the scheduler."
fi

start showcase   node showcase.js
start support    ./node_modules/.bin/tsx support.ts
start scheduler  ./node_modules/.bin/tsx scheduler.ts
start social     ./node_modules/.bin/tsx social.ts
