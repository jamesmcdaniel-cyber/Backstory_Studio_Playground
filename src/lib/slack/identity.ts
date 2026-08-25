/**
 * Who a Slack user is, captured when they link their own Slack account.
 *
 * Connect-time capture, not a lazy first-mention lookup — the same reasoning
 * that put the bot's teamId/botUserId on the credential at save time. At
 * mention time all we have is a `U…` id; if nothing already maps it, the
 * fail-closed rule refuses the run rather than guessing.
 *
 * The token belongs to the PERSON (a per-user NangoConnection), so `auth.test`
 * through the Nango proxy answers with their Slack identity, not the app's.
 */

import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { defaultProxy, type NangoProxy } from '@/lib/nango/delivery'

export async function captureSlackIdentity(params: {
  organizationId: string
  userId: string
  connectionId: string
  providerConfigKey: string
  proxy?: NangoProxy
}): Promise<{ slackUserId: string } | null> {
  const proxy = params.proxy ?? defaultProxy()

  let slackUserId = ''
  try {
    const { data } = await proxy({
      method: 'POST',
      endpoint: '/auth.test',
      connectionId: params.connectionId,
      providerConfigKey: params.providerConfigKey,
    })
    const body = (data ?? {}) as Record<string, unknown>
    // Slack answers HTTP 200 even for a rejected token; `ok` is the real result.
    if (body.ok === true && typeof body.user_id === 'string') slackUserId = body.user_id
  } catch (error) {
    // Swallowed on purpose: this runs inside the Nango webhook, and a Slack
    // outage must not fail the whole connection-mirroring path. The person is
    // connected either way — they just cannot summon agents until this is
    // retried on their next reconnect.
    apiLogger.warn('slack identity capture failed', {
      organizationId: params.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  if (!slackUserId) return null

  // Upsert on (organizationId, slackUserId), NOT on the user: a Slack account
  // moving to a different person must RE-POINT the mapping. Keying it the other
  // way would either throw on the unique constraint and 500 the webhook, or
  // leave the stale mapping winning so mentions run as the wrong human.
  await systemPrisma.slackIdentity.upsert({
    where: { organizationId_slackUserId: { organizationId: params.organizationId, slackUserId } },
    update: { userId: params.userId, verifiedAt: new Date() },
    create: { organizationId: params.organizationId, slackUserId, userId: params.userId },
  })

  return { slackUserId }
}

/**
 * Backfill identities for every PERSONAL Slack connection in a workspace that
 * has none yet.
 *
 * Called after the Nango auth webhook re-syncs connections. Hooked here rather
 * than inside the sync so it stays independent of that function's shape, and
 * because it is naturally idempotent: already-captured people are skipped, so
 * a re-sync costs nothing.
 *
 * Org-shared rows (userId null) are excluded — auth.test on the workspace's own
 * connection returns the APP, not a human, and writing that would map a real
 * Slack id to whoever happened to install it.
 */
export async function captureSlackIdentitiesForOrg(organizationId: string): Promise<number> {
  const connections = await systemPrisma.nangoConnection.findMany({
    where: {
      organizationId,
      userId: { not: null },
      status: 'connected',
      providerConfigKey: { contains: 'slack', mode: 'insensitive' },
    },
    select: { userId: true, connectionId: true, providerConfigKey: true },
    take: 200,
  })
  if (connections.length === 0) return 0

  const alreadyLinked = new Set(
    (
      await systemPrisma.slackIdentity.findMany({
        where: { organizationId, userId: { in: connections.map((row) => row.userId as string) } },
        select: { userId: true },
      })
    ).map((row) => row.userId),
  )

  let captured = 0
  for (const connection of connections) {
    if (!connection.userId || alreadyLinked.has(connection.userId)) continue
    const result = await captureSlackIdentity({
      organizationId,
      userId: connection.userId,
      connectionId: connection.connectionId,
      providerConfigKey: connection.providerConfigKey,
    })
    if (result) captured += 1
  }
  return captured
}
