import { after } from 'next/server'

/**
 * Keeping detached background work alive past the HTTP response.
 *
 * A flow run is dispatched as a floating promise so the request can return the
 * run id immediately. On a serverless host that is fatal on its own: the
 * invocation is frozen the moment the response is sent, so the promise never
 * progresses — the run row exists, no step ever executes, nothing is logged,
 * and the flow appears to do nothing at all.
 *
 * `after()` hands the work to the framework, which holds the invocation open
 * until it settles (bounded by the route's `maxDuration`). Outside a request —
 * the BullMQ worker, a cron tick, a script — there is no scope to register with
 * and `after()` throws; there the caller already outlives the work, so the
 * throw is swallowed deliberately rather than crashing the run.
 *
 * `register` is injectable so the two branches are testable without a live
 * request scope.
 */
export function keepDetachedWorkAlive(
  work: Promise<unknown>,
  register: (work: Promise<unknown>) => void = after,
): void {
  try {
    register(work)
  } catch {
    /* no request scope — the caller's own lifetime already covers the work */
  }
}
