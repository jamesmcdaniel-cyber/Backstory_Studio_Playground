import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { encryptSecret } from '@/lib/crypto/secrets'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { recordCredentialGrant } from '@/lib/credentials/audit'

export const runtime = 'nodejs'

/**
 * Where this workspace's audit trail is forwarded.
 *
 * The secret is never returned — only whether one is set — for the same reason
 * every other credential surface redacts: a settings page that can show you the
 * secret is a settings page that leaks it to whoever gets the session.
 */
function serialize(row: {
  id: string
  name: string
  url: string
  secret: string | null
  actionPrefixes: string[]
  isActive: boolean
  lastDeliveredAt: Date | null
  lastError: string | null
}) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    hasSecret: Boolean(row.secret),
    actionPrefixes: row.actionPrefixes,
    isActive: row.isActive,
    lastDeliveredAt: row.lastDeliveredAt,
    lastError: row.lastError,
  }
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const rows = await prisma.auditStreamDestination.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'asc' },
  })
  return { success: true, destinations: rows.map(serialize) }
}, { permission: 'org.manage' })

const body = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  secret: z.string().min(16).max(200).optional(),
  actionPrefixes: z.array(z.string().min(1).max(60)).max(20).default([]),
  isActive: z.boolean().default(true),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = body.parse(await request.json())

  // Guarded on save as well as on every delivery: telling someone their URL is
  // unreachable when they type it is better than a destination that silently
  // never delivers.
  try {
    await assertPublicUrl(input.url)
  } catch (error) {
    if (error instanceof SsrfError) {
      throw new ApiError('That destination URL is not allowed. Use a public https endpoint.', 400, 'INVALID_URL')
    }
    throw error
  }

  const created = await prisma.auditStreamDestination.create({
    data: {
      organizationId: auth.organizationId,
      name: input.name,
      url: input.url,
      secret: input.secret ? encryptSecret(input.secret) : null,
      actionPrefixes: input.actionPrefixes,
      isActive: input.isActive,
    },
  })
  // The grant IS audited here, at the one place a signing secret enters the
  // system — delivery cannot audit its own reads without recursing (see
  // lib/audit/stream-delivery.ts).
  await recordCredentialGrant({
    organizationId: auth.organizationId,
    kind: 'audit_stream',
    credentialId: created.id,
    provider: new URL(created.url).hostname,
    ownerUserId: null,
    actorUserId: auth.dbUser.id,
    method: 'audit_stream_secret',
  }).catch(() => undefined)

  return { success: true, destination: serialize(created) }
}, { permission: 'org.manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.searchParams.get('id')
  if (!id) throw new ApiError('A destination id is required', 400, 'INVALID_REQUEST')
  const removed = await prisma.auditStreamDestination.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (removed.count !== 1) throw new ApiError('Destination not found', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'org.manage' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = z
    .object({ id: z.string().min(1), isActive: z.boolean() })
    .parse(await request.json())
  const updated = await prisma.auditStreamDestination.updateMany({
    where: { id: input.id, organizationId: auth.organizationId },
    // Re-enabling clears the last error: it is about the previous attempt, and
    // leaving it would make a working destination look broken.
    data: { isActive: input.isActive, ...(input.isActive ? { lastError: null } : {}) } as Prisma.AuditStreamDestinationUpdateManyMutationInput,
  })
  if (updated.count !== 1) throw new ApiError('Destination not found', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'org.manage' })
