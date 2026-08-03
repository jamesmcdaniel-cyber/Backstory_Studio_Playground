import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { authenticateScim, roleOf, SCIM_LIST_SCHEMA, scimError, scimJson, scimUser, supabaseAdmin } from '@/lib/scim/server'

const createSchema = z.object({
  externalId: z.string().max(255).optional(),
  userName: z.string().trim().toLowerCase().email(),
  active: z.boolean().default(true),
  displayName: z.string().trim().max(200).optional(),
  name: z.object({ givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
  roles: z.array(z.object({ value: z.string() })).optional(),
})

export async function GET(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const url = new URL(request.url)
  const filter = url.searchParams.get('filter')
  const match = filter ? /^userName\s+eq\s+"([^"]+)"$/i.exec(filter) : null
  if (filter && !match) return scimError('Only userName eq filters are supported.', 400)
  const startIndex = Math.max(1, Number(url.searchParams.get('startIndex')) || 1)
  const count = Math.min(200, Math.max(1, Number(url.searchParams.get('count')) || 100))
  const where = { organizationId: auth.organizationId, ...(match ? { email: match[1].trim().toLowerCase() } : {}) }
  const [totalResults, rows] = await Promise.all([
    systemPrisma.user.count({ where }),
    systemPrisma.user.findMany({ where, orderBy: { createdAt: 'asc' }, skip: startIndex - 1, take: count }),
  ])
  return scimJson({ schemas: [SCIM_LIST_SCHEMA], totalResults, startIndex, itemsPerPage: rows.length, Resources: rows.map(scimUser) })
}

export async function POST(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return scimError('Invalid SCIM user payload.', 400)
  const input = parsed.data
  const existing = await systemPrisma.user.findFirst({ where: { organizationId: auth.organizationId, email: input.userName } })
  if (existing) return scimError('A user with that userName already exists.', 409)
  let authUserId: string
  try {
    const created = await supabaseAdmin().createUser({
      email: input.userName,
      email_confirm: true,
      user_metadata: { full_name: input.displayName ?? `${input.name?.givenName ?? ''} ${input.name?.familyName ?? ''}`.trim(), organization_id: auth.organizationId, provisioned_by: 'scim' },
    })
    if (created.error || !created.data.user) throw created.error ?? new Error('Identity creation failed')
    authUserId = created.data.user.id
  } catch (error) {
    return scimError(error instanceof Error ? error.message : 'Identity creation failed.', 502)
  }
  const name = input.displayName ?? (`${input.name?.givenName ?? ''} ${input.name?.familyName ?? ''}`.trim() || input.userName)
  try {
    const user = await systemPrisma.user.create({
      data: { supabaseId: authUserId, organizationId: auth.organizationId, email: input.userName, name, scimExternalId: input.externalId, isActive: input.active, role: roleOf(input.roles?.[0]?.value) },
    })
    return scimJson(scimUser(user), 201)
  } catch (error) {
    await supabaseAdmin().deleteUser(authUserId).catch(() => undefined)
    return scimError(error instanceof Error ? error.message : 'Provisioning failed.', 409)
  }
}
