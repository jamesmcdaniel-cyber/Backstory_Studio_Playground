import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { isEditionBlockedPath } from '@/lib/edition'
import { buildContentSecurityPolicy, cspHeaderName, generateNonce } from '@/lib/security/csp'

export async function middleware(request: NextRequest) {
  // Refused at the edge, before any session work: in the customer edition the
  // admin surface does not exist. Defence in depth over the layout's notFound()
  // and the internalOnly gate on every route the page calls.
  if (isEditionBlockedPath(request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 404 })
  }

  // The CSP nonce is minted here because it must be per-response, and the
  // policy has to reach BOTH sides: on the request headers so the App Router
  // stamps it onto Next's own script tags while rendering, and on the response
  // headers so the browser enforces it. Setting only the response header would
  // produce a policy that blocks Next's own bootstrap.
  const nonce = generateNonce()
  const policy = buildContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV !== 'production',
  })
  const headerName = cspHeaderName()

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  // Next reads the nonce out of this request header. It is always the enforcing
  // name even in report-only mode: this copy is an instruction to the renderer,
  // not a policy sent to the browser.
  requestHeaders.set('Content-Security-Policy', policy)

  const response = await updateSession(request, requestHeaders)
  response.headers.set(headerName, policy)
  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|mjs|map|json|txt|woff|woff2|ttf|eot)$).*)',
  ],
}
