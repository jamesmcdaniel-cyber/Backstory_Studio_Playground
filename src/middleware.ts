import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { isEditionBlockedPath } from '@/lib/edition'

export async function middleware(request: NextRequest) {
  // Refused at the edge, before any session work: in the customer edition the
  // admin surface does not exist. Defence in depth over the layout's notFound()
  // and the internalOnly gate on every route the page calls.
  if (isEditionBlockedPath(request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 404 })
  }
  const nonce = btoa(crypto.randomUUID())
  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`]
  if (process.env.NODE_ENV !== 'production') scriptSrc.push(`'unsafe-eval'`)
  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' https: wss:`,
    `media-src 'self' data: blob:`,
    `worker-src 'self' blob:`,
    `frame-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : []),
  ].join('; ')
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', csp)
  const response = await updateSession(request, requestHeaders)
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|mjs|map|json|txt|woff|woff2|ttf|eot)$).*)',
  ],
}
