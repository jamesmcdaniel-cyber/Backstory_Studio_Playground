import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  HTTP_AUTH_TYPES,
  fetchWithHttpCredential,
  redactedCredential,
  type HttpAuthType,
  type HttpCredentialConfig,
} from '@/features/flows/http-auth'

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
})

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Credential verification failed.'
  return message
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/(token|secret|password|key)=([^&\s]+)/gi, '$1=[redacted]')
    .slice(0, 500)
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const credentials = await prisma.httpCredential.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: [{ name: 'asc' }, { createdAt: 'desc' }],
  })
  return { success: true, credentials: credentials.map(redactedCredential) }
}, { permission: 'integration.manage' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const payload = payloadSchema.parse(await request.json())
  const target = new URL(payload.url)
  await assertPublicUrl(target.toString())

  await verifyCredentialLive({
    ...(payload.id ? { id: payload.id } : {}),
    name: payload.name,
    authType: payload.authType as HttpAuthType,
    allowedHost: target.hostname.toLowerCase(),
    url: target.toString(),
    method: payload.method,
    config: payload.config as HttpCredentialConfig,
  })

  const data = {
    name: payload.name,
    authType: payload.authType,
    allowedHost: target.hostname.toLowerCase(),
    secretConfig: encryptSecret(JSON.stringify(payload.config)),
    status: 'verified',
    lastVerifiedAt: new Date(),
    lastError: null,
  }
  const credential = payload.id
    ? await prisma.httpCredential.update({
        where: { id: payload.id, organizationId: auth.organizationId },
        data,
      })
    : await prisma.httpCredential.create({
        data: { organizationId: auth.organizationId, ...data },
      })
  return { success: true, credential: redactedCredential(credential) }
}, { permission: 'integration.manage' })

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

  let config: HttpCredentialConfig
  try {
    config = JSON.parse(decryptSecret(row.secretConfig)) as HttpCredentialConfig
  } catch {
    throw new ApiError('The stored credential could not be decrypted. Recreate it.', 422, 'CREDENTIAL_DECRYPT_FAILED')
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
}, { permission: 'integration.manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).searchParams.get('id')
  if (!id) throw new ApiError('Credential id is required.', 400, 'MISSING_ID')
  await prisma.httpCredential.deleteMany({ where: { id, organizationId: auth.organizationId } })
  return { success: true }
}, { permission: 'integration.manage' })
