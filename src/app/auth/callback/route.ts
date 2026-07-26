import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isCompanyEmail } from '@/lib/auth/company-domain'

function safeNext(value: string | null) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/dashboard'
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const tokenHash = request.nextUrl.searchParams.get('token_hash')
  const type = request.nextUrl.searchParams.get('type')
  const next = safeNext(request.nextUrl.searchParams.get('next'))
  const supabase = await createClient()

  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as any })
      : { error: new Error('Missing auth code') }

  if (result.error) {
    return NextResponse.redirect(new URL('/auth/auth-code-error', request.url))
  }

  // Google can suggest a hosted domain but that query parameter is not an
  // authorization boundary. Enforce the company allow-list after the provider
  // has returned the verified email and before allowing the session into the
  // application.
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !isCompanyEmail(user?.email)) {
    await supabase.auth.signOut().catch(() => undefined)
    const errorUrl = new URL('/auth/auth-code-error', request.url)
    errorUrl.searchParams.set('reason', userError ? 'session' : 'domain')
    return NextResponse.redirect(errorUrl)
  }

  return NextResponse.redirect(new URL(next, request.url))
}
