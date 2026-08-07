/**
 * People.ai connect flow — service layer under /api/peopleai/connect and
 * /api/peopleai/callback. Thin routes handle the HTTP/cookie mechanics; this
 * module owns state, token exchange, identity extraction, persistence, and
 * the org=team binding.
 */

import crypto from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'
import { encryptSecret } from '@/lib/crypto/secrets'
import { revalidateEntitlement } from '@/lib/entitlement'
import { captureError } from '@/lib/observability/sentry'
import { ensureOrgWebhookSecret } from './webhook-secret'
import {
  buildAuthorizeUrl,
  discoverMetadata,
  exchangeCode,
  generatePkce,
  type PeopleAiOAuthConfig,
  type TokenSet,
} from './oauth'

/** Short-lived HttpOnly cookie carrying state + PKCE verifier across the redirect. */
export const OAUTH_COOKIE = 'pai_oauth'

export interface ConnectStart {
  authorizeUrl: string
  /** Serialize into a short-lived HttpOnly cookie; verified on callback. */
  statePayload: { state: string; verifier: string; returnTo: string }
}

export async function startConnect(
  config: PeopleAiOAuthConfig,
  returnTo: string,
): Promise<ConnectStart> {
  const { verifier, challenge } = generatePkce()
  const state = crypto.randomBytes(24).toString('base64url')
  const metadata = await discoverMetadata(config)
  const authorizeUrl = buildAuthorizeUrl(config, {
    authorizationEndpoint: metadata.authorizationEndpoint,
    state,
    codeChallenge: challenge,
  })
  return { authorizeUrl, statePayload: { state, verifier, returnTo } }
}

// ── Identity extraction ─────────────────────────────────────────────────────

export interface PeopleAiIdentity {
  teamId: string | null
  membershipId: string | null
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  // mcp_* tokens are documented as JWTs; tolerate an mcp_ prefix before the
  // JWT body and any non-JWT shape (return null rather than throw).
  const candidate = token.startsWith('mcp_') ? token.slice(4) : token
  const parts = candidate.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function firstString(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number') return String(value)
  }
  return null
}

/**
 * Extract team/membership identity from the token exchange response: explicit
 * response fields first, then JWT claims. SEAM: if People.ai's real token
 * shape differs, adjust the key lists here — callers only see the two ids.
 */
export function extractIdentity(tokens: TokenSet): PeopleAiIdentity {
  const raw = tokens.raw
  const claims = decodeJwtClaims(tokens.accessToken)
  const teamId =
    firstString(raw, ['team_id', 'org_id', 'organization_id']) ??
    firstString(claims, ['team_id', 'org_id', 'organization_id'])
  const membershipId =
    firstString(raw, ['membership_id', 'user_id']) ??
    firstString(claims, ['membership_id', 'user_id', 'sub'])
  return { teamId, membershipId }
}

// ── Callback completion ─────────────────────────────────────────────────────

export class TeamMismatchError extends Error {
  constructor() {
    super('This workspace is already linked to a different People.ai team.')
    this.name = 'TeamMismatchError'
  }
}

export interface CompleteConnectInput {
  userId: string
  organizationId: string
  code: string
  verifier: string
  config: PeopleAiOAuthConfig
  /** Injectable for tests; defaults to the real token exchange. */
  exchanger?: (config: PeopleAiOAuthConfig, params: { tokenEndpoint: string; code: string; codeVerifier: string }) => Promise<TokenSet>
}

export async function completeConnect(input: CompleteConnectInput): Promise<PeopleAiIdentity> {
  const exchanger = input.exchanger ?? exchangeCode
  const metadata = await discoverMetadata(input.config)
  const tokens = await exchanger(input.config, {
    tokenEndpoint: metadata.tokenEndpoint,
    code: input.code,
    codeVerifier: input.verifier,
  })

  const identity = extractIdentity(tokens)

  // Org = People.ai team. Three cases when the token carries a team id:
  //  1. The team already has a workspace and it's this one → nothing to do.
  //  2. The team already has a workspace elsewhere → the connecting user
  //     JOINS it (their fresh solo landing org is deleted when empty). This
  //     is how "every rep from a customer shares one workspace" happens.
  //  3. No workspace has this team yet → bind the current one (first
  //     connector claims it), unless it's already bound to a different team.
  let organizationId = input.organizationId
  if (identity.teamId) {
    const [teamOrg, currentOrg] = await Promise.all([
      prisma.organization.findUnique({ where: { peopleAiTeamId: identity.teamId }, select: { id: true } }),
      prisma.organization.findUnique({ where: { id: input.organizationId }, select: { peopleAiTeamId: true } }),
    ])

    const currentBoundElsewhere = Boolean(
      currentOrg?.peopleAiTeamId && currentOrg.peopleAiTeamId !== identity.teamId,
    )

    if (teamOrg && teamOrg.id !== input.organizationId) {
      if (currentBoundElsewhere) throw new TeamMismatchError()
      const memberCount = await prisma.user.count({ where: { organizationId: input.organizationId } })
      if (memberCount > 1) throw new TeamMismatchError()

      // Join the team workspace as a regular member — except the platform
      // owner, whose OWNER role is immutable (the users-table trigger would
      // reject the demotion and fail the whole connect).
      const joiner = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true } })
      await prisma.user.update({
        where: { id: input.userId },
        data: { organizationId: teamOrg.id, role: isPlatformOwnerEmail(joiner?.email) ? 'OWNER' : 'USER' },
      })
      organizationId = teamOrg.id

      // The abandoned solo landing org is deleted when it holds nothing.
      const agentCount = await prisma.agentTask.count({ where: { organizationId: input.organizationId } })
      if (agentCount === 0) {
        // Full teardown, not a bare row delete: the solo org may still hold
        // connections/flows whose external resources would otherwise leak.
        const { teardownOrganization } = await import('@/lib/org-teardown')
        await teardownOrganization(input.organizationId).catch(() => undefined)
      }
    } else if (!teamOrg) {
      if (currentBoundElsewhere) throw new TeamMismatchError()
      if (!currentOrg?.peopleAiTeamId) {
        await prisma.organization.update({
          where: { id: input.organizationId },
          data: { peopleAiTeamId: identity.teamId },
        })
      }
    }
  }

  // Best-effort: give the org its per-tenant webhook signing secret as soon
  // as its team binding exists. Failure must not break connect — the
  // receiver falls back to the global secret until a secret is minted.
  try {
    await ensureOrgWebhookSecret(organizationId)
  } catch (error) {
    captureError(error, { source: 'peopleai.connect.webhookSecret', organizationId })
  }

  await prisma.peopleAiConnection.upsert({
    where: { organizationId_userId: { organizationId, userId: input.userId } },
    create: {
      organizationId,
      userId: input.userId,
      teamId: identity.teamId,
      membershipId: identity.membershipId,
      scope: input.config.scope ?? null,
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      status: 'active',
      lastVerifiedAt: new Date(),
    },
    update: {
      teamId: identity.teamId,
      membershipId: identity.membershipId,
      scope: input.config.scope ?? null,
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      status: 'active',
      lastVerifiedAt: new Date(),
    },
  })

  if (identity.membershipId) {
    await prisma.user.update({
      where: { id: input.userId },
      data: { peopleAiMembershipId: identity.membershipId },
    })
  }

  await revalidateEntitlement(organizationId)
  return identity
}

export async function disconnect(userId: string, organizationId: string): Promise<void> {
  await prisma.peopleAiConnection.deleteMany({ where: { organizationId, userId } })
  await revalidateEntitlement(organizationId)
}
