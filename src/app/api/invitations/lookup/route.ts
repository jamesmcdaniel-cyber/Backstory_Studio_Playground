import { NextResponse, type NextRequest } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'

// Public (unauthenticated) preview of an invitation by token, so the /invite
// page can greet the recipient with the workspace name before they sign in.
// Reveals only the org name, invited email, and role — nothing more.
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token || token.length > 256) return NextResponse.json({ valid: false }, { status: 400 })
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const limited = await rateLimit(`invite-lookup:${ip}`, { limit: 60, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) return NextResponse.json({ valid: false }, { status: 429 })
  try {
    // systemPrisma: the untrusted token is the pre-auth capability. There is no
    // tenant context until it resolves, and the response exposes only the
    // invitation's deliberately public preview fields.
    const invite = await systemPrisma.invitation.findFirst({
      where: { tokenHash: hashToken(token), status: 'PENDING', expiresAt: { gt: new Date() } },
      select: { email: true, role: true, organization: { select: { name: true } } },
    })
    if (!invite) return NextResponse.json({ valid: false })
    return NextResponse.json({
      valid: true,
      email: invite.email,
      role: invite.role,
      organizationName: invite.organization?.name ?? 'a workspace',
    })
  } catch {
    return NextResponse.json({ valid: false }, { status: 500 })
  }
}
