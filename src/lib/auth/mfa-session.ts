import { createClient } from '@/lib/supabase/server'
import { amrMethods } from './enterprise-policy'

/**
 * The caller's own assurance state, read server-side, for the one decision that
 * needs it: may this session REMOVE an authenticator?
 *
 * Separate from getAuthWithUser (which resolves identity and hands the gates an
 * `assuranceLevel`) because removal asks a narrower question than the gates do:
 * not "is this session strong enough to be here" but "did this person prove
 * possession of the factor recently enough that a stolen, still-warm browser
 * session cannot quietly strip their second factor". AAL alone answers the
 * first; it does not answer the second, because an aal2 session stays aal2 for
 * its whole life.
 *
 * Nothing here can raise assurance — AAL is minted by Supabase on a verified
 * challenge and by nothing else. This module only reads.
 */

/** How recently the step-up must have happened for a removal to be allowed. */
export const STEP_UP_MAX_AGE_MS = 15 * 60 * 1000

export interface MfaSessionState {
  assuranceLevel: string | null
  methods: string[]
  /**
   * When the MFA leg of this session happened, from the `amr` claim's per-entry
   * timestamp. Null when the token does not carry one — see stepUpSatisfied.
   */
  verifiedAt: Date | null
}

/** `amr` entries carry `{ method, timestamp }`; amrMethods drops the timestamp. */
const MFA_METHODS = new Set(['mfa', 'totp'])

export function mfaVerifiedAt(amr: unknown, now: number = Date.now()): Date | null {
  if (!Array.isArray(amr)) return null
  let latest: number | null = null
  for (const entry of amr) {
    if (!entry || typeof entry !== 'object') continue
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown }
    if (typeof method !== 'string' || !MFA_METHODS.has(method.toLowerCase())) continue
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue
    // Seconds since the epoch (JWT convention). A value already in milliseconds
    // would land centuries in the future, so treat anything beyond `now` as ms.
    const ms = timestamp > now ? timestamp : timestamp * 1000
    if (latest === null || ms > latest) latest = ms
  }
  return latest === null ? null : new Date(latest)
}

/**
 * Is this session freshly stepped up?
 *
 * aal2 is required unconditionally: with no verified factor a session can never
 * be aal2, so this also refuses the aal1 sessions that a workspace's optional
 * policy leaves untouched. Freshness is then enforced only when the token
 * exposes an MFA timestamp — on projects where getClaims falls back to getUser
 * the `amr` claim is not available at all, and turning a missing field into a
 * blanket refusal would make removal impossible rather than safer. That
 * degradation is deliberate and is the weaker half of this guard.
 */
export function stepUpSatisfied(
  state: MfaSessionState,
  now: number = Date.now(),
  maxAgeMs: number = STEP_UP_MAX_AGE_MS,
): boolean {
  if (state.assuranceLevel !== 'aal2') return false
  if (!state.verifiedAt) return true
  return now - state.verifiedAt.getTime() <= maxAgeMs
}

// Production-inert test seam, same construction as the auth seam in
// src/lib/server/auth.ts and the admin seam in mfa-admin.ts: Symbol.for so tsx's
// CJS/ESM duality cannot hand the test and the route two module instances,
// double-gated on NODE_ENV and TEST_DATABASE_URL so production always reads the
// real session.
const TEST_MFA_SESSION_SLOT = Symbol.for('backstory.testMfaSession')

export function setTestMfaSession(state: MfaSessionState | null): void {
  ;(globalThis as Record<symbol, unknown>)[TEST_MFA_SESSION_SLOT] = state
}

function getTestMfaSession(): MfaSessionState | null {
  return ((globalThis as Record<symbol, unknown>)[TEST_MFA_SESSION_SLOT] as MfaSessionState | null) ?? null
}

export async function readMfaSession(): Promise<MfaSessionState> {
  const injected = getTestMfaSession()
  if (injected && process.env.NODE_ENV !== 'production' && process.env.TEST_DATABASE_URL) return injected

  const supabase = await createClient()
  try {
    const { data } = await supabase.auth.getClaims()
    const claims = data?.claims
    if (claims?.sub) {
      return {
        assuranceLevel: typeof claims.aal === 'string' ? claims.aal : null,
        methods: amrMethods(claims.amr),
        verifiedAt: mfaVerifiedAt(claims.amr),
      }
    }
  } catch {
    // Fall through: an unreadable token is an unproven step-up, not an error.
  }
  return { assuranceLevel: null, methods: [], verifiedAt: null }
}
