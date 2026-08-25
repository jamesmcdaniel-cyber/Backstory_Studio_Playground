import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/**
 * Is the SIGNED-IN person linked to a Slack account?
 *
 * This exists because "connected" and "linked" can disagree, and until now
 * nothing surfaced the difference. captureSlackIdentity runs fire-and-forget
 * from the Nango webhook, so a Slack outage at connect time leaves the person
 * with a working Slack connection and NO SlackIdentity row — /integrations says
 * connected while every mention still answers "connect your Slack account",
 * with nothing anywhere to reconcile them.
 *
 * GET reports both facts separately. POST retries the capture.
 */
const slackConnectionFor = (organizationId: string, userId: string) =>
  prisma.nangoConnection.findFirst({
    where: {
      organizationId,
      userId,
      status: 'connected',
      providerConfigKey: { contains: 'slack', mode: 'insensitive' },
    },
    select: { connectionId: true, providerConfigKey: true },
  })

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [identity, connection] = await Promise.all([
    prisma.slackIdentity.findFirst({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
      select: { slackUserId: true, verifiedAt: true },
    }),
    slackConnectionFor(auth.organizationId, auth.dbUser.id),
  ])

  return {
    success: true,
    // Linked = we know who you are in Slack. This is what mentions require.
    linked: Boolean(identity),
    slackUserId: identity?.slackUserId ?? null,
    verifiedAt: identity?.verifiedAt ?? null,
    // Connected = a personal Slack connection exists. Connected without linked
    // is the recoverable state POST below is for.
    connected: Boolean(connection),
  }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (_request, auth) => {
  const connection = await slackConnectionFor(auth.organizationId, auth.dbUser.id)
  if (!connection) {
    return { success: false, linked: false, connected: false, reason: 'no-connection' as const }
  }

  const { captureSlackIdentity } = await import('@/lib/slack/identity')
  const result = await captureSlackIdentity({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
  })

  return {
    success: Boolean(result),
    linked: Boolean(result),
    connected: true,
    slackUserId: result?.slackUserId ?? null,
    ...(result ? {} : { reason: 'slack-unreachable' as const }),
  }
}, { permission: 'integration.manage' })
