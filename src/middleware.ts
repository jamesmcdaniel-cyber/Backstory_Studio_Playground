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
  return updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|mjs|map|json|txt|woff|woff2|ttf|eot)$).*)',
  ],
}
