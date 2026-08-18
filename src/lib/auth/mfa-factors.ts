import { satisfiesMfaPolicy } from './enterprise-policy'

/**
 * Factor lifecycle rules, shared by the enrollment page, the factor-management
 * API, and the settings component.
 *
 * Structural rather than importing Supabase's Factor type: the client SDK and
 * the service-role admin API return the same wire shape, and depending on one
 * SDK's type would couple the pure logic to it for no gain.
 */
export interface TotpFactorLike {
  id: string
  factor_type: string
  status: 'verified' | 'unverified' | string
}

/** The verified/stale split the enrollment page keys its whole flow on. */
export function splitTotpFactors<F extends TotpFactorLike>(
  factors: readonly F[] | null | undefined,
): { verified: F[]; stale: F[] } {
  const totp = (factors ?? []).filter((factor) => factor.factor_type === 'totp')
  return {
    verified: totp.filter((factor) => factor.status === 'verified'),
    // An unverified factor is abandoned enrollment debris: Supabase refuses a
    // fresh enroll while one exists, which used to surface as a raw error toast.
    stale: totp.filter((factor) => factor.status !== 'verified'),
  }
}

/**
 * Would removing `removedId` strand this person behind their own MFA policy?
 *
 * True only when the policy requires MFA, no OTHER verified factor remains, and
 * no non-TOTP path (enterprise-brokered identity, company-domain OAuth — the
 * same escapes satisfiesMfaPolicy grants) can satisfy the policy for them. The
 * gate would then bounce their very next request to an enrollment page they can
 * complete, but a policy-required account deliberately never reaches "no
 * factor" through self-service — that transition is the admin reset's job.
 */
export function removalWouldLockOut(input: {
  policyRequired: boolean
  factors: readonly TotpFactorLike[]
  removedId: string
  methods: readonly string[]
  email: string | null | undefined
}): boolean {
  if (!input.policyRequired) return false
  const { verified } = splitTotpFactors(input.factors)
  const removingVerified = verified.some((factor) => factor.id === input.removedId)
  if (!removingVerified) return false
  const remaining = verified.filter((factor) => factor.id !== input.removedId)
  if (remaining.length > 0) return false
  // With no factor left, the session can never be aal2 — so the policy holds
  // only if an identity-based escape covers this account.
  return !satisfiesMfaPolicy('required', null, input.methods, input.email)
}
