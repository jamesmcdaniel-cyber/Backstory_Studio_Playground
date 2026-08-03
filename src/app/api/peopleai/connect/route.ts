import { NextRequest, NextResponse } from 'next/server'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { envOAuthConfig } from '@/lib/peopleai/oauth'
import { disconnect, startConnect, OAUTH_COOKIE } from '@/lib/peopleai/connect-service'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { safeReturnToPath } from '@/lib/mcp/oauth-authcode'
import { encryptSecret } from '@/lib/crypto/secrets'

export const runtime = 'nodejs'

/**
 * Starts the People.ai MCP OAuth flow: PKCE + state go into a short-lived
 * HttpOnly cookie, the browser goes to mcp.people.ai/authorize (which hands
 * sign-in to Glass → Salesforce), and the callback route completes the link.
 * Deliberately usable by unentitled users — this IS the way in.
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthWithUser()
  if (!auth?.dbUser || !auth.organizationId) {
    return NextResponse.redirect(new URL('/auth/login?return_to=/api/peopleai/connect', request.url))
  }

  const origin = request.nextUrl.origin
  const config = envOAuthConfig(`${origin}/api/peopleai/callback`)
  if (!config) {
    return NextResponse.json(
      { success: false, error: 'People.ai OAuth is not configured for this environment.', code: 'PEOPLE_AI_UNCONFIGURED' },
      { status: 503 },
    )
  }

  const returnTo = safeReturnToPath(request.nextUrl.searchParams.get('return_to')) ?? '/dashboard'
  const { authorizeUrl, statePayload } = await startConnect(config, returnTo)

  const response = NextResponse.redirect(authorizeUrl)
  response.cookies.set(OAUTH_COOKIE, encryptSecret(JSON.stringify({
    ...statePayload,
    userId: auth.dbUser.id,
    organizationId: auth.organizationId,
  })), {
    httpOnly: true,
    secure: origin.startsWith('https'),
    sameSite: 'lax',
    maxAge: 600,
    path: '/api/peopleai',
  })
  return response
}

/** Disconnect the caller's People.ai account from this workspace. */
export const DELETE = withAuthenticatedApi(async (_request, auth) => {
  await disconnect(auth.dbUser.id, auth.organizationId)
  return { success: true }
}, { skipBackstoryGate: true, permission: 'integration.manage' })
