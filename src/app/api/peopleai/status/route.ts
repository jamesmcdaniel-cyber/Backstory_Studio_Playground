import { NextResponse } from 'next/server'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { prisma } from '@/lib/prisma'
import { entitlementGateEnabled } from '@/lib/server/auth'

export const runtime = 'nodejs'

/**
 * Connection status for the CURRENT user. Deliberately not entitlement-gated
 * (withAuthenticatedApi would 403 the very users who need to see this) — it
 * only requires a session.
 */
export async function GET() {
  const auth = await getAuthWithUser()
  if (!auth?.dbUser || !auth.organizationId) {
    return NextResponse.json({ success: false, error: 'Authentication required', code: 'AUTH_ERROR' }, { status: 401 })
  }

  const [connection, org] = await Promise.all([
    prisma.peopleAiConnection.findFirst({
      // findFirst: see getPeopleAiClientForUser — the owner-liveness filter
      // cannot be injected into a findUnique where clause.
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
      select: { status: true, teamId: true, membershipId: true, lastVerifiedAt: true },
    }),
    prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { peopleAiTeamId: true, entitlementStatus: true, entitlementTier: true },
    }),
  ])

  return NextResponse.json({
    success: true,
    configured: Boolean(process.env.PEOPLE_AI_OAUTH_CLIENT_ID),
    gateEnabled: entitlementGateEnabled(),
    connection: connection
      ? { status: connection.status, teamId: connection.teamId, membershipId: connection.membershipId, lastVerifiedAt: connection.lastVerifiedAt }
      : null,
    organization: {
      peopleAiTeamId: org?.peopleAiTeamId ?? null,
      entitlementStatus: org?.entitlementStatus ?? 'unknown',
      entitlementTier: org?.entitlementTier ?? null,
    },
  })
}
