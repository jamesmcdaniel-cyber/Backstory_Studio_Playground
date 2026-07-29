/**
 * OAuth 2.0 authorization-code flow — STEP 1 (start).
 *
 * GET /api/mcp-connections/oauth/start?serverUrl=...&name=...
 *
 * 1. Discover the MCP server's OAuth metadata.
 * 2. Dynamically register a public client (DCR) for our callback redirect URI.
 * 3. Generate PKCE (S256) + a random CSRF `state`.
 * 4. Store everything we need for the callback in an ENCRYPTED, httpOnly,
 *    Secure, SameSite=Lax cookie (`bmcp_oauth`).
 * 5. Redirect the browser to the server's authorization endpoint (Okta SSO).
 *
 * Returns a real redirect Response so the browser follows the OAuth dance.
 */

import { NextResponse } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { encryptSecret } from '@/lib/crypto/secrets'
import { prisma } from '@/lib/prisma'
import {
  OAUTH_COOKIE,
  buildAuthorizeUrl,
  discoverAuthServer,
  generatePkce,
  generateState,
  registerClient,
  safeReturnToPath,
} from '@/lib/mcp/oauth-authcode'

const COOKIE_MAX_AGE_S = 600 // 10 minutes to complete the login

export const GET = withAuthenticatedApi(async (request, auth) => {
  const serverUrl = request.nextUrl.searchParams.get('serverUrl')?.trim()
  const name = request.nextUrl.searchParams.get('name')?.trim()
  const connectionId = request.nextUrl.searchParams.get('connectionId')?.trim() || undefined
  const returnToRaw = request.nextUrl.searchParams.get('returnTo')?.trim() || undefined
  // Same-origin paths only — never an absolute URL.
  const returnTo = safeReturnToPath(returnToRaw)
  const errorRedirect = (code: string) => {
    const path = returnTo ?? '/integrations?tab=servers'
    const separator = path.includes('?') ? '&' : '?'
    return NextResponse.redirect(new URL(`${path}${separator}error=${code}`, request.nextUrl.origin))
  }
  const scope = request.nextUrl.searchParams.get('scope')?.trim() || 'claudeai'

  let effectiveServerUrl = serverUrl
  let effectiveName = name
  if (connectionId) {
    const row = await prisma.mcpConnection.findFirst({
      where: { id: connectionId, organizationId: auth.organizationId },
      select: { id: true, serverUrl: true, name: true, userId: true },
    })
    // Personal rows may only be re-authorized by their owner.
    if (!row || (row.userId && row.userId !== auth.dbUser.id)) {
      return errorRedirect('oauth_params')
    }
    effectiveServerUrl = row.serverUrl
    effectiveName = row.name
  }

  if (!effectiveServerUrl || !effectiveName) {
    return errorRedirect('oauth_params')
  }

  // Validate the URL up front so a bad value can't blow up discovery.
  try {
    void new URL(effectiveServerUrl)
  } catch {
    return errorRedirect('oauth_params')
  }

  const redirectUri = `${request.nextUrl.origin}/api/mcp-connections/oauth/callback`

  try {
    const meta = await discoverAuthServer(effectiveServerUrl)
    if (!meta.registration_endpoint) {
      throw new Error('OAuth server does not advertise a registration_endpoint')
    }

    const { client_id, client_secret } = await registerClient(
      meta.registration_endpoint,
      redirectUri,
    )

    const { verifier, challenge } = generatePkce()
    const state = generateState()

    const authorizeUrl = buildAuthorizeUrl(meta.authorization_endpoint, {
      clientId: client_id,
      redirectUri,
      state,
      codeChallenge: challenge,
      scope,
    })

    // Everything the callback needs, sealed in an encrypted cookie.
    const cookieValue = encryptSecret(
      JSON.stringify({
        state,
        codeVerifier: verifier,
        clientId: client_id,
        clientSecret: client_secret,
        tokenEndpoint: meta.token_endpoint,
        serverUrl: effectiveServerUrl,
        name: effectiveName,
        organizationId: auth.organizationId,
        connectionId,
        returnTo,
        userId: auth.dbUser.id,
      }),
    )

    const response = NextResponse.redirect(authorizeUrl)
    response.cookies.set(OAUTH_COOKIE, cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE_S,
    })
    return response
  } catch {
    // Do not leak discovery/registration details to the client.
    return errorRedirect('oauth_start')
  }
}, { skipBackstoryGate: true, permission: 'integration.manage' })
