#!/usr/bin/env bash
# Stop both bots started by start-bots.sh.
cd "$(dirname "$0")"

# pattern[name] = command pattern to sweep for stray children (tsx runs bot.ts
# in a child process that can outlive the pid we recorded).
declare -A pattern=( [showcase]="node index.js" [support]="bot.ts" [scheduler]="scheduler.ts" )

for name in showcase support scheduler; do
  pidfile="logs/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    pid=$(cat "$pidfile")
    kill "$pid" && echo "stopped $name (pid $pid)"
  else
    echo "$name: no live pidfile"
  fi
  rm -f "$pidfile"
  # sweep any stray/child processes matching this bot
  if pkill -f "${pattern[$name]}" 2>/dev/null; then
    echo "  swept stray $name process(es) matching '${pattern[$name]}'"
  fi
done
