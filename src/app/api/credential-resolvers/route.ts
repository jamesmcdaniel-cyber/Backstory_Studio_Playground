import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { HTTP_AUTH_TYPES } from '@/features/flows/http-auth'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { bindCredentialResolver, CredentialResolverError } from '@/lib/credentials/resolver'
import { recordAudit } from '@/lib/audit'

const createSchema = z.object({
  action: z.literal('create'),
  name: z.string().trim().min(1).max(120),
  credentialId: z.string().trim().min(1),
}).strict()

const bindSchema = z.object({
  action: z.literal('bind'),
  resolverId: z.string().trim().min(1),
  credentialId: z.string().trim().min(1),
}).strict()

const unbindSchema = z.object({
  action: z.literal('unbind'),
  resolverId: z.string().trim().min(1),
}).strict()

const mutateSchema = z.discriminatedUnion('action', [createSchema, bindSchema, unbindSchema])

function response(row: {
  id: string
  name: string
  authType: string
  allowedHost: string
  status: string
  createdAt: Date
  updatedAt: Date
  bindings?: { credentialId: string }[]
}) {
  return {
    id: row.id,
    name: row.name,
    authType: row.authType,
    allowedHost: row.allowedHost,
    status: row.status,
    boundCredentialId: row.bindings?.[0]?.credentialId ?? null,
    ready: Boolean(row.bindings?.[0]),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const resolvers = await prisma.credentialResolver.findMany({
    where: { organizationId: auth.organizationId },
    include: {
      bindings: {
        where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
        select: { credentialId: true },
        take: 1,
      },
    },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
  })
  return { success: true, resolvers: resolvers.map(response) }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = mutateSchema.parse(await request.json())
  if (input.action === 'create') {
    if (!auth.can('integration.manage')) {
      throw new ApiError('Only an integration administrator can create a shared credential resolver.', 403, 'RESOLVER_ADMIN_REQUIRED')
    }
    const source = await prisma.httpCredential.findFirst({
      where: {
        id: input.credentialId,
        organizationId: auth.organizationId,
        status: { in: ['verified', 'error'] },
      },
    })
    if (!source) throw new ApiError('Template credential not found.', 404, 'CREDENTIAL_NOT_FOUND')
    try {
      const resolver = await tenantTransaction(auth.organizationId, async (tx) => {
        const created = await tx.credentialResolver.create({
          data: {
            organizationId: auth.organizationId,
            createdByUserId: auth.dbUser.id,
            name: input.name,
            authType: z.enum(HTTP_AUTH_TYPES).parse(source.authType),
            allowedHost: source.allowedHost.toLowerCase(),
          },
        })
        if (source.userId === auth.dbUser.id) {
          await tx.credentialResolverBinding.create({
            data: {
              organizationId: auth.organizationId,
              resolverId: created.id,
              userId: auth.dbUser.id,
              credentialId: source.id,
            },
          })
        }
        return created
      })
      await recordAudit({
        organizationId: auth.organizationId,
        action: 'credential_resolver.created',
        actorUserId: auth.userId,
        resourceType: 'credential_resolver',
        resourceId: resolver.id,
        detail: { authType: resolver.authType, allowedHost: resolver.allowedHost },
      })
      return { success: true, resolver: response({ ...resolver, bindings: source.userId === auth.dbUser.id ? [{ credentialId: source.id }] : [] }) }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ApiError('A credential resolver with that name already exists.', 409, 'RESOLVER_NAME_TAKEN')
      }
      throw error
    }
  }

  if (input.action === 'unbind') {
    await prisma.credentialResolverBinding.deleteMany({
      where: { organizationId: auth.organizationId, resolverId: input.resolverId, userId: auth.dbUser.id },
    })
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'credential_resolver.unbound',
      actorUserId: auth.userId,
      resourceType: 'credential_resolver',
      resourceId: input.resolverId,
    })
    return { success: true }
  }

  try {
    const binding = await bindCredentialResolver({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      resolverId: input.resolverId,
      credentialId: input.credentialId,
    })
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'credential_resolver.bound',
      actorUserId: auth.userId,
      resourceType: 'credential_resolver',
      resourceId: input.resolverId,
      detail: { credentialId: binding.credentialId },
    })
    return { success: true, binding: { resolverId: binding.resolverId, credentialId: binding.credentialId } }
  } catch (error) {
    if (error instanceof CredentialResolverError) throw new ApiError(error.message, 422, error.code)
    throw error
  }
}, { permission: 'flow.run' })

const patchSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict().refine((value) => value.name !== undefined || value.status !== undefined, 'Name or status is required.')

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = patchSchema.parse(await request.json())
  const result = await prisma.credentialResolver.updateMany({
    where: { id: input.id, organizationId: auth.organizationId },
    data: { ...(input.name ? { name: input.name } : {}), ...(input.status ? { status: input.status } : {}) },
  })
  if (!result.count) throw new ApiError('Credential resolver not found.', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'integration.manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).searchParams.get('id')
  if (!id) throw new ApiError('Credential resolver id is required.', 400, 'MISSING_ID')
  const deleted = await prisma.credentialResolver.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, name: true },
  })
  if (!deleted) throw new ApiError('Credential resolver not found.', 404, 'NOT_FOUND')
  await prisma.credentialResolver.delete({ where: { id, organizationId: auth.organizationId } })
  await recordAudit({
    organizationId: auth.organizationId,
    action: 'credential_resolver.deleted',
    actorUserId: auth.userId,
    resourceType: 'credential_resolver',
    resourceId: id,
    detail: { name: deleted.name },
  })
  return { success: true }
}, { permission: 'integration.manage' })
