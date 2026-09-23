#!/usr/bin/env bash
# Stop Discord bots started by start-bots.sh — by PID file only (no broad pkill sweep,
# which can catch sibling bots). Killing the recorded pid stops the bot cleanly.
#
# Usage:
#   ./stop-bots.sh                 # stop ALL bots
#   ./stop-bots.sh support         # stop just one
#   ./stop-bots.sh support social  # stop several
cd "$(dirname "$0")"

ALL="showcase support support-test scheduler social faq eval"

stop_one() {
  local name="$1" pidfile="logs/$1.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    local pid; pid=$(cat "$pidfile")
    kill "$pid" && echo "stopped $name (pid $pid)"
  else
    echo "$name: not running"
  fi
  rm -f "$pidfile"
}

for name in ${*:-$ALL}; do stop_one "$name"; done
