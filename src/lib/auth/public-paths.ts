/**
 * The pages anyone may open signed out. The request-path gate
 * (src/lib/supabase/middleware.ts) and the browser's signed-out guard
 * (SupabaseProvider) both read this one list: when they kept their own, the
 * guard missed /share/ and sent a visitor on a public link to sign in as soon
 * as their tab came back into view.
 */
export const PUBLIC_PAGES = new Set([
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

/**
 * Invite pages must be viewable signed-out so a recipient can see who invited
 * them and choose to sign in or create an account. `/share/` is the anonymous
 * surface: the token in the path IS the credential, the page serves a
 * sanitized projection, and bouncing it to /auth/login would defeat the entire
 * point of an anonymous link.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PAGES.has(pathname) ||
    pathname.startsWith('/invite/') ||
    pathname.startsWith('/share/') ||
    pathname.startsWith('/forms/')
  )
}

/** Whether the browser should send someone with no session to sign in from
 *  this page. The auth pages manage their own sessions. */
export function guardsSignedOut(pathname: string): boolean {
  return !isPublicPath(pathname) && !pathname.startsWith('/auth/')
}
