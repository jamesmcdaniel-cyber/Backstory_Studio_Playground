import { NextRequest, NextResponse } from 'next/server'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { envOAuthConfig } from '@/lib/peopleai/oauth'
import { completeConnect, OAUTH_COOKIE, TeamMismatchError } from '@/lib/peopleai/connect-service'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { safeReturnToPath } from '@/lib/mcp/oauth-authcode'
import { decryptSecret } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp } from '@/lib/security/events'

export const runtime = 'nodejs'

/**
 * Per-IP admission gate. OAuth redirect targets are addressable by anyone who
 * knows the URL — the caller here has not proved anything yet, and the handler
 * goes on to decrypt a cookie, hit the database, and make an outbound token
 * exchange. A real person completes this flow a handful of times a day, so the
 * cap is far above legitimate use and still ends replay/flood attempts.
 *
 * Fails closed: a retried consent click is a mild annoyance; an uncapped
 * unauthenticated path into token exchange is not.
 */
const CALLBACK_LIMIT = { limit: 30, windowMs: 60_000, failureMode: 'closed' } as const

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
  const limited = await rateLimit(`peopleai-callback:${clientIp(request)}`, CALLBACK_LIMIT)
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'retry-after': String(Math.ceil((limited.retryAfterMs ?? 1_000) / 1_000)) } },
    )
  }
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
