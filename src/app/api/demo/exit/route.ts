import { NextResponse } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveDemoOrganization } from '@/lib/demo/session'
import { DEMO_COOKIE } from '@/lib/demo/session'
import { teardownOrganization } from '@/lib/org-teardown'

export const runtime = 'nodejs'

// Exit Demo mode: clear the cookie and delete the sandbox. resolveDemo-
// Organization re-verifies ownership, so a stale or forged cookie can only
// ever tear down the caller's own demo org — or nothing.
export const POST = withAuthenticatedApi(async (_request, auth) => {
  const demoOrgId = await resolveDemoOrganization(auth.dbUser.id)
  if (demoOrgId) await teardownOrganization(demoOrgId)
  const response = NextResponse.json({ success: true })
  response.cookies.set(DEMO_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
  return response
}, { permission: 'flow.read' })
