#!/usr/bin/env bash
# Show whether each bot is running. Usage:
#   ./status-bots.sh              # all bots
#   ./status-bots.sh support      # just one
cd "$(dirname "$0")"

ALL="showcase support support-test scheduler social faq eval"

for name in ${*:-$ALL}; do
  pidfile="logs/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name: RUNNING (pid $(cat "$pidfile"))  log: logs/$name.log"
  else
    echo "$name: STOPPED"
  fi
done
