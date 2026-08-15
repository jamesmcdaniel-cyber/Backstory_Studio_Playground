import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildAuthConfig } from '@/lib/crypto/secrets'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  CREDENTIAL_FIELD,
  CREDENTIAL_SPECS,
  isCredentialProvider,
  verifyCredential,
  type CredentialProvider,
} from '@/lib/integrations/credential-providers'
import { readOrgSecret, envFallbackAllowed } from '@/lib/integrations/org-credential'
import { recordAudit } from '@/lib/audit'
import { recordCredentialGrant, recordCredentialRotation } from '@/lib/credentials/audit'

export const runtime = 'nodejs'

/**
 * Per-workspace credentials for the built-in integrations (Slack, Email,
 * Granola).
 *
 * Without this there is no way for a customer org to supply its own key, and
 * the per-org gate in org-credential.ts would just turn those integrations off
 * for everyone outside internal/partner with no remedy. The key itself is never
 * returned by any method here — only whether one is configured and where it
 * came from.
 */

const ENV_VALUE: Record<CredentialProvider, () => string | undefined> = {
  slack: () => process.env.SLACK_BOT_TOKEN,
  email: () => process.env.RESEND_API_KEY,
  granola: () => process.env.GRANOLA_API_KEY,
}

function providerFrom(request: NextRequest): CredentialProvider {
  const raw = request.nextUrl.pathname.split('/').at(-1) ?? ''
  if (!isCredentialProvider(raw)) throw new ApiError('Unknown integration', 404, 'NOT_FOUND')
  return raw
}

async function state(organizationId: string, provider: CredentialProvider) {
  const spec = CREDENTIAL_SPECS[provider]
  const [orgSecret, organization] = await Promise.all([
    readOrgSecret(organizationId, provider, CREDENTIAL_FIELD),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { kind: true } }),
  ])

  const envAvailable = Boolean(ENV_VALUE[provider]()) && envFallbackAllowed(organization?.kind)
  return {
    provider,
    label: spec.label,
    fieldLabel: spec.fieldLabel,
    hint: spec.hint,
    docsUrl: spec.docsUrl,
    /** A key of this org's own is saved. */
    hasOwnKey: Boolean(orgSecret),
    /** The integration resolves at all (own key, or a permitted env fallback). */
    configured: Boolean(orgSecret) || envAvailable,
    source: orgSecret ? ('org' as const) : envAvailable ? ('env' as const) : null,
  }
}

// ── GET — connection state (never returns the credential) ─────────────────

export const GET = withAuthenticatedApi(async (request, auth) => {
  const provider = providerFrom(request)
  return { success: true, ...(await state(auth.organizationId, provider)) }
}, { permission: 'flow.read' })

// ── POST — verify against the provider, then save encrypted ───────────────

export const POST = withAuthenticatedApi(async (request, auth) => {
  const provider = providerFrom(request)
  const spec = CREDENTIAL_SPECS[provider]
  const { credential } = z
    .object({ credential: z.string().trim().min(1) })
    .parse(await request.json())

  const check = await verifyCredential(provider, credential)
  if (!check.ok) {
    // A rejected credential and an unreachable provider need different actions
    // from the user, so they get different statuses and different words.
    if (check.status === 401 || check.status === 403) {
      throw new ApiError(`${spec.label} rejected that credential. Check it and try again.`, 400, 'INVALID_CREDENTIAL')
    }
    throw new ApiError(`Could not reach ${spec.label} to verify the credential. Please try again.`, 502, 'UPSTREAM_ERROR')
  }

  const authConfig = buildAuthConfig({ authType: 'api_key', apiKey: credential }) as Prisma.InputJsonObject

  const existing = await prisma.integrationSecret.findUnique({
    where: { organizationId_provider: { organizationId: auth.organizationId, provider } },
    select: { id: true },
  })

  const secret = await prisma.integrationSecret.upsert({
    where: { organizationId_provider: { organizationId: auth.organizationId, provider } },
    update: { authType: 'api_key', authConfig, isActive: true, lastRotatedAt: new Date() },
    create: {
      organizationId: auth.organizationId,
      provider,
      authType: 'api_key',
      authConfig,
      isActive: true,
      lastRotatedAt: new Date(),
    },
  })

  // This is a workspace-SHARED credential — every agent in the org acts through
  // it — so who introduced it is the single most useful thing to be able to
  // look up later.
  const record = existing ? recordCredentialRotation : recordCredentialGrant
  await record({
    organizationId: auth.organizationId,
    kind: 'integration_secret',
    credentialId: secret.id,
    provider,
    ownerUserId: null,
    actorUserId: auth.userId,
    method: 'api_key_entry',
  })

  return { success: true, ...(await state(auth.organizationId, provider)) }
}, { permission: 'integration.manage' })

// ── DELETE — drop this workspace's credential ─────────────────────────────

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const provider = providerFrom(request)
  const existing = await prisma.integrationSecret.findUnique({
    where: { organizationId_provider: { organizationId: auth.organizationId, provider } },
    select: { id: true },
  })
  await prisma.integrationSecret.deleteMany({
    where: { organizationId: auth.organizationId, provider },
  })
  if (existing) {
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'credential.revoked',
      actorUserId: auth.userId,
      resourceType: 'integration_secret',
      resourceId: existing.id,
      detail: { provider, reason: 'deleted_by_user' },
    })
  }
  // For a customer workspace this turns the integration OFF — there is no env
  // fallback to catch it, by design. `state` reports that honestly.
  return { success: true, ...(await state(auth.organizationId, provider)) }
}, { permission: 'integration.manage' })
