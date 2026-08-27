import { createHash } from 'node:crypto'
import type { ExternalSecretProvider, HttpCredentialSecretReference } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/crypto/secrets'
import { fetchPublicUrl } from '@/lib/net/ssrf'
import { recordCredentialUse, recordCredentialUseFailure } from '@/lib/credentials/audit'

export const EXTERNAL_SECRET_PROVIDERS = ['aws', 'gcp', 'azure', 'vault'] as const
export type ExternalSecretProviderType = (typeof EXTERNAL_SECRET_PROVIDERS)[number]

const awsConfigSchema = z.object({ region: z.string().trim().min(1).max(100).optional() }).strict()
const gcpConfigSchema = z.object({ projectId: z.string().trim().min(1).max(200) }).strict()
const azureConfigSchema = z.object({ vaultUrl: z.string().url().max(500) }).strict()
const vaultConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  mount: z.string().trim().min(1).max(200).default('secret'),
  namespace: z.string().trim().max(500).optional(),
}).strict()

export const externalSecretReferenceSchema = z.object({
  providerId: z.string().min(1),
  path: z.string().trim().min(1).max(1000),
  property: z.string().trim().min(1).max(500).optional(),
  version: z.string().trim().min(1).max(200).optional(),
}).strict()

export type ExternalSecretReferenceInput = z.infer<typeof externalSecretReferenceSchema>

type ProviderConfig =
  | { provider: 'aws'; value: z.infer<typeof awsConfigSchema> }
  | { provider: 'gcp'; value: z.infer<typeof gcpConfigSchema> }
  | { provider: 'azure'; value: z.infer<typeof azureConfigSchema> }
  | { provider: 'vault'; value: z.infer<typeof vaultConfigSchema> }

type ProviderRow = Pick<
  ExternalSecretProvider,
  'id' | 'organizationId' | 'name' | 'provider' | 'config' | 'authConfig' | 'allowedPathPrefix' | 'cacheTtlSeconds' | 'status'
>

type StoredReference = Pick<HttpCredentialSecretReference, 'providerId' | 'field' | 'path' | 'property' | 'version'>
type ExternalSecretUseContext = { actorUserId?: string | null; executionId?: string | null; consumer?: string }

const MAX_SECRET_BYTES = 64 * 1024
const cache = new Map<string, { value: string; expiresAt: number }>()
const inFlight = new Map<string, Promise<string>>()

function providerConfig(row: ProviderRow): ProviderConfig {
  switch (row.provider) {
    case 'aws':
      return { provider: 'aws', value: awsConfigSchema.parse(row.config) }
    case 'gcp':
      return { provider: 'gcp', value: gcpConfigSchema.parse(row.config) }
    case 'azure':
      return { provider: 'azure', value: azureConfigSchema.parse(row.config) }
    case 'vault':
      return { provider: 'vault', value: vaultConfigSchema.parse(row.config) }
    default:
      throw new Error(`Unsupported external secret provider ${row.provider}.`)
  }
}

export function validateExternalSecretProviderConfig(provider: ExternalSecretProviderType, config: unknown): Record<string, unknown> {
  switch (provider) {
    case 'aws': return awsConfigSchema.parse(config)
    case 'gcp': return gcpConfigSchema.parse(config)
    case 'azure': {
      const parsed = azureConfigSchema.parse(config)
      const hostname = new URL(parsed.vaultUrl).hostname.toLowerCase()
      if (!hostname.endsWith('.vault.azure.net') && !hostname.endsWith('.vault.usgovcloudapi.net')) {
        throw new Error('Azure Key Vault URL must use an Azure Key Vault domain.')
      }
      return parsed
    }
    case 'vault': return vaultConfigSchema.parse(config)
  }
}

function safePath(path: string): string {
  const value = path.trim().replace(/^\/+|\/+$/g, '')
  if (!value || /[\u0000-\u001f]/.test(value) || value.split('/').some((part) => part === '..')) {
    throw new Error('External secret path is invalid.')
  }
  return value
}

export function pathAllowed(path: string, prefix: string): boolean {
  const normalized = safePath(path)
  const allowed = prefix.trim().replace(/^\/+|\/+$/g, '')
  if (!allowed) return true
  return normalized === allowed || normalized.startsWith(`${allowed}/`)
}

function assertReferenceAllowed(row: ProviderRow, ref: ExternalSecretReferenceInput | StoredReference): string {
  if (row.status === 'disabled') throw new Error(`External secret provider “${row.name}” is disabled.`)
  const path = safePath(ref.path)
  if (!pathAllowed(path, row.allowedPathPrefix)) {
    throw new Error(`Secret path is outside provider “${row.name}”'s allowed prefix.`)
  }
  return path
}

function pathSegments(value: string): string[] {
  return safePath(value).split('/').map((part) => encodeURIComponent(part))
}

function boundedSecret(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new Error(`External secret exceeds ${MAX_SECRET_BYTES} bytes.`)
  }
  return value
}

function authObject(row: ProviderRow): Record<string, string> {
  if (!row.authConfig) return {}
  const plaintext = decryptSecret(row.authConfig)
  try {
    const parsed = JSON.parse(plaintext)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>
  } catch {
    // Early Vault builds stored the token directly. Preserve that one safe
    // legacy shape while every new provider writes a structured object.
    if (row.provider === 'vault') return { token: plaintext }
  }
  throw new Error('External secret provider authentication is malformed.')
}

function workloadIdentityAllowed(): boolean {
  return /^(1|true|yes)$/i.test(process.env.EXTERNAL_SECRETS_ALLOW_WORKLOAD_IDENTITY ?? '')
}

export function selectSecretProperty(raw: string, property?: string | null): string {
  if (!property) return boundedSecret(raw)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('A property was requested but the external secret is not JSON.')
  }
  for (const segment of property.split('.')) {
    if (!segment || segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
      throw new Error('External secret property path is invalid.')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !(segment in value)) {
      throw new Error(`External secret property “${property}” was not found.`)
    }
    value = (value as Record<string, unknown>)[segment]
  }
  if (typeof value === 'string') return boundedSecret(value)
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return boundedSecret(JSON.stringify(value))
}

async function readAws(row: ProviderRow, config: z.infer<typeof awsConfigSchema>, path: string, version?: string): Promise<string> {
  const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager')
  const auth = authObject(row)
  if ((!auth.accessKeyId || !auth.secretAccessKey) && !workloadIdentityAllowed()) {
    throw new Error('AWS provider has no tenant-specific credentials configured.')
  }
  const client = new SecretsManagerClient({
    ...(config.region ? { region: config.region } : {}),
    ...(auth.accessKeyId && auth.secretAccessKey ? {
      credentials: {
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
        ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
      },
    } : {}),
  })
  try {
    const result = await client.send(new GetSecretValueCommand({
      SecretId: path,
      ...(version ? { VersionStage: version } : {}),
    }))
    if (result.SecretString != null) return result.SecretString
    if (result.SecretBinary) return Buffer.from(result.SecretBinary).toString('utf8')
    throw new Error('AWS Secrets Manager returned no secret value.')
  } finally {
    client.destroy()
  }
}

async function readGcp(row: ProviderRow, config: z.infer<typeof gcpConfigSchema>, path: string, version?: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(path)) throw new Error('Google Secret Manager paths must be secret names, not resource URLs.')
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager')
  const auth = authObject(row)
  if ((!auth.client_email || !auth.private_key) && !workloadIdentityAllowed()) {
    throw new Error('Google provider has no tenant-specific service account configured.')
  }
  const client = new SecretManagerServiceClient({
    projectId: config.projectId,
    ...(auth.client_email && auth.private_key ? { credentials: auth } : {}),
  })
  const [result] = await client.accessSecretVersion({
    name: `projects/${config.projectId}/secrets/${path}/versions/${version || 'latest'}`,
  })
  const data = result.payload?.data
  if (data == null) throw new Error('Google Secret Manager returned no secret value.')
  return Buffer.from(data as Uint8Array).toString('utf8')
}

async function readAzure(row: ProviderRow, config: z.infer<typeof azureConfigSchema>, path: string, version?: string): Promise<string> {
  if (!/^[0-9A-Za-z-]+$/.test(path)) throw new Error('Azure Key Vault paths must be secret names.')
  const [{ ClientSecretCredential, DefaultAzureCredential }, { SecretClient }] = await Promise.all([
    import('@azure/identity'),
    import('@azure/keyvault-secrets'),
  ])
  const auth = authObject(row)
  if ((!auth.tenantId || !auth.clientId || !auth.clientSecret) && !workloadIdentityAllowed()) {
    throw new Error('Azure provider has no tenant-specific service principal configured.')
  }
  const credential = auth.tenantId && auth.clientId && auth.clientSecret
    ? new ClientSecretCredential(auth.tenantId, auth.clientId, auth.clientSecret)
    : new DefaultAzureCredential()
  const client = new SecretClient(config.vaultUrl, credential)
  const result = await client.getSecret(path, { ...(version ? { version } : {}) })
  if (result.value == null) throw new Error('Azure Key Vault returned no secret value.')
  return result.value
}

async function readVault(row: ProviderRow, config: z.infer<typeof vaultConfigSchema>, path: string, version?: string): Promise<string> {
  if (!row.authConfig) throw new Error('Vault provider has no token configured.')
  const token = authObject(row).token
  if (!token) throw new Error('Vault provider has no token configured.')
  const url = new URL([
    config.baseUrl.replace(/\/$/, ''),
    'v1',
    ...pathSegments(config.mount),
    'data',
    ...pathSegments(path),
  ].join('/'))
  if (version) url.searchParams.set('version', version)
  const response = await fetchPublicUrl(url.toString(), {
    headers: {
      accept: 'application/json',
      'x-vault-token': token,
      ...(config.namespace ? { 'x-vault-namespace': config.namespace } : {}),
    },
  }, { maxRedirects: 0 })
  const body = await response.json().catch(() => null) as { data?: { data?: unknown }; errors?: unknown } | null
  if (!response.ok) throw new Error(`Vault returned HTTP ${response.status}.`)
  const value = body?.data?.data
  if (value == null) throw new Error('Vault returned no secret data.')
  return typeof value === 'string' ? value : JSON.stringify(value)
}

async function fetchProviderSecret(row: ProviderRow, ref: ExternalSecretReferenceInput | StoredReference): Promise<string> {
  const path = assertReferenceAllowed(row, ref)
  const config = providerConfig(row)
  switch (config.provider) {
    case 'aws': return readAws(row, config.value, path, ref.version ?? undefined)
    case 'gcp': return readGcp(row, config.value, path, ref.version ?? undefined)
    case 'azure': return readAzure(row, config.value, path, ref.version ?? undefined)
    case 'vault': return readVault(row, config.value, path, ref.version ?? undefined)
  }
}

function cacheKey(row: ProviderRow, ref: ExternalSecretReferenceInput | StoredReference): string {
  return createHash('sha256')
    .update([row.organizationId, row.id, ref.path, ref.property ?? '', ref.version ?? ''].join('\0'))
    .digest('hex')
}

async function markProvider(row: ProviderRow, ok: boolean, error?: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 500) : 'External secret read failed.'
  await prisma.externalSecretProvider.updateMany({
    where: { id: row.id, organizationId: row.organizationId },
    data: ok
      ? { status: 'verified', lastVerifiedAt: new Date(), lastError: null }
      : { status: 'error', lastError: message },
  }).catch(() => undefined)
}

function externalUse(row: ProviderRow, context: ExternalSecretUseContext, consumer: string) {
  return {
    organizationId: row.organizationId,
    kind: 'external_secret_provider' as const,
    credentialId: row.id,
    provider: row.provider,
    ownerUserId: null,
    actorUserId: context.actorUserId,
    executionId: context.executionId,
    consumer: context.consumer ?? consumer,
  }
}

async function resolveOne(
  row: ProviderRow,
  ref: ExternalSecretReferenceInput | StoredReference,
  context: ExternalSecretUseContext = {},
): Promise<string> {
  const key = cacheKey(row, ref)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    await recordCredentialUse(externalUse(row, context, 'external_secret.cache')).catch(() => undefined)
    return cached.value
  }
  const existing = inFlight.get(key)
  if (existing) {
    try {
      const value = await existing
      await recordCredentialUse(externalUse(row, context, 'external_secret.coalesced')).catch(() => undefined)
      return value
    } catch (error) {
      await recordCredentialUseFailure({
        ...externalUse(row, context, 'external_secret.coalesced'),
        reason: error instanceof Error ? error.message.slice(0, 200) : 'external_secret_read_failed',
      }).catch(() => undefined)
      throw error
    }
  }
  const request = (async () => {
    try {
      const raw = await fetchProviderSecret(row, ref)
      const value = selectSecretProperty(raw, ref.property)
      const ttlMs = Math.max(0, Math.min(300, row.cacheTtlSeconds)) * 1000
      if (ttlMs) cache.set(key, { value, expiresAt: Date.now() + ttlMs })
      await Promise.all([
        markProvider(row, true),
        recordCredentialUse(externalUse(row, context, 'external_secret.read')).catch(() => undefined),
      ])
      return value
    } catch (error) {
      await Promise.all([
        markProvider(row, false, error),
        recordCredentialUseFailure({
          ...externalUse(row, context, 'external_secret.read'),
          reason: error instanceof Error ? error.message.slice(0, 200) : 'external_secret_read_failed',
        }).catch(() => undefined),
      ])
      throw error
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, request)
  return request
}

async function providerRows(
  organizationId: string,
  providerIds: string[],
): Promise<Map<string, ProviderRow>> {
  const rows = await prisma.externalSecretProvider.findMany({
    where: {
      organizationId,
      id: { in: [...new Set(providerIds)] },
    },
  })
  return new Map(rows.map((row) => [row.id, row]))
}

/** Resolve a proposed set of field references before a credential is saved. */
export async function resolveExternalSecretInputs(
  organizationId: string,
  userId: string,
  refs: Record<string, ExternalSecretReferenceInput>,
): Promise<Record<string, string>> {
  const parsed = Object.fromEntries(
    Object.entries(refs).map(([field, ref]) => [field, externalSecretReferenceSchema.parse(ref)]),
  )
  const providers = await providerRows(organizationId, Object.values(parsed).map((ref) => ref.providerId))
  return Object.fromEntries(await Promise.all(Object.entries(parsed).map(async ([field, ref]) => {
    const provider = providers.get(ref.providerId)
    if (!provider) throw new Error(`External secret provider for field “${field}” is unavailable.`)
    return [field, await resolveOne(provider, ref, { actorUserId: userId, consumer: 'external_secret.verify' })]
  })))
}

/** Merge persisted external values onto the locally encrypted non-secret config. */
export async function resolveHttpCredentialSecretReferences(
  organizationId: string,
  credentialId: string,
  config: Record<string, string>,
  context: ExternalSecretUseContext = {},
): Promise<{ config: Record<string, string>; externalFields: string[] }> {
  const refs = await prisma.httpCredentialSecretReference.findMany({
    where: { organizationId, credentialId },
  })
  if (!refs.length) return { config, externalFields: [] }
  const providers = await providerRows(organizationId, refs.map((ref) => ref.providerId))
  const external = Object.fromEntries(await Promise.all(refs.map(async (ref) => {
    const provider = providers.get(ref.providerId)
    if (!provider) throw new Error(`External secret provider for field “${ref.field}” is unavailable.`)
    return [ref.field, await resolveOne(provider, ref, context)]
  })))
  return { config: { ...config, ...external }, externalFields: refs.map((ref) => ref.field) }
}

export function clearExternalSecretCache(providerId?: string): void {
  // Cache keys are hashes, so an individual provider cannot be identified
  // without keeping path metadata beside values. Provider mutation therefore
  // clears the small process cache wholesale — safe and deterministic.
  if (providerId || cache.size) cache.clear()
}

async function listAws(row: ProviderRow, config: z.infer<typeof awsConfigSchema>, prefix: string, limit: number): Promise<string[]> {
  const { ListSecretsCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager')
  const auth = authObject(row)
  if ((!auth.accessKeyId || !auth.secretAccessKey) && !workloadIdentityAllowed()) throw new Error('AWS provider has no tenant-specific credentials configured.')
  const client = new SecretsManagerClient({
    ...(config.region ? { region: config.region } : {}),
    ...(auth.accessKeyId && auth.secretAccessKey ? { credentials: {
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
      ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
    } } : {}),
  })
  try {
    const result = await client.send(new ListSecretsCommand({ MaxResults: Math.min(100, limit) }))
    return (result.SecretList ?? []).map((item) => item.Name).filter((name): name is string => Boolean(name && pathAllowed(name, prefix)))
  } finally {
    client.destroy()
  }
}

async function listGcp(row: ProviderRow, config: z.infer<typeof gcpConfigSchema>, prefix: string, limit: number): Promise<string[]> {
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager')
  const auth = authObject(row)
  if ((!auth.client_email || !auth.private_key) && !workloadIdentityAllowed()) throw new Error('Google provider has no tenant-specific service account configured.')
  const client = new SecretManagerServiceClient({
    projectId: config.projectId,
    ...(auth.client_email && auth.private_key ? { credentials: auth } : {}),
  })
  const names: string[] = []
  for await (const item of client.listSecretsAsync({ parent: `projects/${config.projectId}`, pageSize: Math.min(100, limit) })) {
    const name = item.name?.split('/').at(-1)
    if (name && pathAllowed(name, prefix)) names.push(name)
    if (names.length >= limit) break
  }
  return names
}

async function listAzure(row: ProviderRow, config: z.infer<typeof azureConfigSchema>, prefix: string, limit: number): Promise<string[]> {
  const [{ ClientSecretCredential, DefaultAzureCredential }, { SecretClient }] = await Promise.all([
    import('@azure/identity'),
    import('@azure/keyvault-secrets'),
  ])
  const auth = authObject(row)
  if ((!auth.tenantId || !auth.clientId || !auth.clientSecret) && !workloadIdentityAllowed()) throw new Error('Azure provider has no tenant-specific service principal configured.')
  const credential = auth.tenantId && auth.clientId && auth.clientSecret
    ? new ClientSecretCredential(auth.tenantId, auth.clientId, auth.clientSecret)
    : new DefaultAzureCredential()
  const client = new SecretClient(config.vaultUrl, credential)
  const names: string[] = []
  for await (const item of client.listPropertiesOfSecrets()) {
    if (item.name && pathAllowed(item.name, prefix)) names.push(item.name)
    if (names.length >= limit) break
  }
  return names
}

async function listVault(row: ProviderRow, config: z.infer<typeof vaultConfigSchema>, prefix: string): Promise<string[]> {
  if (!row.authConfig) throw new Error('Vault provider has no token configured.')
  const token = authObject(row).token
  if (!token) throw new Error('Vault provider has no token configured.')
  const path = prefix.trim().replace(/^\/+|\/+$/g, '')
  const url = [config.baseUrl.replace(/\/$/, ''), 'v1', ...pathSegments(config.mount), 'metadata', ...(path ? pathSegments(path) : [])].join('/')
  const response = await fetchPublicUrl(url, {
    method: 'LIST',
    headers: {
      accept: 'application/json',
      'x-vault-token': token,
      ...(config.namespace ? { 'x-vault-namespace': config.namespace } : {}),
    },
  }, { maxRedirects: 0 })
  const body = await response.json().catch(() => null) as { data?: { keys?: unknown } } | null
  if (!response.ok) throw new Error(`Vault returned HTTP ${response.status}.`)
  return Array.isArray(body?.data?.keys) ? body.data.keys.filter((key): key is string => typeof key === 'string') : []
}

/** Provider-backed name completion; values are never returned. */
export async function listExternalSecretNames(
  organizationId: string,
  userId: string,
  providerId: string,
  query = '',
  limit = 100,
): Promise<string[]> {
  const providers = await providerRows(organizationId, [providerId])
  const row = providers.get(providerId)
  if (!row) throw new Error('External secret provider is unavailable.')
  const config = providerConfig(row)
  const bounded = Math.max(1, Math.min(200, limit))
  let names: string[]
  try {
    switch (config.provider) {
      case 'aws': names = await listAws(row, config.value, row.allowedPathPrefix, bounded); break
      case 'gcp': names = await listGcp(row, config.value, row.allowedPathPrefix, bounded); break
      case 'azure': names = await listAzure(row, config.value, row.allowedPathPrefix, bounded); break
      case 'vault': names = await listVault(row, config.value, row.allowedPathPrefix); break
    }
    await recordCredentialUse(externalUse(row, { actorUserId: userId }, 'external_secret.list')).catch(() => undefined)
  } catch (error) {
    await recordCredentialUseFailure({
      ...externalUse(row, { actorUserId: userId }, 'external_secret.list'),
      reason: error instanceof Error ? error.message.slice(0, 200) : 'external_secret_list_failed',
    }).catch(() => undefined)
    throw error
  }
  const needle = query.trim().toLocaleLowerCase()
  return names.filter((name) => !needle || name.toLocaleLowerCase().includes(needle)).slice(0, bounded)
}
