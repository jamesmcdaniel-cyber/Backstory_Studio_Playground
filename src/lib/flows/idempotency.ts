import { createHash } from 'node:crypto'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Stable, provider-safe key for one logical flow side effect.
 *
 * `scopeKey` is the idempotency scope — the run id for most runs, and
 * `${flowId}:${dedupeValue}` for poll-triggered ones, so two runs for the same
 * polled item produce the same key. See side-effect-ledger.ts's runScopeKey;
 * that function is the only thing that should compute a scope.
 */
export function flowSideEffectKey(scopeKey: string, iterationKey: string, page = 0): string {
  // NUL separator, not a plain delimiter: a scope or node id containing the
  // separator could otherwise be re-partitioned into a colliding key. Written
  // as an escape rather than a literal NUL byte so it survives tooling.
  const digest = createHash('sha256')
    .update(`${scopeKey}\u0000${iterationKey}\u0000${page}`)
    .digest('hex')
  return `bs_${digest}`
}

/** Add the standard idempotency header without overriding a user's explicit key. */
export function withIdempotencyHeader(
  headers: Record<string, string>,
  method: string,
  key: string,
): Record<string, string> {
  if (SAFE_METHODS.has(method.toUpperCase())) return headers
  if (Object.keys(headers).some((name) => name.trim().toLowerCase() === 'idempotency-key')) return headers
  return { ...headers, 'idempotency-key': key }
}
