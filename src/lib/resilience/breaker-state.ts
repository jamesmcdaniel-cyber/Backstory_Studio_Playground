/**
 * Pure consecutive-failure circuit breaker. The state machine only — see
 * circuit-breaker.ts in this directory for the keyed registry that most callers
 * want.
 *
 * Written for the graph-RAG store and moved here when a second dependency
 * needed the same thing. It is deliberately still a pure state machine with no
 * clock and no registry: that is what makes it exhaustively testable, and the
 * two consumers hold their state differently — the Neo4j store keeps one
 * breaker as an instance field, while the registry keys many by dependency.
 *
 * Why it exists at all: every RAG call site is already best-effort (retrieval catches and
 * returns [], indexing logs and moves on) — but "best-effort" was still paying
 * full price per attempt. With NEO4J_URI set and the server unreachable, each
 * driver call blocked on routing discovery for tens of seconds, and an agent
 * step that consults RAG several times burned its entire timeout budget on a
 * dependency that was never going to answer (observed live: a 300s agent step
 * spent wholly on Neo4j discovery retries).
 *
 * Shape: after `threshold` CONSECUTIVE failures the breaker opens for
 * `cooldownMs`; while open, calls are refused instantly (callers' existing
 * catch paths handle it exactly like a slow failure, just without the stall).
 * After the cooldown one probe call is allowed through (half-open): success
 * closes the breaker, failure re-opens it for another cooldown.
 *
 * Pure state machine — the caller supplies timestamps — so it is trivially
 * testable and never touches a clock in module scope.
 */

export type BreakerState = {
  consecutiveFailures: number
  /** ms epoch until which calls are refused; 0 = closed. */
  openUntilMs: number
  /** True while the single half-open probe is in flight. */
  probing: boolean
}

export const initialBreakerState = (): BreakerState => ({ consecutiveFailures: 0, openUntilMs: 0, probing: false })

export type BreakerOptions = {
  /** Consecutive failures that open the breaker. */
  threshold: number
  /** How long the breaker stays open before allowing a probe. */
  cooldownMs: number
}

/** Decide whether a call may proceed right now. Mutates nothing. */
export function breakerAllows(state: BreakerState, nowMs: number): { allowed: boolean; probe: boolean } {
  if (state.openUntilMs === 0) return { allowed: true, probe: false }
  if (nowMs < state.openUntilMs) return { allowed: false, probe: false }
  // Cooldown elapsed: allow exactly one probe at a time.
  if (state.probing) return { allowed: false, probe: false }
  return { allowed: true, probe: true }
}

/** Record a success: the dependency answered, close the breaker fully. */
export function breakerOnSuccess(_state: BreakerState): BreakerState {
  return { consecutiveFailures: 0, openUntilMs: 0, probing: false }
}

/** Record a failure at `nowMs`; opens (or re-opens) once the threshold is hit. */
export function breakerOnFailure(state: BreakerState, nowMs: number, options: BreakerOptions): BreakerState {
  const consecutiveFailures = state.consecutiveFailures + 1
  const shouldOpen = consecutiveFailures >= options.threshold || state.openUntilMs > 0
  return {
    consecutiveFailures,
    openUntilMs: shouldOpen ? nowMs + options.cooldownMs : 0,
    probing: false,
  }
}

/** Mark the half-open probe as taken so concurrent calls keep failing fast. */
export function breakerOnProbeStart(state: BreakerState): BreakerState {
  return { ...state, probing: true }
}
