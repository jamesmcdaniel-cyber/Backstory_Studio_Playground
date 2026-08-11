import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { hashToken } from '@/lib/crypto/secrets'
import { sendEmail } from '@/lib/integrations/email'
import { buildInviteLink } from '@/lib/auth/invite-link'
import { isCustomerEdition } from '@/lib/edition'
import { isPlatformOwnerEmail, OWNER_RESERVED_CODE, OWNER_RESERVED_MESSAGE } from '@/lib/authz/platform-owner'
import { SUPER_ADMIN_PLATFORM_ROLE } from '@/lib/authz/platform-roles'

const INVITE_TTL_DAYS = 14

// Pending (unexpired) invitations for the caller's workspace. Admin-only.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const invitations = await prisma.invitation.findMany({
    where: { organizationId: auth.organizationId, status: 'PENDING', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
  })

  // An unclaimed super-admin grant lives on a separate platform table, so the
  // pending row would otherwise read "Admin" for someone invited as a super
  // admin. Only resolved for a caller who can see that tier at all.
  if (!auth.can('catalogue.review') || invitations.length === 0) {
    return { success: true, invitations }
  }
  const grants = await systemPrisma.platformStaffEmail.findMany({
    where: { email: { in: invitations.map((invitation) => invitation.email) }, claimedAt: null },
    select: { email: true },
  })
  const granted = new Set(grants.map((grant) => grant.email))
  return {
    success: true,
    invitations: invitations.map((invitation) => ({
      ...invitation,
      platformRole: granted.has(invitation.email) ? SUPER_ADMIN_PLATFORM_ROLE : null,
    })),
  }
}, { permission: 'members.manage' })

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  role: z.enum(['ADMIN', 'USER', 'OWNER', 'VIEWER']).default('USER'),
  // Inviting a SUPER ADMIN. The invitation itself only carries a workspace
  // role, so the platform tier travels separately as a grant addressed to the
  // email — claimed when the account is provisioned at first sign-in
  // (src/lib/supabase/auth-utils.ts). Sending it here rather than making the
  // admin repeat the address in a second console is the whole point.
  platformRole: z.literal(SUPER_ADMIN_PLATFORM_ROLE).optional(),
  // Where acceptance lands the recipient. An invite sent from a flow jam passes
  // that flow so joining and arriving are one motion; validated in
  // buildInviteLink, which drops anything that isn't a same-origin path.
  next: z.string().optional(),
})

// Create an invitation, email a join link (if email is configured), and return
// the link so the admin can copy it regardless. Admin-only.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { email, role, next, platformRole } = createSchema.parse(await request.json())

  // OWNER is the platform root tier and only the platform owner identities may
  // hold it — an invite can't mint one for anyone else.
  if (role === 'OWNER' && !isPlatformOwnerEmail(email)) {
    throw new ApiError(OWNER_RESERVED_MESSAGE, 403, OWNER_RESERVED_CODE)
  }

  // Same rule as the member role select: members.manage does not buy the power
  // to mint a super admin, and the customer edition has no such tier.
  if (platformRole) {
    if (isCustomerEdition()) throw new ApiError('Not found', 404, 'NOT_FOUND')
    if (!auth.can('catalogue.review')) {
      throw new ApiError('Only a super admin can invite a super admin.', 403, 'SUPER_ADMIN_REQUIRED')
    }
  }

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

  // platform_staff_emails is a platform table whose RLS policy denies the
  // tenant role outright, so this one write goes through systemPrisma.
  if (platformRole) {
    await systemPrisma.platformStaffEmail.upsert({
      where: { email },
      update: { addedByUserId: auth.dbUser.id, claimedAt: null, claimedByUserId: null },
      create: { email, addedByUserId: auth.dbUser.id },
    })
  }

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
}, { permission: 'members.manage' })

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
