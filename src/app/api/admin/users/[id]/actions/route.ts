import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { supabaseAdmin } from '@/lib/scim/server'
import { resetMonthlyTokenUsage } from '@/lib/usage/budget'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'
import { deprovisionUser } from '@/lib/revoke-user-access'

/**
 * Operator actions on one account.
 *
 * One route with a discriminated action rather than five sibling routes: they
 * share the target lookup and the owner/self guards, and splitting them is how
 * one of the five ends up missing a check.
 *
 * Every branch writes an audit row naming the operator and the target. These
 * are the most consequential things anyone can do to another person's account,
 * so an unaudited path here is not acceptable even when it fails.
 */

const bodySchema = z.object({
  action: z.enum([
    'deactivate',
    'reactivate',
    'reset-password',
    'reset-monthly-tokens',
    'reset-daily-runs',
  ]),
})

/** Supabase's long ban, matching what the SCIM deprovisioning path uses. */
const FOREVER = '876000h'

/**
 * A client bound to the ANON key, used only to trigger the recovery email.
 *
 * The service-role admin client cannot do this job: generateLink returns a link
 * but sends nothing, and this route has no mailer. resetPasswordForEmail goes
 * through Supabase's own mail configuration, which means the operator never
 * handles a credential and nothing sensitive reaches a log or a response body.
 */
function supabasePublic() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new ApiError('Supabase is not configured.', 500, 'SUPABASE_UNCONFIGURED')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2) ?? ''
  const { action } = bodySchema.parse(await request.json())

  // systemPrisma: the target is in some OTHER workspace nearly every time —
  // that is what makes this an operator console rather than member management.
  const target = await systemPrisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, supabaseId: true, isActive: true, organizationId: true },
  })
  if (!target) throw new ApiError('User not found.', 404, 'NOT_FOUND')

  const audit = (detail: Record<string, unknown>) =>
    recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: `platform.users.${action}`,
      resourceType: 'user',
      resourceId: target.id,
      detail: { targetEmail: target.email, targetOrganizationId: target.organizationId, ...detail },
    })

  switch (action) {
    case 'deactivate': {
      // Two refusals, for different reasons. The owner is protected by a
      // users-table trigger that would abort the write anyway — catching it here
      // turns a raw Postgres exception into a sentence. Self-deactivation is
      // refused because it locks the operator out of the console they would need
      // to undo it.
      if (isPlatformOwnerEmail(target.email)) {
        throw new ApiError('The platform owner cannot be deactivated.', 403, 'OWNER_PROTECTED')
      }
      if (target.id === auth.userId) {
        throw new ApiError('You cannot deactivate your own account.', 400, 'SELF_DEACTIVATION')
      }

      // Ban first, then flip the column. In this order a failure leaves the
      // account still active and still bannable — the reverse would mark someone
      // deactivated in our database while their Supabase session lived on.
      await supabaseAdmin()
        .updateUserById(target.supabaseId, { ban_duration: FOREVER })
        .catch(() => {
          throw new ApiError('Could not deactivate the account in Supabase.', 502, 'SUPABASE_ERROR')
        })
      // Deprovision, not a bare isActive flip: a suspended account used to keep
      // every credential it held, so its OAuth grants stayed live at the
      // provider and its scheduled work kept running under a colleague.
      if (target.organizationId) {
        await deprovisionUser({
          userId: target.id,
          organizationId: target.organizationId,
          reason: 'deactivated',
          actorUserId: auth.userId,
        })
      } else {
        // No workspace means no org-scoped credentials to revoke.
        await systemPrisma.user.update({ where: { id: target.id }, data: { isActive: false } })
      }
      await audit({})
      return { success: true, isActive: false }
    }

    case 'reactivate': {
      await supabaseAdmin()
        .updateUserById(target.supabaseId, { ban_duration: 'none' })
        .catch(() => {
          throw new ApiError('Could not reactivate the account in Supabase.', 502, 'SUPABASE_ERROR')
        })
      await systemPrisma.user.update({ where: { id: target.id }, data: { isActive: true } })
      await audit({})
      return {
        success: true,
        isActive: true,
        // Deactivation deleted the OAuth grants at the provider, not just our
        // copy, so there is nothing to restore. The operator has to know the
        // person will land in an app with no integrations connected — otherwise
        // correct behaviour reads as a bug.
        credentialsRestored: false,
        notice:
          'Their integrations were revoked when the account was deactivated. They will need to reconnect each one.',
      }
    }

    case 'reset-password': {
      if (!target.email) {
        throw new ApiError('That account has no email address to send a reset link to.', 400, 'NO_EMAIL')
      }
      const redirectTo = new URL('/auth/callback', request.nextUrl.origin)
      redirectTo.searchParams.set('next', '/auth/update-password')

      const { error } = await supabasePublic().auth.resetPasswordForEmail(target.email, {
        redirectTo: redirectTo.toString(),
      })
      if (error) throw new ApiError('Could not send the reset email.', 502, 'SUPABASE_ERROR')

      await audit({})
      return { success: true, sentTo: target.email }
    }

    case 'reset-monthly-tokens': {
      if (!target.organizationId) {
        throw new ApiError('That account has no workspace, so it has no token counter.', 400, 'NO_WORKSPACE')
      }
      await resetMonthlyTokenUsage(target.organizationId)
      await audit({ scope: 'workspace' })
      return { success: true }
    }

    case 'reset-daily-runs': {
      // A watermark, not a decrement: the cap counts run rows, which cannot be
      // un-counted. See runWindowStart.
      const runAllowanceResetAt = new Date()
      await systemPrisma.user.update({ where: { id: target.id }, data: { runAllowanceResetAt } })
      await audit({ runAllowanceResetAt })
      return { success: true, runAllowanceResetAt }
    }
  }
}, { permission: 'platform.administer', internalOnly: true })
