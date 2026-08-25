/**
 * OAuth 2.0 authorization-code flow — STEP 2 (callback).
 *
 * GET /api/mcp-connections/oauth/callback?code=...&state=...
 *
 * 1. Read + decrypt the `bmcp_oauth` cookie set by the start route.
 * 2. Verify the returned `state` matches (CSRF protection).
 * 3. Exchange the authorization code (+ PKCE verifier) for tokens.
 * 4. Persist an McpConnection (authType 'oauth2', flow 'authcode') with all
 *    secrets ENCRYPTED in authConfig.
 * 5. Clear the cookie and redirect back to the MCP servers tab in Integrations.
 *
 * The `organizationId` is taken from the (trusted, encrypted) cookie that was
 * minted in the authenticated start route — the third-party redirect that
 * lands here cannot forge it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import { OAUTH_COOKIE, exchangeCode, safeReturnToPath } from '@/lib/mcp/oauth-authcode'
import { bustBackstoryReadyCache } from '@/lib/mcp/backstory-connection'
import { verifyMcpConfig } from '@/lib/mcp/verify-connection'
import { recordCredentialGrant, recordCredentialRotation, normalizeScopes } from '@/lib/credentials/audit'
import { reviewScopes, scopeViolationMessage } from '@/lib/credentials/scopes'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp } from '@/lib/security/events'

/**
 * Per-IP admission gate. The third-party redirect that lands here is reachable
 * by anyone, and the handler decrypts a cookie, exchanges a code with a remote
 * token endpoint, and writes credential rows. A person finishes this flow a
 * handful of times a day; the cap sits far above that and still ends flooding.
 * Fails closed — an uncapped unauthenticated path into token exchange is worse
 * than a consent click that has to be repeated.
 */
const CALLBACK_LIMIT = { limit: 30, windowMs: 60_000, failureMode: 'closed' } as const

interface OAuthCookiePayload {
  state: string
  codeVerifier: string
  clientId: string
  clientSecret?: string
  tokenEndpoint: string
  serverUrl: string
  name: string
  organizationId: string
  connectionId?: string
  returnTo?: string
  userId?: string
}

function redirect(request: NextRequest, query: string, clearCookie = false) {
  // MCP Servers now lives as a tab inside Integrations.
  const response = NextResponse.redirect(
    new URL(`/integrations?tab=servers&${query}`, request.nextUrl.origin),
  )
  if (clearCookie) {
    response.cookies.set(OAUTH_COOKIE, '', { path: '/', maxAge: 0 })
  }
  return response
}

export async function GET(request: NextRequest) {
  const limited = await rateLimit(`mcp-oauth-callback:${clientIp(request)}`, CALLBACK_LIMIT)
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'retry-after': String(Math.ceil((limited.retryAfterMs ?? 1_000) / 1_000)) } },
    )
  }
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')

  const cookie = request.cookies.get(OAUTH_COOKIE)?.value

  // Parse + validate the encrypted state cookie.
  let payload: OAuthCookiePayload | null = null
  if (cookie) {
    try {
      payload = JSON.parse(decryptSecret(cookie)) as OAuthCookiePayload
    } catch {
      payload = null
    }
  }

  if (!code || !state || !payload || payload.state !== state) {
    return redirect(request, 'error=oauth_state', true)
  }

  const redirectUri = `${request.nextUrl.origin}/api/mcp-connections/oauth/callback`

  try {
    const tokens = await exchangeCode(payload.tokenEndpoint, {
      code,
      redirectUri,
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      codeVerifier: payload.codeVerifier,
    })

    const expiresInS =
      typeof tokens.expires_in === 'number' && tokens.expires_in > 0
        ? tokens.expires_in
        : 3600

    const expiresAt = Date.now() + expiresInS * 1000
    const verification = await verifyMcpConfig({
      serverUrl: payload.serverUrl,
      authType: 'oauth2',
      flow: 'authcode',
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      tokenEndpoint: payload.tokenEndpoint,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt,
    })

    // Absent secrets are OMITTED, not stored as an envelope around the empty
    // string: a PKCE public client has no client_secret and many servers issue
    // no refresh_token, and `hasClientSecret`/`if (!cfg.refreshToken)` all read
    // presence of the KEY. An empty envelope made those checks answer "yes"
    // and every later read decrypt something meaning nothing.
    const authConfig = {
      flow: 'authcode' as const,
      clientId: payload.clientId,
      ...(payload.clientSecret ? { clientSecret: encryptSecret(payload.clientSecret) } : {}),
      tokenEndpoint: payload.tokenEndpoint,
      ...(tokens.refresh_token ? { refreshToken: encryptSecret(tokens.refresh_token) } : {}),
      accessToken: encryptSecret(tokens.access_token),
      expiresAt,
    }

    const grantedScopes = normalizeScopes(tokens.scope) ?? []
    const scopeReview = reviewScopes(payload.name, grantedScopes)
    if (!scopeReview.permitted) {
      // A declared policy is enforced. Thrown rather than stored-and-flagged:
      // once the tokens are persisted the over-scoped access is live, and the
      // point of a declared policy is that this specific integration was
      // examined and this much access decided to be wrong.
      throw new Error(scopeViolationMessage(payload.name, scopeReview))
    }

    if (payload.connectionId) {
      const updated = await prisma.mcpConnection.updateMany({
        where: { id: payload.connectionId, organizationId: payload.organizationId },
        data: {
          authType: 'oauth2',
          authConfig: authConfig as Prisma.InputJsonValue,
          grantedScopes,
          isActive: true,
          lastVerifiedAt: verification.verifiedAt,
        },
      })
      if (updated.count !== 1) throw new Error('Connection to re-authorize was not found')
      if (payload.userId) bustBackstoryReadyCache(payload.organizationId, payload.userId)
      // Re-authorizing an existing connection replaces its tokens: a rotation,
      // not a new grant. Distinguishing the two matters — a burst of rotations
      // on one connection reads very differently from a burst of new grants.
      await recordCredentialRotation({
        organizationId: payload.organizationId,
        kind: 'mcp_connection',
        credentialId: payload.connectionId,
        provider: payload.name,
        ownerUserId: payload.userId ?? null,
        actorUserId: payload.userId ?? null,
        scopes: tokens.scope ?? null,
        method: 'oauth_authcode',
        reason: 'reauthorized',
      })
    } else {
      const created = await prisma.mcpConnection.create({
        data: {
          organizationId: payload.organizationId,
          name: payload.name,
          serverUrl: payload.serverUrl,
          authType: 'oauth2',
          authConfig: authConfig as Prisma.InputJsonValue,
          grantedScopes,
          isActive: true,
          lastVerifiedAt: verification.verifiedAt,
        },
      })
      await recordCredentialGrant({
        organizationId: payload.organizationId,
        kind: 'mcp_connection',
        credentialId: created.id,
        provider: payload.name,
        ownerUserId: created.userId,
        actorUserId: payload.userId ?? null,
        // What the provider actually granted, which can exceed what we asked
        // for — the only place that difference is ever visible.
        scopes: tokens.scope ?? null,
        method: 'oauth_authcode',
      })
    }

    const safeReturnTo = safeReturnToPath(payload.returnTo)
    const successPath = safeReturnTo
      ? `${safeReturnTo}${safeReturnTo.includes('?') ? '&' : '?'}connected=1`
      : '/integrations?tab=servers&connected=1'
    const response = NextResponse.redirect(new URL(successPath, request.nextUrl.origin))
    response.cookies.set(OAUTH_COOKIE, '', { path: '/', maxAge: 0 })
    return response
  } catch (error) {
    // Never log tokens/secrets — only a scrubbed message.
    apiLogger.error('OAuth callback failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    const safeReturnTo = safeReturnToPath(payload?.returnTo)
    if (safeReturnTo) {
      const errorPath = `${safeReturnTo}${safeReturnTo.includes('?') ? '&' : '?'}error=oauth`
      const response = NextResponse.redirect(new URL(errorPath, request.nextUrl.origin))
      response.cookies.set(OAUTH_COOKIE, '', { path: '/', maxAge: 0 })
      return response
    }
    return redirect(request, 'error=oauth', true)
  }
}
