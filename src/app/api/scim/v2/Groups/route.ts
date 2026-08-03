import { authenticateScim, SCIM_LIST_SCHEMA, scimJson } from '@/lib/scim/server'
import { systemPrisma } from '@/lib/prisma'

const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const roles = ['ADMIN', 'USER', 'VIEWER'] as const

export async function GET(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const users = await systemPrisma.user.findMany({
    where: { organizationId: auth.organizationId, isActive: true, role: { in: [...roles] } },
    select: { id: true, name: true, email: true, role: true },
  })
  const resources = roles.map((role) => ({
    schemas: [GROUP_SCHEMA], id: role.toLowerCase(), displayName: role,
    members: users.filter((user) => user.role === role).map((user) => ({ value: user.id, display: user.name ?? user.email ?? user.id })),
    meta: { resourceType: 'Group', location: `/api/scim/v2/Groups/${role.toLowerCase()}` },
  }))
  return scimJson({ schemas: [SCIM_LIST_SCHEMA], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources })
}
