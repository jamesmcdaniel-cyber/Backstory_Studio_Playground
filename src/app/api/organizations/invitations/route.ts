import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { hashToken } from '@/lib/crypto/secrets'
import { sendEmail } from '@/lib/integrations/email'
import { buildInviteLink } from '@/lib/auth/invite-link'

const INVITE_TTL_DAYS = 14

// Pending (unexpired) invitations for the caller's workspace. Admin-only.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const invitations = await prisma.invitation.findMany({
    where: { organizationId: auth.organizationId, status: 'PENDING', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
  })
  return { success: true, invitations }
})

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  role: z.enum(['ADMIN', 'USER']).default('USER'),
  // Where acceptance lands the recipient. An invite sent from a flow jam passes
  // that flow so joining and arriving are one motion; validated in
  // buildInviteLink, which drops anything that isn't a same-origin path.
  next: z.string().optional(),
})

// Create an invitation, email a join link (if email is configured), and return
// the link so the admin can copy it regardless. Admin-only.
export const POST = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const { email, role, next } = createSchema.parse(await request.json())

  // Already a member of this workspace? No invite needed.
  const existing = await prisma.user.findFirst({
    where: { email, organizationId: auth.organizationId, isActive: true },
    select: { id: true },
  })
  if (existing) throw new ApiError('That person is already in your workspace.', 400, 'ALREADY_MEMBER')

  // One live invite per email per org — refresh it rather than pile up.
  await prisma.invitation.updateMany({
    where: { organizationId: auth.organizationId, email, status: 'PENDING' },
    data: { status: 'REVOKED' },
  })

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)
  const invitation = await prisma.invitation.create({
    data: {
      email,
      role,
      organizationId: auth.organizationId,
      tokenHash: hashToken(token),
      invitedById: auth.dbUser.id,
      expiresAt,
    },
    select: { id: true, email: true, role: true, expiresAt: true },
  })

  const org = await prisma.organization.findUnique({ where: { id: auth.organizationId }, select: { name: true } })
  const base = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, '')
  const link = buildInviteLink(base, token, next)

  let emailSent = false
  try {
    emailSent = await sendEmail({
      to: email,
      subject: `You're invited to ${org?.name ?? 'a workspace'} on Backstory`,
      html: `<p>${auth.dbUser.name ? escapeHtml(auth.dbUser.name) : 'A teammate'} invited you to join <strong>${escapeHtml(org?.name ?? 'their workspace')}</strong> on Backstory.</p>
<p><a href="${link}">Accept the invitation</a></p>
<p style="color:#6b7280;font-size:12px">This link expires in ${INVITE_TTL_DAYS} days. If you didn't expect this, you can ignore it.</p>`,
    })
  } catch {
    // Email delivery failed — the invite still exists and the link is returned,
    // so the admin can share it manually.
    emailSent = false
  }

  return { success: true, invitation, link, emailSent }
})

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
