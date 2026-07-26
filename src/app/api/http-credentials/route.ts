import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { encryptSecret } from '@/lib/crypto/secrets'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  HTTP_AUTH_TYPES,
  fetchWithHttpCredential,
  redactedCredential,
  type HttpAuthType,
  type HttpCredentialConfig,
} from '@/features/flows/http-auth'

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
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const payload = payloadSchema.parse(await request.json())
  const target = new URL(payload.url)
  await assertPublicUrl(target.toString())

  try {
    const response = await fetchWithHttpCredential(
      {
        url: target.toString(),
        init: { method: payload.method, redirect: 'error' },
      },
      {
        ...(payload.id ? { id: payload.id } : {}),
        name: payload.name,
        authType: payload.authType as HttpAuthType,
        allowedHost: target.hostname.toLowerCase(),
        config: payload.config as HttpCredentialConfig,
      },
    )
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(
        `The API rejected these credentials with HTTP ${response.status}.`,
        422,
        'CREDENTIAL_REJECTED',
      )
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(
      `Could not verify the credential: ${safeError(error)}`,
      422,
      'CREDENTIAL_VERIFICATION_FAILED',
    )
  }

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
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).searchParams.get('id')
  if (!id) throw new ApiError('Credential id is required.', 400, 'MISSING_ID')
  await prisma.httpCredential.deleteMany({ where: { id, organizationId: auth.organizationId } })
  return { success: true }
})
