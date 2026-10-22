// 30 minutes — matched to the inline routes' Vercel extended max duration
// (maxDuration = 1800), so an inline run and a queued run get the same budget.
// Times off this constant: the stuck-execution reaper's rule for runs that
// never heartbeat (pending rows, and rows from before the liveness clock — see
// src/lib/agents/reap.ts) and the flow AI-step timeout ceiling — raising it
// requires a `fly deploy --config fly.worker.toml` so the worker and the
// reaper agree with the web tier. The BullMQ lock no longer does: it is
// renewed while a job lives, so it is sized for dead-worker recovery instead
// (JOB_LOCK_DURATION_MS, src/lib/queue/config.ts).
export const AGENT_RUN_MAX_DURATION_SECONDS = 30 * 60
export const AGENT_RUN_TIMEOUT_MS = AGENT_RUN_MAX_DURATION_SECONDS * 1000

// Keep a single model turn below the enclosing execution window so
// persistence/cleanup still has room to finish.
export const AGENT_MODEL_TURN_TIMEOUT_MS = 28 * 60 * 1000
