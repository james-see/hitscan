#!/usr/bin/env bash
# Integration watchdog. Emits a sentinel line ONLY when the combined tree is
# unhealthy, so a quiet log means every concurrent agent is still in a good
# state. Low-noise by design: healthy ticks print nothing.
#
# Nine agents write files continuously, so any single check has a good chance
# of landing mid-save and seeing a half-written module. Those states clear on
# their own within seconds. Alerting on them trains the reader to ignore the
# watchdog, so a failure must be confirmed by a second check before it is
# reported, and the report carries the confirmed (newer) output.
cd "$(dirname "$0")/../.."
export PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"
INTERVAL="${1:-90}"
# A broken boot blocks every agent at once, so it is confirmed quickly. A
# type-only error with a working boot is ordinary mid-flight churn — an agent
# declaring an interface member a minute before implementing it looks
# identical to a real fault, so it has to persist far longer to be reported.
BROKEN_CONFIRM="${2:-20}"
DEGRADED_CONFIRM="${3:-180}"

check() { node tools/critic/health.mjs --quiet 2>&1; }
healthy() { printf '%s' "$1" | grep -q 'HEALTH HEALTHY'; }
broken() { printf '%s' "$1" | grep -q 'HEALTH BROKEN'; }

# Only report a transition into a bad state; stays quiet while a known
# failure persists, and notes the recovery once it clears.
REPORTED=0

while true; do
  sleep "$INTERVAL"
  OUT="$(check)"

  if healthy "$OUT"; then
    if [ "$REPORTED" -eq 1 ]; then
      printf 'AGENT_LOOP_TICK_health RECOVERED — %s\n' "$OUT"
      REPORTED=0
    fi
    continue
  fi

  if broken "$OUT"; then
    sleep "$BROKEN_CONFIRM"
  else
    sleep "$DEGRADED_CONFIRM"
  fi
  CONFIRM="$(check)"
  if healthy "$CONFIRM"; then
    continue # transient mid-save; already resolved
  fi

  if [ "$REPORTED" -eq 0 ]; then
    printf 'AGENT_LOOP_TICK_health %s\n' "$(printf '%s' "$CONFIRM" | tr '\n' ' | ')"
    REPORTED=1
  fi
done
