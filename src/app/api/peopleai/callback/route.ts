import { NextRequest, NextResponse } from 'next/server'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { envOAuthConfig } from '@/lib/peopleai/oauth'
import { completeConnect, OAUTH_COOKIE, TeamMismatchError } from '@/lib/peopleai/connect-service'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { safeReturnToPath } from '@/lib/mcp/oauth-authcode'
import { decryptSecret } from '@/lib/crypto/secrets'

export const runtime = 'nodejs'

function redirectWithStatus(request: NextRequest, returnTo: string, status: string) {
  // Validate again at the sink. The cookie is HttpOnly, but a parent-domain
  // cookie collision or a legacy in-flight value must never become an
  // off-origin redirect.
  const url = new URL(safeReturnToPath(returnTo) ?? '/dashboard', request.nextUrl.origin)
  url.searchParams.set('peopleai', status)
  const response = NextResponse.redirect(url)
  response.cookies.delete(OAUTH_COOKIE)
  return response
}

export async function GET(request: NextRequest) {
  const auth = await getAuthWithUser()
  if (!auth?.dbUser || !auth.organizationId) {
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  const cookie = request.cookies.get(OAUTH_COOKIE)?.value
  let payload: { state: string; verifier: string; returnTo: string; userId: string; organizationId: string } | null = null
  try {
    payload = cookie ? JSON.parse(decryptSecret(cookie)) : null
  } catch {
    payload = null
  }

  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')

  if (
    !payload || !code || !state || state !== payload.state ||
    payload.userId !== auth.dbUser.id || payload.organizationId !== auth.organizationId
  ) {
    return redirectWithStatus(request, '/dashboard', 'state-mismatch')
  }

  const config = envOAuthConfig(`${request.nextUrl.origin}/api/peopleai/callback`)
  if (!config) return redirectWithStatus(request, payload.returnTo, 'unconfigured')

  try {
    await completeConnect({
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
      code,
      verifier: payload.verifier,
      config,
    })
    return redirectWithStatus(request, payload.returnTo, 'connected')
  } catch (error) {
    if (error instanceof TeamMismatchError) {
      return redirectWithStatus(request, payload.returnTo, 'team-mismatch')
    }
    apiLogger.error('People.ai callback failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { path: '/api/peopleai/callback' })
    return redirectWithStatus(request, payload.returnTo, 'error')
  }
}
