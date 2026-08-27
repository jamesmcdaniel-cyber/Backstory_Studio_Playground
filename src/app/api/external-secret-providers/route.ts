import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { encryptSecret } from '@/lib/crypto/secrets'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { recordAudit } from '@/lib/audit'
import { recordCredentialGrant, recordCredentialRotation } from '@/lib/credentials/audit'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  EXTERNAL_SECRET_PROVIDERS,
  clearExternalSecretCache,
  externalSecretReferenceSchema,
  listExternalSecretNames,
  resolveExternalSecretInputs,
  validateExternalSecretProviderConfig,
} from '@/lib/external-secrets/service'

export const runtime = 'nodejs'

const upsertSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  provider: z.enum(EXTERNAL_SECRET_PROVIDERS),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Required for a new Vault connection; omit on edit to keep the old token. */
  vaultToken: z.string().min(1).max(20_000).optional(),
  awsAccessKeyId: z.string().min(1).max(500).optional(),
  awsSecretAccessKey: z.string().min(1).max(5000).optional(),
  awsSessionToken: z.string().min(1).max(20_000).optional(),
  gcpServiceAccountJson: z.string().min(1).max(100_000).optional(),
  azureTenantId: z.string().min(1).max(500).optional(),
  azureClientId: z.string().min(1).max(500).optional(),
  azureClientSecret: z.string().min(1).max(20_000).optional(),
  allowedPathPrefix: z.string().trim().max(1000).default(''),
  cacheTtlSeconds: z.number().int().min(0).max(300).default(60),
}).strict()

function workloadIdentityAllowed(): boolean {
  return /^(1|true|yes)$/i.test(process.env.EXTERNAL_SECRETS_ALLOW_WORKLOAD_IDENTITY ?? '')
}

function authForInput(input: z.infer<typeof upsertSchema>): Record<string, string> | null {
  switch (input.provider) {
    case 'aws': {
      const any = Boolean(input.awsAccessKeyId || input.awsSecretAccessKey || input.awsSessionToken)
      if (!any) return null
      if (!input.awsAccessKeyId || !input.awsSecretAccessKey) throw new ApiError('AWS access key id and secret access key are both required.', 400, 'AWS_CREDENTIALS_INCOMPLETE')
      return {
        accessKeyId: input.awsAccessKeyId,
        secretAccessKey: input.awsSecretAccessKey,
        ...(input.awsSessionToken ? { sessionToken: input.awsSessionToken } : {}),
      }
    }
    case 'gcp': {
      if (!input.gcpServiceAccountJson) return null
      let parsed: unknown
      try { parsed = JSON.parse(input.gcpServiceAccountJson) } catch { throw new ApiError('Google service-account credentials must be valid JSON.', 400, 'GCP_CREDENTIALS_INVALID') }
      const result = z.object({ client_email: z.string().email(), private_key: z.string().min(1) }).passthrough().parse(parsed)
      return Object.fromEntries(Object.entries(result).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    }
    case 'azure': {
      const any = Boolean(input.azureTenantId || input.azureClientId || input.azureClientSecret)
      if (!any) return null
      if (!input.azureTenantId || !input.azureClientId || !input.azureClientSecret) throw new ApiError('Azure tenant id, client id, and client secret are all required.', 400, 'AZURE_CREDENTIALS_INCOMPLETE')
      return { tenantId: input.azureTenantId, clientId: input.azureClientId, clientSecret: input.azureClientSecret }
    }
    case 'vault':
      return input.vaultToken ? { token: input.vaultToken } : null
  }
}

function providerResponse(row: {
  id: string
  name: string
  provider: string
  config: unknown
  allowedPathPrefix: string
  cacheTtlSeconds: number
  status: string
  lastVerifiedAt: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    config: row.config,
    allowedPathPrefix: row.allowedPathPrefix,
    cacheTtlSeconds: row.cacheTtlSeconds,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const url = new URL(request.url)
  const providerId = url.searchParams.get('providerId')
  if (providerId) {
    const names = await listExternalSecretNames(
      auth.organizationId,
      auth.dbUser.id,
      providerId,
      url.searchParams.get('query') ?? '',
      Number(url.searchParams.get('limit') || 100),
    )
    return { success: true, names }
  }
  const providers = await prisma.externalSecretProvider.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { name: 'asc' },
  })
  return { success: true, providers: providers.map(providerResponse) }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = upsertSchema.parse(await request.json())
  const config = validateExternalSecretProviderConfig(input.provider, input.config)
  if (input.provider === 'vault') {
    await assertPublicUrl(String(config.baseUrl))
  }
  if (/\.{2}(?:\/|$)|[\u0000-\u001f]/.test(input.allowedPathPrefix)) {
    throw new ApiError('Allowed path prefix is invalid.', 400, 'EXTERNAL_SECRET_PREFIX_INVALID')
  }

  const existing = input.id
    ? await prisma.externalSecretProvider.findFirst({
        where: { id: input.id, organizationId: auth.organizationId },
      })
    : null
  if (input.id && !existing) throw new ApiError('External secret provider not found.', 404, 'NOT_FOUND')
  if (existing && existing.provider !== input.provider) {
    throw new ApiError('A secret provider type cannot be changed in place.', 400, 'EXTERNAL_SECRET_PROVIDER_TYPE_IMMUTABLE')
  }
  const suppliedAuth = authForInput(input)
  if (!suppliedAuth && !existing?.authConfig && !workloadIdentityAllowed()) {
    throw new ApiError(
      input.provider === 'vault'
        ? 'A Vault token is required.'
        : `Tenant-specific ${input.provider.toUpperCase()} credentials are required.`,
      400,
      'EXTERNAL_SECRET_PROVIDER_CREDENTIALS_REQUIRED',
    )
  }

  try {
    const data = {
      name: input.name,
      provider: input.provider,
      config: config as Prisma.InputJsonObject,
      allowedPathPrefix: input.allowedPathPrefix.replace(/^\/+|\/+$/g, ''),
      cacheTtlSeconds: input.cacheTtlSeconds,
      status: 'unverified',
      lastError: null,
      // The bootstrap credential is encrypted, while the actual application
      // secret stays in the external manager. Workload identity is an explicit
      // operator opt-in because a shared process identity is otherwise a
      // cross-tenant confused-deputy risk.
      authConfig: suppliedAuth
        ? encryptSecret(JSON.stringify(suppliedAuth))
        : existing?.authConfig ?? null,
    }
    const provider = existing
      ? await prisma.externalSecretProvider.update({
          where: { id: existing.id, organizationId: auth.organizationId },
          data,
        })
      : await prisma.externalSecretProvider.create({
          // Secret-manager connections are workspace infrastructure, not a
          // delegated end-user identity. Cloud workload identity is shared by
          // the deployment and Vault access is path-prefix constrained.
          data: { organizationId: auth.organizationId, ...data },
        })
    clearExternalSecretCache(provider.id)
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: existing ? 'credential.external_secret_provider_updated' : 'credential.external_secret_provider_created',
      resourceType: 'external_secret_provider',
      resourceId: provider.id,
      detail: { provider: provider.provider },
    })
    if (!existing) {
      await recordCredentialGrant({
        organizationId: auth.organizationId,
        kind: 'external_secret_provider',
        credentialId: provider.id,
        provider: provider.provider,
        ownerUserId: null,
        actorUserId: auth.dbUser.id,
        method: suppliedAuth ? 'encrypted_bootstrap' : 'workload_identity',
      })
    } else if (suppliedAuth) {
      await recordCredentialRotation({
        organizationId: auth.organizationId,
        kind: 'external_secret_provider',
        credentialId: provider.id,
        provider: provider.provider,
        ownerUserId: null,
        actorUserId: auth.dbUser.id,
        reason: 'bootstrap_credentials_replaced',
      })
    }
    return { success: true, provider: providerResponse(provider) }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ApiError('A secret provider with that name already exists.', 409, 'EXTERNAL_SECRET_PROVIDER_NAME_EXISTS')
    }
    throw error
  }
}, { permission: 'integration.manage' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({
    providerId: z.string().min(1),
    reference: externalSecretReferenceSchema.omit({ providerId: true }),
  }).parse(await request.json())
  const values = await resolveExternalSecretInputs(auth.organizationId, auth.dbUser.id, {
    test: { providerId: input.providerId, ...input.reference },
  })
  return { success: true, readable: typeof values.test === 'string' }
}, { permission: 'integration.manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).searchParams.get('id')
  if (!id) throw new ApiError('External secret provider id is required.', 400, 'MISSING_ID')
  const provider = await prisma.externalSecretProvider.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, provider: true, _count: { select: { references: true } } },
  })
  if (!provider) throw new ApiError('External secret provider not found.', 404, 'NOT_FOUND')
  if (provider._count.references) {
    throw new ApiError(
      `This provider is used by ${provider._count.references} credential field${provider._count.references === 1 ? '' : 's'}. Remove those references first.`,
      409,
      'EXTERNAL_SECRET_PROVIDER_IN_USE',
    )
  }
  await prisma.externalSecretProvider.delete({ where: { id, organizationId: auth.organizationId } })
  clearExternalSecretCache(id)
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'credential.external_secret_provider_deleted',
    resourceType: 'external_secret_provider',
    resourceId: id,
    detail: { provider: provider.provider },
  })
  return { success: true }
}, { permission: 'integration.manage' })
