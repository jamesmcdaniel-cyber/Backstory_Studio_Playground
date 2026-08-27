import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { authenticateScim, scimError, scimJson } from '@/lib/scim/server'
import { systemPrisma } from '@/lib/prisma'
import { readRequestJsonLimited, RequestBodyError } from '@/lib/server/request-body'

const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const SCIM_MAX_BODY_BYTES = 256_000
const roleFor = (request: Request): UserRole | null => {
  const value = new URL(request.url).pathname.split('/').at(-1)?.toUpperCase()
  return value === 'ADMIN' || value === 'USER' || value === 'VIEWER' ? value : null
}

async function resource(organizationId: string, role: UserRole) {
  const users = await systemPrisma.user.findMany({ where: { organizationId, role, isActive: true }, select: { id: true, name: true, email: true } })
  return { schemas: [GROUP_SCHEMA], id: role.toLowerCase(), displayName: role, members: users.map((user) => ({ value: user.id, display: user.name ?? user.email ?? user.id })), meta: { resourceType: 'Group', location: `/api/scim/v2/Groups/${role.toLowerCase()}` } }
}

export async function GET(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const role = roleFor(request)
  return role ? scimJson(await resource(auth.organizationId, role)) : scimError('Group not found.', 404)
}

export async function PATCH(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const role = roleFor(request)
  if (!role) return scimError('Group not found.', 404)
  let raw: unknown
  try {
    raw = await readRequestJsonLimited(request, SCIM_MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyError) return scimError(error.message, error.status)
    throw error
  }
  const parsed = z.object({ Operations: z.array(z.object({ op: z.string(), value: z.unknown().optional() })) }).safeParse(raw)
  if (!parsed.success) return scimError('Invalid group patch.', 400)
  for (const operation of parsed.data.Operations) {
    const values = Array.isArray(operation.value) ? operation.value : []
    const ids = values.flatMap((item) => item && typeof item === 'object' && typeof (item as { value?: unknown }).value === 'string' ? [(item as { value: string }).value] : [])
    if (!ids.length) continue
    if (operation.op.toLowerCase() === 'add' || operation.op.toLowerCase() === 'replace') {
      await systemPrisma.user.updateMany({ where: { organizationId: auth.organizationId, id: { in: ids }, role: { not: 'OWNER' } }, data: { role } })
    } else if (operation.op.toLowerCase() === 'remove') {
      await systemPrisma.user.updateMany({ where: { organizationId: auth.organizationId, id: { in: ids }, role }, data: { role: 'USER' } })
    }
  }
  return scimJson(await resource(auth.organizationId, role))
}
