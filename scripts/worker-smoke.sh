#!/usr/bin/env bash
#
# Boot the Fly worker runtime against a real Redis + Postgres, prove it comes
# up clean, then stop it gracefully.
#
# The worker plane is the one process CI never used to execute: `npm test`
# imports its modules but nothing ever started it, so a boot-time regression
# (an unbootable env audit, a queue that fails to register, a broken import in
# the worker-only dependency graph) shipped to Fly unchallenged and surfaced as
# a crash-looping machine. This step is the cheap version of that check.
#
# Asserts, in order:
#   1. the process survives boot (an early exit fails the job, with its log),
#   2. /health returns 200 with redis: true and every queue running,
#   3. every queue the build registers is named in the health body,
#   4. the worker keeps running for the observation window (no crash-loop),
#   5. SIGTERM produces a clean, zero-status shutdown.
#
# Env: REDIS_URL, DATABASE_URL (+ whatever assert-env.ts treats as fatal).
#   WORKER_PORT      default 3102
#   SMOKE_BOOT_TIMEOUT  seconds to wait for /health   (default 45)
#   SMOKE_OBSERVE       seconds to stay up afterwards (default 20)

set -uo pipefail

PORT="${WORKER_PORT:-3102}"
BOOT_TIMEOUT="${SMOKE_BOOT_TIMEOUT:-45}"
OBSERVE="${SMOKE_OBSERVE:-20}"
LOG="$(mktemp -t worker-smoke.XXXXXX)"

echo "worker smoke: port=$PORT boot_timeout=${BOOT_TIMEOUT}s observe=${OBSERVE}s"

WORKER_PORT="$PORT" npx tsx src/lib/workers/runtime.ts >"$LOG" 2>&1 &
WORKER_PID=$!

fail() {
  echo "worker smoke FAILED: $1"
  echo "----- worker log -----"
  cat "$LOG"
  echo "----------------------"
  kill -TERM "$WORKER_PID" 2>/dev/null
  wait "$WORKER_PID" 2>/dev/null
  exit 1
}

HEALTH=""
for _ in $(seq 1 "$BOOT_TIMEOUT"); do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    fail "the worker exited during boot"
  fi
  HEALTH="$(curl -sf "http://127.0.0.1:${PORT}/health" || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done

[ -n "$HEALTH" ] || fail "/health never answered within ${BOOT_TIMEOUT}s"
echo "worker smoke: health = $HEALTH"

case "$HEALTH" in
  *'"status":"healthy"'*) ;;
  *) fail "the worker reported unhealthy" ;;
esac
case "$HEALTH" in
  *'"redis":true'*) ;;
  *) fail "the worker could not reach Redis" ;;
esac
# A queue reported false means that consumer never started — the exact state
# that strands jobs in `waiting` with the app looking healthy.
case "$HEALTH" in
  *':false'*) fail "at least one queue is registered but not running" ;;
esac
for queue in agent-execution scheduled-agent-execution flow-execution; do
  case "$HEALTH" in
    *"\"$queue\""*) ;;
    *) fail "the worker did not register the $queue queue" ;;
  esac
done

# Stay up: a worker that boots and then dies seconds later (bad Redis auth,
# unhandled rejection in a timer) would otherwise pass the check above.
echo "worker smoke: observing for ${OBSERVE}s"
sleep "$OBSERVE"
kill -0 "$WORKER_PID" 2>/dev/null || fail "the worker died during the ${OBSERVE}s observation window"

# The heartbeat is what the producer's dispatch gate reads before enqueueing;
# a worker that consumes but never writes it blocks every scheduled run.
grep -qi "Heartbeat write failed" "$LOG" && fail "the worker failed to write its liveness heartbeat"

kill -TERM "$WORKER_PID"
wait "$WORKER_PID"
STATUS=$?
[ "$STATUS" -eq 0 ] || fail "SIGTERM shutdown exited with status $STATUS"

echo "----- worker log -----"
cat "$LOG"
echo "----------------------"
echo "worker smoke: OK"
