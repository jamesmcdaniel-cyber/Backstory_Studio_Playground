import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { buildAuthConfig } from '@/lib/crypto/secrets'
import { recordAudit } from '@/lib/audit'
import { recordCredentialGrant, recordCredentialRotation } from '@/lib/credentials/audit'
import { getGranolaApiKey, testGranolaApiKey } from '@/lib/integrations/granola'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

async function granolaState(organizationId: string) {
  const resolved = await getGranolaApiKey(organizationId)
  return {
    configured: Boolean(resolved),
    source: resolved?.source ?? null,
  }
}

// ── GET — connection state (never returns the key) ────────────────────────

export const GET = withAuthenticatedApi(async (_request, auth) => {
  return { success: true, ...(await granolaState(auth.organizationId)) }
}, { permission: 'flow.read' })

// ── POST — validate and save the org's Granola API key (encrypted) ────────

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { apiKey } = z
    .object({ apiKey: z.string().trim().min(1) })
    .parse(await request.json())

  const test = await testGranolaApiKey(apiKey)
  if (!test.ok) {
    if (test.status === 401 || test.status === 403) {
      throw new ApiError('Granola rejected that API key. Check the key and try again.', 400, 'INVALID_KEY')
    }
    throw new ApiError('Could not reach Granola to verify the key. Please try again.', 502, 'UPSTREAM_ERROR')
  }

  const authConfig = buildAuthConfig({ authType: 'api_key', apiKey }) as Prisma.InputJsonObject

  const existing = await prisma.integrationSecret.findUnique({
    where: {
      organizationId_provider: { organizationId: auth.organizationId, provider: 'granola' },
    },
    select: { id: true },
  })

  const secret = await prisma.integrationSecret.upsert({
    where: {
      organizationId_provider: { organizationId: auth.organizationId, provider: 'granola' },
    },
    update: { authType: 'api_key', authConfig, isActive: true, lastRotatedAt: new Date() },
    create: {
      organizationId: auth.organizationId,
      provider: 'granola',
      authType: 'api_key',
      authConfig,
      isActive: true,
      lastRotatedAt: new Date(),
    },
  })

  const record = existing ? recordCredentialRotation : recordCredentialGrant
  await record({
    organizationId: auth.organizationId,
    kind: 'integration_secret',
    credentialId: secret.id,
    provider: 'granola',
    ownerUserId: null,
    actorUserId: auth.userId,
    method: 'api_key_entry',
  })

  return { success: true, ...(await granolaState(auth.organizationId)) }
}, { permission: 'integration.manage' })

// ── DELETE — remove the org key (env fallback still applies, if set) ──────

export const DELETE = withAuthenticatedApi(async (_request, auth) => {
  const existing = await prisma.integrationSecret.findUnique({
    where: {
      organizationId_provider: { organizationId: auth.organizationId, provider: 'granola' },
    },
    select: { id: true },
  })
  await prisma.integrationSecret.deleteMany({
    where: { organizationId: auth.organizationId, provider: 'granola' },
  })
  if (existing) {
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'credential.revoked',
      actorUserId: auth.userId,
      resourceType: 'integration_secret',
      resourceId: existing.id,
      detail: { provider: 'granola', reason: 'deleted_by_user' },
    })
  }

  return { success: true, ...(await granolaState(auth.organizationId)) }
}, { permission: 'integration.manage' })
