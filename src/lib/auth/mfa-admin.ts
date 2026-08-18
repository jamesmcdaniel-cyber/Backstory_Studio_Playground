import { supabaseAdmin } from '@/lib/scim/server'
import type { TotpFactorLike } from './mfa-factors'

/**
 * Service-role factor administration, behind one narrow interface.
 *
 * Two callers need it: the admin "Reset MFA" action (delete every factor so a
 * locked-out person can re-enroll) and the self-service factor-management route
 * (list/remove the caller's own factors with policy guards). Both go through
 * this module so the tests can drive the REAL route logic — guards, audit rows,
 * refusals — against a fake Supabase, which is the part worth proving. AAL
 * itself stays Supabase-controlled: nothing here can mint an aal2 session.
 */

export interface AdminFactor extends TotpFactorLike {
  friendly_name?: string | null
  created_at?: string
}

export interface MfaAdminApi {
  listFactors(supabaseId: string): Promise<AdminFactor[]>
  deleteFactor(supabaseId: string, factorId: string): Promise<void>
}

// Production-inert test seam, same construction (and reasoning) as the auth
// seam in src/lib/server/auth.ts: Symbol.for so tsx's CJS/ESM duality cannot
// give the test and the route two different module instances, double-gated on
// NODE_ENV and TEST_DATABASE_URL so production always talks to real Supabase.
const TEST_MFA_ADMIN_SLOT = Symbol.for('backstory.testMfaAdmin')

export function setTestMfaAdmin(api: MfaAdminApi | null): void {
  ;(globalThis as Record<symbol, unknown>)[TEST_MFA_ADMIN_SLOT] = api
}

function getTestMfaAdmin(): MfaAdminApi | null {
  return ((globalThis as Record<symbol, unknown>)[TEST_MFA_ADMIN_SLOT] as MfaAdminApi | null) ?? null
}

function testSeamActive(): boolean {
  return process.env.NODE_ENV !== 'production' && Boolean(process.env.TEST_DATABASE_URL)
}

export function mfaAdmin(): MfaAdminApi {
  const injected = getTestMfaAdmin()
  if (injected && testSeamActive()) return injected
  return {
    async listFactors(supabaseId) {
      const { data, error } = await supabaseAdmin().mfa.listFactors({ userId: supabaseId })
      if (error) throw error
      return (data?.factors ?? []) as AdminFactor[]
    },
    async deleteFactor(supabaseId, factorId) {
      const { error } = await supabaseAdmin().mfa.deleteFactor({ userId: supabaseId, id: factorId })
      if (error) throw error
    },
  }
}

/**
 * Remove EVERY factor (verified or stale) from an account — the admin reset.
 * Returns how many were removed so the audit row can say so. Deleting a factor
 * also revokes the user's aal2 sessions on Supabase's side, so the next request
 * meets the MFA gate and routes them to /auth/mfa to enroll fresh.
 */
export async function deleteAllFactors(supabaseId: string): Promise<number> {
  const api = mfaAdmin()
  const factors = await api.listFactors(supabaseId)
  for (const factor of factors) {
    await api.deleteFactor(supabaseId, factor.id)
  }
  return factors.length
}
