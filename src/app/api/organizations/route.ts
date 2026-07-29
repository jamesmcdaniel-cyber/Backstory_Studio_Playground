import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

// Organizations the user belongs to. Membership is single-org today; the
// shape is a list so the org switcher works unchanged when multi-org lands.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { id: true, name: true, slug: true, plan: true, logoUrl: true },
  })
  return {
    success: true,
    activeOrganizationId: auth.organizationId,
    organizations: organization ? [organization] : [],
  }
}, { permission: 'flow.read' })

// Workspace logo: a small image data URL (the client resizes to 128px before
// uploading), stored inline so no external object storage is needed.
const LOGO_MAX_LENGTH = 300_000 // ~220KB of image data once base64-encoded
const patchSchema = z.object({
  logoUrl: z
    .string()
    .max(LOGO_MAX_LENGTH, 'Image is too large — please use a smaller file.')
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Unsupported image format.')
    .nullable()
    .optional(),
  name: z.string().trim().min(1, 'Workspace name is required.').max(80, 'Workspace name is too long.').optional(),
}).refine((body) => body.logoUrl !== undefined || body.name !== undefined, {
  message: 'Nothing to update.',
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const body = patchSchema.parse(await request.json())
  const data: { logoUrl?: string | null; name?: string } = {}
  if (body.logoUrl !== undefined) data.logoUrl = body.logoUrl
  if (body.name !== undefined) data.name = body.name
  const organization = await prisma.organization.update({
    where: { id: auth.organizationId },
    data,
    select: { id: true, name: true, slug: true, plan: true, logoUrl: true },
  })
  return { success: true, organization }
}, { permission: 'org.manage' })
