import { NextResponse } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { ensureDemoWorkspace } from '@/lib/demo/snapshot'
import { DEMO_COOKIE } from '@/lib/demo/session'

export const runtime = 'nodejs'

// Enter Demo mode: ensure this user's sandbox exists (cloning the workspace on
// first entry, reusing it after), then hand the browser the session cookie.
// The clone source is dbUser.organizationId — the REAL workspace — never
// auth.organizationId, which is already the sandbox when a session is active.
export const POST = withAuthenticatedApi(async (_request, auth) => {
  const realOrgId = auth.dbUser.organizationId
  if (!realOrgId) return NextResponse.json({ success: false, error: 'No workspace' }, { status: 400 })
  const { demoOrgId } = await ensureDemoWorkspace(realOrgId, auth.dbUser.id)
  const response = NextResponse.json({ success: true, demoOrgId })
  response.cookies.set(DEMO_COOKIE, demoOrgId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })
  return response
// Baseline member permission: every role holds flow.read, and demo mode
// mirrors exactly the access the caller already has in the real workspace.
}, { permission: 'flow.read' })
