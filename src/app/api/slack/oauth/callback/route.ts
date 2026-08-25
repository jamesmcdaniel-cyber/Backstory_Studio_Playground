/**
 * Slack install — STEP 2 (callback).
 *
 * GET /api/slack/oauth/callback?code=...&state=...
 *
 * Slack is the caller, so there is no session. The ONLY authentication is the
 * encrypted `bslack_oauth` cookie minted by the authenticated start route: it
 * carries the organization this install belongs to, and its `state` must match
 * the query parameter. Everything is refused before the code is exchanged —
 * exchanging first would burn a valid code on a request we are about to reject.
 *
 * Writes the SAME IntegrationSecret shape the paste path writes
 * (POST /api/integrations/credentials/slack), so the events receiver,
 * getSlackToken, findSlackWorkspaceByTeamId and the native-plane reads are all
 * untouched — only acquisition changed, not storage.
 *
 * No signingSecret is written: a platform-owned install verifies against the
 * app-level SLACK_SIGNING_SECRET. Only BYO workspaces store their own.
 */

import type { Prisma } from '@prisma/client'
import { NextResponse, type NextRequest } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { decryptSecret, mergeAuthConfig } from '@/lib/crypto/secrets'
import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'
import { findConflictingSlackOrg } from '@/lib/integrations/slack'
import { SLACK_OAUTH_COOKIE, parseOAuthAccess, stateIsFresh, type SlackOAuthState } from '@/lib/slack/install'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bounce(request: NextRequest, returnTo: string | undefined, query: string) {
  const path = returnTo ?? '/settings'
  const separator = path.includes('?') ? '&' : '?'
  const response = NextResponse.redirect(new URL(`${path}${separator}${query}`, request.nextUrl.origin))
  // One-shot cookie: clear it whichever way this went, so a stale state can
  // never be replayed against a later install.
  response.cookies.delete(SLACK_OAUTH_COOKIE)
  return response
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')

  let payload: SlackOAuthState | null = null
  const cookie = request.cookies.get(SLACK_OAUTH_COOKIE)?.value
  if (cookie) {
    try {
      payload = JSON.parse(decryptSecret(cookie)) as SlackOAuthState
    } catch {
      payload = null
    }
  }

  // Refused BEFORE the exchange, deliberately. Freshness is checked here rather
  // than left to the cookie's maxAge, which only the browser enforces.
  if (
    !code ||
    !state ||
    !payload ||
    payload.state !== state ||
    !payload.organizationId ||
    !stateIsFresh(payload.issuedAt)
  ) {
    return bounce(request, payload?.returnTo, 'error=slack_oauth_state')
  }

  const clientId = process.env.SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return bounce(request, payload.returnTo, 'error=slack_not_configured')
  }

  try {
    const exchange = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${request.nextUrl.origin}/api/slack/oauth/callback`,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    // Slack answers 200 even for a rejected exchange — the body's `ok` is the
    // real result, which is what parseOAuthAccess reads.
    const installed = parseOAuthAccess(await exchange.json().catch(() => null))
    if (!installed) {
      return bounce(request, payload.returnTo, 'error=slack_oauth_exchange')
    }

    // With one shared app, two organizations installing into the SAME Slack
    // workspace is a realistic mistake rather than a theoretical one, and the
    // failure mode is every delivery misrouted with no error and no trail.
    const conflict = await findConflictingSlackOrg(installed.teamId, payload.organizationId)
    if (conflict) {
      await recordAudit({
        organizationId: payload.organizationId,
        action: 'credential.rejected',
        actorUserId: payload.userId,
        resourceType: 'integration_secret',
        resourceId: `slack:${installed.teamId}`,
        detail: { provider: 'slack', reason: 'team_id_already_connected', teamId: installed.teamId, via: 'install' },
      })
      return bounce(request, payload.returnTo, 'error=slack_team_taken')
    }

    // systemPrisma: the caller is Slack, so there is no tenant context to scope
    // by — the organization comes from the verified state cookie above.
    const existing = await systemPrisma.integrationSecret.findUnique({
      where: { organizationId_provider: { organizationId: payload.organizationId, provider: 'slack' } },
      select: { authConfig: true },
    })
    const existingConfig =
      existing?.authConfig && typeof existing.authConfig === 'object' && !Array.isArray(existing.authConfig)
        ? (existing.authConfig as Record<string, unknown>)
        : {}

    // mergeAuthConfig encrypts apiKey itself — do not pre-encrypt. Merging (not
    // replacing) preserves a BYO workspace's own signingSecret if it has one,
    // so switching to the platform app never strips its ability to verify.
    const authConfig = {
      ...(mergeAuthConfig(existingConfig, { authType: 'api_key', apiKey: installed.botToken }) as Record<string, unknown>),
      teamId: installed.teamId,
      botUserId: installed.botUserId,
    } as Prisma.InputJsonObject

    await systemPrisma.integrationSecret.upsert({
      where: { organizationId_provider: { organizationId: payload.organizationId, provider: 'slack' } },
      update: { authType: 'api_key', authConfig, isActive: true, lastRotatedAt: new Date() },
      create: { organizationId: payload.organizationId, provider: 'slack', authType: 'api_key', authConfig, isActive: true },
    })

    await recordAudit({
      organizationId: payload.organizationId,
      action: 'credential.granted',
      actorUserId: payload.userId,
      resourceType: 'integration_secret',
      resourceId: `slack:${installed.teamId}`,
      detail: { provider: 'slack', teamId: installed.teamId, via: 'install' },
    })

    return bounce(request, payload.returnTo, 'slack=installed')
  } catch (error) {
    apiLogger.error('slack install callback failed', {
      organizationId: payload.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return bounce(request, payload.returnTo, 'error=slack_oauth_failed')
  }
}
