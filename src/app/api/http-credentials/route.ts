import { z } from 'zod'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import {
  HTTP_AUTH_TYPES,
  fetchWithHttpCredential,
  redactedCredential,
  type HttpAuthType,
  type HttpCredentialConfig,
} from '@/features/flows/http-auth'
import { recordCredentialGrant, recordCredentialRotation } from '@/lib/credentials/audit'
import {
  externalSecretReferenceSchema,
  resolveExternalSecretInputs,
  resolveHttpCredentialSecretReferences,
  type ExternalSecretReferenceInput,
} from '@/lib/external-secrets/service'

// Fire a live request with the credential applied and classify the outcome.
// Throws ApiError on rejection; returns cleanly when the credential works.
async function verifyCredentialLive(params: {
  id?: string
  name: string
  authType: HttpAuthType
  allowedHost: string
  url: string
  method: string
  config: HttpCredentialConfig
  externalFields?: string[]
}) {
  try {
    const response = await fetchWithHttpCredential(
      { url: params.url, init: { method: params.method, redirect: 'error' } },
      {
        ...(params.id ? { id: params.id } : {}),
        name: params.name,
        authType: params.authType,
        allowedHost: params.allowedHost,
        config: params.config,
        externalFields: params.externalFields,
      },
    )
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(`The API rejected these credentials with HTTP ${response.status}.`, 422, 'CREDENTIAL_REJECTED')
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(`Could not verify the credential: ${safeError(error)}`, 422, 'CREDENTIAL_VERIFICATION_FAILED')
  }
}

export const runtime = 'nodejs'

const payloadSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  authType: z.enum(HTTP_AUTH_TYPES),
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  config: z.record(z.string(), z.string().max(20_000)),
  secretRefs: z.record(z.string(), externalSecretReferenceSchema).optional(),
})

const REFERENCE_FIELDS: Record<HttpAuthType, ReadonlySet<string>> = {
  basic: new Set(['username', 'password']),
  digest: new Set(['username', 'password']),
  bearer: new Set(['token']),
  header: new Set(['name', 'value']),
  query: new Set(['name', 'value']),
  custom: new Set(['headersJson', 'queryJson']),
  oauth1: new Set(['consumerKey', 'consumerSecret', 'token', 'tokenSecret']),
  // refreshToken is intentionally absent: providers rotate it, and this app
  // cannot safely write a replacement back into a read-only secret manager.
  oauth2: new Set(['accessToken', 'tokenUrl', 'clientId', 'clientSecret', 'scope', 'audience']),
}

function validatedReferences(
  authType: HttpAuthType,
  refs: Record<string, ExternalSecretReferenceInput> | undefined,
): Record<string, ExternalSecretReferenceInput> {
  const entries = Object.entries(refs ?? {})
  if (entries.length > 20) throw new ApiError('A credential can reference at most 20 external fields.', 400, 'TOO_MANY_SECRET_REFERENCES')
  for (const [field] of entries) {
    if (field === 'refreshToken') {
      throw new ApiError('OAuth refresh tokens cannot be externally referenced because providers rotate them.', 400, 'EXTERNAL_REFRESH_TOKEN_UNSUPPORTED')
    }
    if (!REFERENCE_FIELDS[authType].has(field)) {
      throw new ApiError(`Field “${field}” is not valid for ${authType} authentication.`, 400, 'INVALID_SECRET_REFERENCE_FIELD')
    }
  }
  return Object.fromEntries(entries)
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Credential verification failed.'
  return message
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/(token|secret|password|key)=([^&\s]+)/gi, '$1=[redacted]')
    .slice(0, 500)
}

// Listing is readable by anyone who can read flows: the response is redacted
// (never the secret), and flow authors need the picker, the editor's
// UNKNOWN_HTTP_CREDENTIAL validation, and the credentials bank to work without
// admin rights. Owners may create, rotate, verify, and delete their own rows;
// workspace administrators retain access to every row.
export const GET = withAuthenticatedApi(async (request, auth) => {
  // `scope=bindable` is what a flow editor's credential picker asks for: the
  // credentials this person may ATTACH to a step. Everything else (the
  // credentials inventory page) still lists the whole workspace, because
  // seeing that a credential exists is not the same as being able to act with
  // it — and hiding them would make the inventory lie.
  //
  // Binding rights were previously identical to flow-edit rights: any member
  // who could open a flow could attach any workspace credential to a step and
  // act as it. Host-binding stopped them pointing it somewhere new, but not
  // from using it.
  const bindableOnly = new URL(request.url).searchParams.get('scope') === 'bindable'

  const credentials = await prisma.httpCredential.findMany({
    where: {
      organizationId: auth.organizationId,
      // Own credentials, plus the legacy workspace-shared ones (userId null),
      // which stay bindable so this does not break every flow that already
      // uses them. They are flagged "Unowned" for exactly that reason.
      ...(bindableOnly ? { OR: [{ userId: auth.dbUser.id }, { userId: null }] } : {}),
    },
    orderBy: [{ name: 'asc' }, { createdAt: 'desc' }],
    include: { secretReferences: { select: { field: true, providerId: true, path: true, property: true, version: true } } },
  })
  return {
    success: true,
    credentials: credentials.map((row) => ({
      ...redactedCredential(row),
      // Surfaced so the page can mark legacy workspace-shared rows: an
      // unowned credential is one no offboarding can revoke.
      userId: row.userId,
      isSharedLegacy: row.userId === null,
      externalFields: row.secretReferences.map((ref) => ref.field),
      externalProviderIds: [...new Set(row.secretReferences.map((ref) => ref.providerId))],
      ...(auth.can('integration.manage') ? {
        secretRefs: Object.fromEntries(row.secretReferences.map((ref) => [ref.field, {
          providerId: ref.providerId,
          path: ref.path,
          ...(ref.property ? { property: ref.property } : {}),
          ...(ref.version ? { version: ref.version } : {}),
        }])),
      } : {}),
    })),
  }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const payload = payloadSchema.parse(await request.json())
  const existing = payload.id
    ? await prisma.httpCredential.findFirst({
        where: { id: payload.id, organizationId: auth.organizationId },
        include: { secretReferences: { select: { id: true }, take: 1 } },
      })
    : null
  if (payload.id && !existing) throw new ApiError('Credential not found.', 404, 'NOT_FOUND')
  if (existing && existing.userId !== auth.dbUser.id && !auth.can('integration.manage')) {
    throw new ApiError('You can rotate only your own credential.', 403, 'CREDENTIAL_OWNER_REQUIRED')
  }
  const target = new URL(payload.url)
  await assertPublicUrl(target.toString())
  const references = validatedReferences(payload.authType as HttpAuthType, payload.secretRefs)
  if ((Object.keys(references).length > 0 || existing?.secretReferences.length) && !auth.can('integration.manage')) {
    throw new ApiError('External secret references require integration administrator access.', 403, 'EXTERNAL_SECRET_ADMIN_REQUIRED')
  }
  let externalValues: Record<string, string> = {}
  try {
    externalValues = await resolveExternalSecretInputs(auth.organizationId, auth.dbUser.id, references)
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Could not resolve the external secret.',
      422,
      'EXTERNAL_SECRET_RESOLUTION_FAILED',
    )
  }
  const resolvedConfig = { ...payload.config, ...externalValues } as HttpCredentialConfig

  await verifyCredentialLive({
    ...(payload.id ? { id: payload.id } : {}),
    name: payload.name,
    authType: payload.authType as HttpAuthType,
    allowedHost: target.hostname.toLowerCase(),
    url: target.toString(),
    method: payload.method,
    config: resolvedConfig,
    externalFields: Object.keys(references),
  })

  // Referenced values are present only in `resolvedConfig` above. Remove their
  // fields from the locally encrypted payload so Postgres never becomes a
  // second copy of a secret whose source of truth is external.
  const localConfig = { ...payload.config }
  for (const field of Object.keys(references)) delete localConfig[field]

  const data = {
    name: payload.name,
    authType: payload.authType,
    allowedHost: target.hostname.toLowerCase(),
    secretConfig: encryptSecret(JSON.stringify(localConfig)),
    status: 'verified',
    lastVerifiedAt: new Date(),
    // Both create and update re-encrypt the whole payload, so either way the
    // secret is new material as of now. This is what staleness is measured from.
    lastRotatedAt: new Date(),
    lastError: null,
  }
  const credential = await tenantTransaction(auth.organizationId, async (tx) => {
    const row = payload.id
      ? await tx.httpCredential.update({
          where: { id: payload.id, organizationId: auth.organizationId },
          data,
        })
      : await tx.httpCredential.create({
          // Owned by its creator from the start. A credential nobody owns is one
          // no offboarding can revoke and no audit entry can attribute.
          data: { organizationId: auth.organizationId, userId: auth.dbUser.id, ...data },
        })
    await tx.httpCredentialSecretReference.deleteMany({
      where: { organizationId: auth.organizationId, credentialId: row.id },
    })
    if (Object.keys(references).length) {
      await tx.httpCredentialSecretReference.createMany({
        data: Object.entries(references).map(([field, ref]) => ({
          organizationId: auth.organizationId,
          credentialId: row.id,
          field,
          providerId: ref.providerId,
          path: ref.path,
          property: ref.property ?? null,
          version: ref.version ?? null,
        })),
      })
    }
    return row
  })

  // Updating an existing row REPLACES its secret material (the whole payload is
  // re-encrypted above), so it is a rotation — not a config edit.
  const record = payload.id ? recordCredentialRotation : recordCredentialGrant
  await record({
    organizationId: auth.organizationId,
    kind: 'http_credential',
    credentialId: credential.id,
    provider: credential.allowedHost,
    actorUserId: auth.userId,
    method: `http_${credential.authType}`,
  })

  return { success: true, credential: redactedCredential(credential) }
}, { permission: 'flow.run' })

// Re-verify a stored credential without re-entering its secrets. The picker
// calls this to confirm a credential still works (e.g. after a run flagged it).
const reverifySchema = z.object({
  id: z.string().trim().min(1),
  url: z.string().url().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const payload = reverifySchema.parse(await request.json())
  const row = await prisma.httpCredential.findFirst({
    where: { id: payload.id, organizationId: auth.organizationId },
  })
  if (!row) throw new ApiError('Credential not found.', 404, 'NOT_FOUND')
  if (row.userId !== auth.dbUser.id && !auth.can('integration.manage')) {
    throw new ApiError('You can verify only your own credential.', 403, 'CREDENTIAL_OWNER_REQUIRED')
  }

  let config: HttpCredentialConfig
  let externalFields: string[] = []
  let localConfig: HttpCredentialConfig
  try {
    localConfig = JSON.parse(decryptSecret(row.secretConfig)) as HttpCredentialConfig
  } catch {
    throw new ApiError('The stored credential could not be decrypted. Recreate it.', 422, 'CREDENTIAL_DECRYPT_FAILED')
  }
  try {
    const resolved = await resolveHttpCredentialSecretReferences(auth.organizationId, row.id, localConfig, {
      actorUserId: auth.dbUser.id,
      consumer: 'http_credential.verify',
    })
    config = resolved.config
    externalFields = resolved.externalFields
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'The external secret could not be resolved.',
      422,
      'EXTERNAL_SECRET_RESOLUTION_FAILED',
    )
  }

  // Verify against the same host the credential is bound to; the caller may
  // pass the node's URL/method for a more representative probe.
  const url = payload.url && new URL(payload.url).hostname.toLowerCase() === row.allowedHost
    ? payload.url
    : `https://${row.allowedHost}/`
  await assertPublicUrl(url)

  try {
    await verifyCredentialLive({
      id: row.id,
      name: row.name,
      authType: row.authType as HttpAuthType,
      allowedHost: row.allowedHost,
      url,
      method: payload.method,
      config,
      externalFields,
    })
  } catch (error) {
    const message = error instanceof ApiError ? error.message : safeError(error)
    await prisma.httpCredential.update({
      where: { id: row.id, organizationId: auth.organizationId },
      data: { status: 'error', lastError: message.slice(0, 500) },
    })
    throw error
  }

  const credential = await prisma.httpCredential.update({
    where: { id: row.id, organizationId: auth.organizationId },
    data: { status: 'verified', lastError: null, lastVerifiedAt: new Date() },
  })
  return { success: true, credential: redactedCredential(credential) }
}, { permission: 'flow.run' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).searchParams.get('id')
  if (!id) throw new ApiError('Credential id is required.', 400, 'MISSING_ID')
  const deleted = await prisma.httpCredential.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, allowedHost: true, userId: true },
  })
  if (deleted && deleted.userId !== auth.dbUser.id && !auth.can('integration.manage')) {
    throw new ApiError('You can delete only your own credential.', 403, 'CREDENTIAL_OWNER_REQUIRED')
  }
  await prisma.httpCredential.deleteMany({ where: { id, organizationId: auth.organizationId } })

  // Deleting a credential IS a revocation — the flows bound to it stop
  // authenticating. It belongs in the same log as every other revoke so
  // "when did this stop working, and who did it" has one answer.
  if (deleted) {
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'credential.revoked',
      actorUserId: auth.userId,
      resourceType: 'http_credential',
      resourceId: deleted.id,
      detail: { provider: deleted.allowedHost, reason: 'deleted_by_user' },
    })
  }
  return { success: true }
}, { permission: 'flow.run' })
