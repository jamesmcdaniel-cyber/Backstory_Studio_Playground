import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mergeAuthConfig, encryptSecret } from '@/lib/crypto/secrets'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  CREDENTIAL_FIELD,
  CREDENTIAL_SPECS,
  isCredentialProvider,
  verifyCredential,
  type CredentialProvider,
} from '@/lib/integrations/credential-providers'
import { readOrgSecret, envFallbackAllowed } from '@/lib/integrations/org-credential'
import { findConflictingSlackOrg } from '@/lib/integrations/slack'
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
  const [orgSecret, organization, secretRow] = await Promise.all([
    readOrgSecret(organizationId, provider, CREDENTIAL_FIELD),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { kind: true } }),
    provider === 'slack'
      ? prisma.integrationSecret.findUnique({
          where: { organizationId_provider: { organizationId, provider } },
          select: { authConfig: true },
        })
      : null,
  ])

  const envAvailable = Boolean(ENV_VALUE[provider]()) && envFallbackAllowed(organization?.kind)
  const slackConfig =
    provider === 'slack' && secretRow?.authConfig && typeof secretRow.authConfig === 'object' && !Array.isArray(secretRow.authConfig)
      ? (secretRow.authConfig as Record<string, unknown>)
      : null
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
    // Slack-only: whether the Events API receiver (src/app/api/slack/events/
    // route.ts) has a signing secret to verify this workspace's deliveries
    // with — a saved Slack credential missing this can post outbound but
    // can never receive verified inbound events.
    ...(provider === 'slack' ? { hasSigningSecret: Boolean(slackConfig?.signingSecret) } : {}),
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
  const { credential, signingSecret } = z
    .object({
      credential: z.string().trim().min(1),
      // Slack only: the app's signing secret, needed by the Events API
      // receiver (src/app/api/slack/events/route.ts) to verify inbound
      // deliveries. Optional on every call so replacing/rotating the bot
      // token alone doesn't force re-entering it (mergeAuthConfig below
      // carries the existing one forward) — but required the first time,
      // since without it this workspace's events can never be verified.
      signingSecret: z.string().trim().min(1).optional(),
    })
    .parse(await request.json())

  const existing = await prisma.integrationSecret.findUnique({
    where: { organizationId_provider: { organizationId: auth.organizationId, provider } },
    select: { id: true, authConfig: true },
  })
  const existingConfig =
    existing?.authConfig && typeof existing.authConfig === 'object' && !Array.isArray(existing.authConfig)
      ? (existing.authConfig as Record<string, unknown>)
      : {}

  if (provider === 'slack' && !signingSecret && !existingConfig.signingSecret) {
    throw new ApiError(
      'Slack needs a signing secret the first time you connect this workspace, so incoming events can be verified.',
      400,
      'MISSING_SIGNING_SECRET',
    )
  }

  const check = await verifyCredential(provider, credential)
  if (!check.ok) {
    // A rejected credential and an unreachable provider need different actions
    // from the user, so they get different statuses and different words.
    if (check.status === 401 || check.status === 403) {
      throw new ApiError(`${spec.label} rejected that credential. Check it and try again.`, 400, 'INVALID_CREDENTIAL')
    }
    throw new ApiError(`Could not reach ${spec.label} to verify the credential. Please try again.`, 502, 'UPSTREAM_ERROR')
  }

  // A Slack `team_id` is how the Events API receiver (src/app/api/slack/
  // events/route.ts) routes an inbound delivery back to an org — so two orgs
  // claiming the SAME team_id is not a cosmetic conflict, it's every event
  // for that workspace silently misrouted to whichever org
  // findSlackWorkspaceByTeamId's deterministic scan happens to return first,
  // with no error and no audit trail pointing at why. Rejected here, before
  // ever reaching that ambiguity, and audited either way this org's own
  // token check turns out.
  if (provider === 'slack' && check.slackIdentity) {
    const conflictOrgId = await findConflictingSlackOrg(check.slackIdentity.teamId, auth.organizationId)
    if (conflictOrgId) {
      await recordAudit({
        organizationId: auth.organizationId,
        action: 'credential.rejected',
        actorUserId: auth.userId,
        resourceType: 'integration_secret',
        resourceId: `slack:${check.slackIdentity.teamId}`,
        detail: { provider: 'slack', reason: 'team_id_already_connected', teamId: check.slackIdentity.teamId },
      })
      throw new ApiError('This Slack workspace is already connected to a different Backstory workspace.', 409, 'SLACK_TEAM_ALREADY_CONNECTED')
    }
  }

  // mergeAuthConfig (not buildAuthConfig) so Slack's extra, non-generic
  // fields below (signingSecret/teamId/botUserId) survive a bot-token-only
  // rotation instead of being dropped by a full replace.
  let authConfig = mergeAuthConfig(existingConfig, { authType: 'api_key', apiKey: credential }) as Record<string, unknown>
  if (provider === 'slack') {
    authConfig = {
      ...authConfig,
      // Captured from the same auth.test call verifyCredential just made —
      // connect-time capture, not a lazy first-event fallback (see
      // .superpowers/sdd/2026-08-21-activity-event-substrate/task-4-report.md).
      ...(check.slackIdentity ? { teamId: check.slackIdentity.teamId, botUserId: check.slackIdentity.botUserId } : {}),
      ...(signingSecret ? { signingSecret: encryptSecret(signingSecret) } : {}),
    }
  }

  const authConfigJson = authConfig as Prisma.InputJsonObject
  const secret = await prisma.integrationSecret.upsert({
    where: { organizationId_provider: { organizationId: auth.organizationId, provider } },
    update: { authType: 'api_key', authConfig: authConfigJson, isActive: true, lastRotatedAt: new Date() },
    create: {
      organizationId: auth.organizationId,
      provider,
      authType: 'api_key',
      authConfig: authConfigJson,
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
