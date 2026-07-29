import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

function memberId(request: NextRequest) {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Member id is required')
  return id
}

// Guard: refuse to leave the workspace without an admin. Called before any
// change that would drop an ADMIN (demotion or removal).
async function assertNotLastAdmin(organizationId: string) {
  const admins = await prisma.user.count({ where: { organizationId, isActive: true, role: 'ADMIN' } })
  if (admins <= 1) throw new ApiError('Your workspace needs at least one admin.', 400, 'LAST_ADMIN')
}

const roleSchema = z.object({ role: z.enum(['ADMIN', 'USER']) })

// Change a member's role. Admin-only, same-workspace only, never demotes the
// last admin.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const id = memberId(request)
  const { role } = roleSchema.parse(await request.json())
  const target = await prisma.user.findFirst({
    where: { id, organizationId: auth.organizationId, isActive: true },
    select: { id: true, role: true },
  })
  if (!target) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  if (target.role === 'ADMIN' && role === 'USER') await assertNotLastAdmin(auth.organizationId)
  const member = await prisma.user.update({
    where: { id: target.id },
    data: { role },
    select: { id: true, name: true, email: true, role: true },
  })
  return { success: true, member }
}, { permission: 'members.manage' })

// Remove a member from the workspace (soft — deactivate so their history stays
// intact). Admin-only; can't remove yourself or the last admin.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const id = memberId(request)
  if (id === auth.dbUser.id) throw new ApiError('You can’t remove yourself.', 400, 'SELF_REMOVE')
  const target = await prisma.user.findFirst({
    where: { id, organizationId: auth.organizationId, isActive: true },
    select: { id: true, role: true },
  })
  if (!target) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  if (target.role === 'ADMIN') await assertNotLastAdmin(auth.organizationId)
  await prisma.user.update({ where: { id: target.id }, data: { isActive: false } })
  return { success: true }
}, { permission: 'members.manage' })
