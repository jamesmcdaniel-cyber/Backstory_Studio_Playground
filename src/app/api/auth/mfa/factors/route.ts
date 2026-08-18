import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { isPlatformPrivileged } from '@/lib/authz/permissions'
import type { AuthContext } from '@/lib/server/auth'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'
import { mfaAdmin } from '@/lib/auth/mfa-admin'
import { removalWouldLockOut, splitTotpFactors } from '@/lib/auth/mfa-factors'
import { readMfaSession, stepUpSatisfied } from '@/lib/auth/mfa-session'

/**
 * Self-service authenticator management for the CALLER's own account.
 *
 * Removal runs through the service-role admin API rather than the browser's
 * supabase.auth.mfa.unenroll for one reason: a client-side unenroll answers to
 * nothing but Supabase, so neither of the two guards below could exist. Here
 * they are the boundary — the settings UI disables the button for the same
 * reasons, but that gate is a courtesy and this one is the enforcement.
 *
 * Two refusals:
 *   STEP_UP_REQUIRED — the session has not proven possession of a factor
 *     recently (see mfa-session.ts). Without this, a stolen still-warm session
 *     could strip the second factor that would otherwise contain it.
 *   LAST_FACTOR — removing this one would leave an account whose policy REQUIRES
 *     MFA with no way to satisfy it. That transition belongs to the admin reset
 *     (an operator who has identified the person), not to self-service.
 */

const deleteSchema = z.object({ factorId: z.string().min(1) })

/**
 * Does policy hold this caller to MFA? The workspace switch, plus the implicit
 * requirement on platform-privileged accounts (src/lib/server/auth.ts) that no
 * workspace setting can lower. The platform owner is exempt there and so is
 * exempt here — every lockout in the auth path exempts them deliberately.
 */
function policyRequiresMfa(auth: AuthContext): boolean {
  if (isPlatformOwnerEmail(auth.dbUser.email)) return false
  if (isPlatformPrivileged(auth.permissions)) return true
  return auth.dbUser.organization?.mfaPolicy === 'required'
}

export const GET = withAuthenticatedApi(
  async (_request, auth) => {
    const session = await readMfaSession()
    const factors = await mfaAdmin().listFactors(auth.dbUser.supabaseId)
    const { verified, stale } = splitTotpFactors(factors)
    const policyRequired = policyRequiresMfa(auth)
    return {
      success: true,
      // `removable` is computed HERE, by the same function DELETE enforces with,
      // so the button's disabled state and the refusal can never disagree.
      factors: [...verified, ...stale].map((factor) => ({
        id: factor.id,
        friendlyName: factor.friendly_name ?? null,
        status: factor.status,
        createdAt: factor.created_at ?? null,
        removable: !removalWouldLockOut({
          policyRequired,
          factors,
          removedId: factor.id,
          methods: session.methods,
          email: auth.dbUser.email,
        }),
      })),
      policyRequired,
      stepUpSatisfied: stepUpSatisfied(session),
    }
  },
  { permission: null },
)

export const DELETE = withAuthenticatedApi(
  async (request, auth) => {
    const { factorId } = deleteSchema.parse(await request.json())
    const session = await readMfaSession()

    if (!stepUpSatisfied(session)) {
      throw new ApiError(
        'Verify with your authenticator again before removing it.',
        403,
        'STEP_UP_REQUIRED',
      )
    }

    const factors = await mfaAdmin().listFactors(auth.dbUser.supabaseId)
    if (!factors.some((factor) => factor.id === factorId)) {
      throw new ApiError('That authenticator is not on your account.', 404, 'NOT_FOUND')
    }

    if (
      removalWouldLockOut({
        policyRequired: policyRequiresMfa(auth),
        factors,
        removedId: factorId,
        methods: session.methods,
        email: auth.dbUser.email,
      })
    ) {
      throw new ApiError(
        'This is your only authenticator and your account requires multi-factor authentication. Add another one first, or ask an administrator to reset it.',
        400,
        'LAST_FACTOR',
      )
    }

    await mfaAdmin().deleteFactor(auth.dbUser.supabaseId, factorId)
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'account.mfa.factor_removed',
      resourceType: 'user',
      resourceId: auth.userId,
      detail: { factorId },
    })
    return { success: true }
  },
  { permission: null },
)
