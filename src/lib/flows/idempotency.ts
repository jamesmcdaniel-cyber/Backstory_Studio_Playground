import { createHash } from 'node:crypto'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Stable, provider-safe key for one logical flow side effect. */
export function flowSideEffectKey(flowRunId: string, iterationKey: string, page = 0): string {
  const digest = createHash('sha256').update(`${flowRunId}\u0000${iterationKey}\u0000${page}`).digest('hex')
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
