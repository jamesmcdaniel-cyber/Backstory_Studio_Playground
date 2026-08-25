/**
 * Slack install — STEP 1.
 *
 * GET /api/slack/install?returnTo=/settings
 *
 * Redirects to Slack's consent screen for Backstory's OWN app, carrying a
 * random `state` that is also stored in an encrypted, httpOnly cookie bound to
 * the requesting organization and user. The callback trusts nothing but that
 * cookie — see its file comment.
 *
 * Mirrors src/app/api/mcp-connections/oauth/start/route.ts, which does the same
 * dance for MCP servers.
 */

import { NextResponse } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { encryptSecret } from '@/lib/crypto/secrets'
import { generateState, safeReturnToPath } from '@/lib/mcp/oauth-authcode'
import {
  SLACK_OAUTH_COOKIE,
  SLACK_STATE_MAX_AGE_MS,
  buildSlackAuthorizeUrl,
  type SlackOAuthState,
} from '@/lib/slack/install'

export const runtime = 'nodejs'

/**
 * Ten minutes to finish consenting, matching the MCP flow's window. The cookie
 * maxAge is the browser's copy of this; SLACK_STATE_MAX_AGE_MS in the payload is
 * the authoritative one, checked by the callback.
 */
const COOKIE_MAX_AGE_S = SLACK_STATE_MAX_AGE_MS / 1000

export const GET = withAuthenticatedApi(async (request, auth) => {
  const returnTo = safeReturnToPath(request.nextUrl.searchParams.get('returnTo')?.trim() || undefined)
  const fallback = returnTo ?? '/settings'

  const clientId = process.env.SLACK_CLIENT_ID
  if (!clientId || !process.env.SLACK_CLIENT_SECRET) {
    // Misconfiguration, not user error — say so on the page they came from
    // rather than redirecting them into Slack for a guaranteed failure.
    const separator = fallback.includes('?') ? '&' : '?'
    return NextResponse.redirect(new URL(`${fallback}${separator}error=slack_not_configured`, request.nextUrl.origin))
  }

  const state = generateState()
  const payload: SlackOAuthState = {
    state,
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    issuedAt: Date.now(),
    ...(returnTo ? { returnTo } : {}),
  }

  const response = NextResponse.redirect(
    buildSlackAuthorizeUrl({
      clientId,
      redirectUri: `${request.nextUrl.origin}/api/slack/oauth/callback`,
      state,
    }),
  )
  response.cookies.set(SLACK_OAUTH_COOKIE, encryptSecret(JSON.stringify(payload)), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
  })
  return response
}, { permission: 'integration.manage' })
