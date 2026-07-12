#!/usr/bin/env bash
# Show whether each bot is running. Run this over SSH any time.
cd "$(dirname "$0")"
for name in showcase support scheduler social; do
  pidfile="logs/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    pid=$(cat "$pidfile")
    echo "$name: RUNNING (pid $pid)  log: logs/$name.log"
  else
    echo "$name: STOPPED"
  fi
done
