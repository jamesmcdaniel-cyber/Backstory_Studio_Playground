/**
 * Circuit breakers for outbound dependencies, so overload degrades instead of
 * timing out.
 *
 * ── The failure this prevents ─────────────────────────────────────────────
 * Every outbound dependency this platform has — Nango's proxy, Neo4j, the model
 * providers — fails the same way under stress: not by refusing quickly, but by
 * getting slow. Requests pile up against a timeout measured in tens of seconds,
 * and because each waiting request holds a worker slot and a database
 * connection, a dependency slowing down converts directly into the platform
 * running out of the resources it needs to serve everything else. One sick
 * integration takes down runs that never touch it.
 *
 * The breaker turns that into a fast, explicit refusal. After
 * `failureThreshold` consecutive failures the circuit opens and every call for
 * `openMs` is rejected immediately with a typed error the caller can render as
 * "this integration is temporarily unavailable". No slot held, no connection
 * held, no 30-second wait to learn what the last ten calls already established.
 *
 * ── Relationship to breaker-state.ts ─────────────────────────────────────
 * This file is a KEYED REGISTRY over the pure state machine in
 * breaker-state.ts, not a second implementation of one. The Neo4j store already
 * used that state machine directly, holding a single breaker as an instance
 * field; a registry is the shape everything else needs, where the number of
 * dependencies is not known ahead of time. Same semantics, one implementation.
 *
 * ── Consecutive failures, not a rate ──────────────────────────────────────
 * A failure RATE needs a window, a minimum sample, and a decision about what to
 * do below that sample — three knobs that are wrong at low traffic, which is
 * exactly when a per-organization breaker operates. Consecutive failures need
 * none of that and answer the only question worth asking here: is this thing
 * currently answering at all. One success resets the count, so intermittent
 * errors never accumulate into an open circuit.
 *
 * ── Half-open ─────────────────────────────────────────────────────────────
 * When `openMs` elapses the next call is allowed through as a probe. If it
 * succeeds the breaker closes; if it fails the circuit re-opens for another
 * window. Exactly one probe is admitted at a time, so a recovering dependency
 * is not immediately hit with the full backlog that just built up against it —
 * which is how a service that is coming back gets knocked over again.
 *
 * ── Scope: per-process, and why that is the right call here ───────────────
 * State is per-process. On the worker — where essentially all outbound volume
 * lives, in long-lived machines running many jobs — that is exactly right: the
 * process learns from its own last few calls and acts immediately, with no
 * coordination and no per-call cache round trip.
 *
 * On Vercel it is genuinely weaker: a short-lived lambda may not live long
 * enough to observe `failureThreshold` failures, so breakers there trip late or
 * not at all. That is a real limitation and not worth hiding. It is also not
 * worth fixing with shared state on this path — a Redis read on every outbound
 * call would add cost and a failure mode to the very path whose job is to fail
 * fast. The request-side protection on Vercel is the rate limiter; this is the
 * dependency-side protection where the dependencies are actually called.
 */
import { apiLogger } from '@/lib/logger'
import {
  breakerAllows,
  breakerOnFailure,
  breakerOnProbeStart,
  breakerOnSuccess,
  initialBreakerState,
  type BreakerState as PureBreakerState,
} from '@/lib/resilience/breaker-state'

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number
  /** How long the circuit stays open before admitting a probe. */
  openMs?: number
  /**
   * Decides whether an error counts against the breaker.
   *
   * Default: everything counts. Override where the dependency distinguishes
   * "you asked for something that does not exist" from "I am unwell" — a 404
   * from a provider is a fact about the request, and letting it trip a breaker
   * would take an integration down over one bad workflow configuration.
   */
  isFailure?: (error: unknown) => boolean
}

/** Thrown instead of calling through while a circuit is open. */
export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN'
  constructor(readonly dependency: string, readonly retryAfterMs: number) {
    super(`${dependency} is temporarily unavailable — retry in ${Math.ceil(retryAfterMs / 1000)}s.`)
    this.name = 'CircuitOpenError'
  }
}

const DEFAULTS = { failureThreshold: 5, openMs: 30_000 }

/** One pure state machine per dependency key. */
const circuits = new Map<string, PureBreakerState>()

function circuitFor(key: string): PureBreakerState {
  let circuit = circuits.get(key)
  if (!circuit) {
    circuit = initialBreakerState()
    circuits.set(key, circuit)
  }
  return circuit
}

/** Current state of a named circuit, for health endpoints and tests. */
export function breakerState(key: string, now = Date.now()): BreakerState {
  const circuit = circuits.get(key)
  if (!circuit || circuit.openUntilMs === 0) return 'closed'
  return now >= circuit.openUntilMs ? 'half-open' : 'open'
}

/**
 * Run `operation` under a breaker named `key`.
 *
 * The key is the unit of isolation, and choosing it is the real decision. Key
 * per (dependency, tenant) where a workspace's own credentials can be the sick
 * thing — one expired Nango connection must not open the circuit for everyone
 * else's. Key per dependency where the dependency is shared and its health is
 * global.
 */
export async function withBreaker<T>(
  key: string,
  operation: () => Promise<T>,
  options: BreakerOptions = {},
): Promise<T> {
  const threshold = options.failureThreshold ?? DEFAULTS.failureThreshold
  const cooldownMs = options.openMs ?? DEFAULTS.openMs
  const now = Date.now()

  const gate = breakerAllows(circuitFor(key), now)
  if (!gate.allowed) {
    throw new CircuitOpenError(key, Math.max(1, circuitFor(key).openUntilMs - now))
  }
  if (gate.probe) circuits.set(key, breakerOnProbeStart(circuitFor(key)))

  try {
    const result = await operation()
    if (circuitFor(key).openUntilMs !== 0) {
      apiLogger.info('circuit closed after successful probe', { dependency: key })
    }
    circuits.set(key, breakerOnSuccess(circuitFor(key)))
    return result
  } catch (error) {
    // A CircuitOpenError from a NESTED breaker is not evidence about THIS
    // dependency — counting it would let an inner breaker cascade an outer one
    // open over calls that were never actually attempted.
    if (error instanceof CircuitOpenError) throw error
    if (options.isFailure && !options.isFailure(error)) {
      // Not a health signal, but the probe flag must still be released or the
      // circuit stays half-open forever, refusing every subsequent call.
      const current = circuitFor(key)
      if (current.probing) circuits.set(key, { ...current, probing: false })
      throw error
    }
    const opened = breakerOnFailure(circuitFor(key), Date.now(), { threshold, cooldownMs })
    circuits.set(key, opened)
    if (opened.openUntilMs !== 0 && circuitFor(key).consecutiveFailures === threshold) {
      apiLogger.warn('circuit opened — failing fast', {
        dependency: key,
        consecutiveFailures: opened.consecutiveFailures,
        openMs: cooldownMs,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
}

/** Test seam: forget all breaker state. Never called in production code. */
export function resetBreakers(): void {
  circuits.clear()
}
