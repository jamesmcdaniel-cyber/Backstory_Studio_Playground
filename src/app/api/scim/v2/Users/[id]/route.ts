import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { authenticateScim, roleOf, scimError, scimJson, scimUser, supabaseAdmin } from '@/lib/scim/server'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'

function idOf(request: Request) { return new URL(request.url).pathname.split('/').at(-1) ?? '' }

async function ownedUser(request: Request, organizationId: string) {
  return systemPrisma.user.findFirst({ where: { id: idOf(request), organizationId } })
}

export async function GET(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const user = await ownedUser(request, auth.organizationId)
  return user ? scimJson(scimUser(user)) : scimError('User not found.', 404)
}

export async function PATCH(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const existing = await ownedUser(request, auth.organizationId)
  if (!existing) return scimError('User not found.', 404)
  // The platform owner account is not managed by identity-provider sync: no
  // rename, role change, deactivation, or attribute write, ever.
  if (isPlatformOwnerEmail(existing.email)) return scimError('This account is the platform owner and cannot be managed via SCIM.', 403)
  const body = z.object({ Operations: z.array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() })).min(1) }).safeParse(await request.json().catch(() => null))
  if (!body.success) return scimError('Invalid PatchOp payload.', 400)
  const data: { email?: string; name?: string; isActive?: boolean; role?: ReturnType<typeof roleOf> } = {}
  for (const operation of body.data.Operations) {
    const path = operation.path?.toLowerCase()
    if (path === 'active' && typeof operation.value === 'boolean') data.isActive = operation.value
    else if (path === 'username' && typeof operation.value === 'string') data.email = operation.value.trim().toLowerCase()
    else if (path === 'displayname' && typeof operation.value === 'string') data.name = operation.value.trim()
    else if (path === 'roles' && Array.isArray(operation.value)) data.role = roleOf((operation.value[0] as { value?: unknown } | undefined)?.value)
  }
  // OWNER and the owner emails are reserved for the platform owner identities.
  if (data.role === 'OWNER' || isPlatformOwnerEmail(data.email)) return scimError('The Owner role is reserved for the platform owner.', 403)
  if (data.email || data.isActive !== undefined) {
    const identity = await supabaseAdmin().updateUserById(existing.supabaseId, {
      ...(data.email ? { email: data.email } : {}),
      ...(data.isActive === false ? { ban_duration: '876000h' } : data.isActive === true ? { ban_duration: 'none' } : {}),
    })
    if (identity.error) return scimError(identity.error.message, 502)
  }
  const updated = await systemPrisma.user.update({ where: { id: existing.id }, data })
  return scimJson(scimUser(updated))
}

export async function DELETE(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const existing = await ownedUser(request, auth.organizationId)
  if (!existing) return new Response(null, { status: 204 })
  if (isPlatformOwnerEmail(existing.email)) return scimError('This account is the platform owner and cannot be deleted.', 403)
  await supabaseAdmin().updateUserById(existing.supabaseId, { ban_duration: '876000h' }).catch(() => undefined)
  await systemPrisma.user.update({ where: { id: existing.id }, data: { isActive: false } })
  return new Response(null, { status: 204 })
}
