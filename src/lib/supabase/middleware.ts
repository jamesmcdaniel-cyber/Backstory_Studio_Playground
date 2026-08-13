import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getSupabaseConfig, SUPABASE_COOKIE_OPTIONS } from './config'
import { validatedReturnPath } from '@/lib/auth/return-path'

const publicPages = new Set([
  '/',
  '/auth',
  '/auth/login',
  '/auth/signin',
  '/auth/signup',
  '/auth/callback',
  '/auth/auth-code-error',
  '/auth/mfa',
  '/privacy',
  '/terms',
])

function copyCookies(source: NextResponse, target: NextResponse) {
  source.cookies.getAll().forEach((cookie) => target.cookies.set(cookie))
  return target
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })
  const pathname = request.nextUrl.pathname
  const isApi = pathname.startsWith('/api/')

  // API routes authenticate themselves (withAuthenticatedApi → getUser), and a
  // route handler CAN persist a refreshed session cookie (cookies().set works
  // there) — so running getUser() here too was a fully redundant second
  // Supabase Auth network round-trip on EVERY API call. Skip it: middleware
  // auth is only for page navigations (login redirects + session refresh).
  if (isApi) return response

  const { url, anonKey } = getSupabaseConfig()
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookies) {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })

  const { data: { user } } = await supabase.auth.getUser()
  const isAuthPage = pathname.startsWith('/auth/')
  // Invite pages must be viewable signed-out so a recipient can see who invited
  // them and choose to sign in or create an account. `/share/` is the anonymous
  // read-only surface: the token in the path IS the credential, the page serves
  // a sanitized projection, and bouncing it to /auth/login would defeat the
  // entire point of an anonymous link.
  const isPublic =
    publicPages.has(pathname) || pathname.startsWith('/invite/') || pathname.startsWith('/share/')

  // Production is SSO/invite-only: password signup is disabled unless
  // explicitly allowed (AUTH_ALLOW_PASSWORD=true keeps it for dev). The
  // invitee's deep link MUST survive this bounce — clearing the search string
  // here is what dropped invited people into a fresh solo workspace instead of
  // the workspace (and flow) they were invited to.
  //
  // Compared against 'true', not against 'false': the old check only closed the
  // page when the variable was set to the exact string 'false', so an UNSET
  // variable — the default everywhere — left it open, inverting the sentence
  // above. This is defence in depth either way; the page is not the boundary,
  // since Supabase's token endpoint is reachable directly with the public anon
  // key. resolveAuthUser is what actually refuses a non-allowlisted identity.
  if (pathname === '/auth/signup' && process.env.AUTH_ALLOW_PASSWORD !== 'true') {
    const carried = validatedReturnPath(request.nextUrl.searchParams.get('return_to'))
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.search = ''
    if (carried) url.searchParams.set('return_to', carried)
    return copyCookies(response, NextResponse.redirect(url))
  }

  if (!user && !isApi && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.search = ''
    url.searchParams.set('return_to', `${pathname}${request.nextUrl.search}`)
    return copyCookies(response, NextResponse.redirect(url))
  }

  // A signed-in user on an auth page goes where they were headed, not to a
  // blanket /dashboard — an invite or share link opened in an already-signed-in
  // browser used to lose its destination here.
  //
  // /auth/update-password is exempt for the same reason /auth/callback is: a
  // password recovery link deliberately lands there WITH a session (that is what
  // the recovery token buys), so bouncing signed-in users would make the reset
  // link a redirect to the dashboard and the password would never get changed.
  if (
    user &&
    isAuthPage &&
    pathname !== '/auth/callback' &&
    pathname !== '/auth/mfa' &&
    pathname !== '/auth/update-password'
  ) {
    const carried = validatedReturnPath(request.nextUrl.searchParams.get('return_to'))
    return copyCookies(response, NextResponse.redirect(new URL(carried ?? '/dashboard', request.url)))
  }

  // Authenticated pages must not be cached by the browser (disk / back-forward
  // cache), so a signed-out "Back" can't restore a protected view. The client
  // pageshow guard covers browsers that bfcache no-store pages anyway.
  // A /share/ page is anonymous but still per-token content that may be turned
  // off at any moment, so it stays uncached alongside the authenticated pages.
  if (!publicPages.has(pathname)) {
    response.headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate')
  }

  return response
}
