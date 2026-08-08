import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAllowedEmail } from '@/lib/auth/allowed-domain'
import { amrMethods, emailDomain, isEnterpriseIdentity } from '@/lib/auth/enterprise-policy'
import { validatedReturnPath } from '@/lib/auth/return-path'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const tokenHash = request.nextUrl.searchParams.get('token_hash')
  const type = request.nextUrl.searchParams.get('type')
  const next = validatedReturnPath(request.nextUrl.searchParams.get('next')) ?? '/dashboard'
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
  if (userError || !(await isAllowedEmail(user?.email))) {
    await supabase.auth.signOut().catch(() => undefined)
    const errorUrl = new URL('/auth/auth-code-error', request.url)
    errorUrl.searchParams.set('reason', userError ? 'session' : 'domain')
    return NextResponse.redirect(errorUrl)
  }

  // SSO enforcement happens HERE, at session creation — not only in the API
  // gate — so a Google sign-in for an SSO-enforced org never becomes a live
  // session that fails on every request. The domain lookup is org-config
  // driven, so it works before the user row is even provisioned.
  const domain = emailDomain(user?.email)
  if (domain) {
    const enforced = await prisma.organizationDomain.findFirst({
      where: { domain, status: 'verified', organization: { ssoEnforced: true } },
      select: { id: true },
    })
    if (enforced) {
      let methods: string[] = []
      try {
        const { data } = await supabase.auth.getClaims()
        methods = amrMethods(data?.claims?.amr)
      } catch {
        // getClaims unavailable — fall back to identity providers below.
      }
      if (methods.length === 0) {
        methods = [
          ...(typeof user?.app_metadata?.provider === 'string' ? [user.app_metadata.provider] : []),
          ...(Array.isArray(user?.app_metadata?.providers) ? user.app_metadata.providers.filter((value): value is string => typeof value === 'string') : []),
        ]
      }
      if (!isEnterpriseIdentity(methods)) {
        await supabase.auth.signOut().catch(() => undefined)
        const loginUrl = new URL('/auth/login', request.url)
        loginUrl.searchParams.set('sso_required', domain)
        if (next !== '/dashboard') loginUrl.searchParams.set('return_to', next)
        return NextResponse.redirect(loginUrl)
      }
    }
  }

  return NextResponse.redirect(new URL(next, request.url))
}
