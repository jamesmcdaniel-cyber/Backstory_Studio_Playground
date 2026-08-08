import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { emailDomain } from '@/lib/auth/enterprise-policy'

// Sessions that predate SSO enforcement (or slipped past it) start getting 403
// SSO_REQUIRED from every API. The SetupGate sends the browser here: end the
// stale session server-side so the login screen doesn't bounce the user
// straight back in, then land there with the SSO form primed for their domain.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  const domain = emailDomain(data?.user?.email)
  await supabase.auth.signOut().catch(() => undefined)
  const loginUrl = new URL('/auth/login', request.url)
  loginUrl.searchParams.set('sso_required', domain ?? '1')
  return NextResponse.redirect(loginUrl)
}
