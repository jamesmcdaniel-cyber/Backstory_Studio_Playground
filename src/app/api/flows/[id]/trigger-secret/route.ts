import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { hashToken } from '@/lib/crypto/secrets'

// Read-only status for the builder: does a secret exist, and what is the URL.
// NEVER returns the secret — plaintext exists only in the POST mint/rotate response.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const trigger = (flow.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  return {
    success: true,
    hasSecret: typeof trigger.webhookSecretHash === 'string',
    url: `${baseUrl}/api/flows/${flow.id}/trigger`,
  }
}, { permission: 'flow.write' })

// Mint (or rotate) the flow's webhook trigger secret. Mirrors the agent
// trigger-secret: only a SHA-256 hash is stored (inside flow.trigger), so the
// plaintext is returned exactly once at mint/rotate time.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { rotate } = z.object({ rotate: z.boolean().default(false) }).parse(await request.json().catch(() => ({})))

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, auth.dbUser.id)

  const trigger = (flow.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
  const hasSecret = typeof trigger.webhookSecretHash === 'string'
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  const base = {
    success: true as const,
    url: `${baseUrl}/api/flows/${flow.id}/trigger`,
    usage: 'POST with header "x-trigger-secret: <secret>". Send {"input": ...} or any JSON body as the flow input.',
  }

  if (hasSecret && !rotate) {
    return { ...base, hasSecret: true, secret: null }
  }

  const secret = randomBytes(24).toString('base64url')
  await prisma.flow.update({
    where: { id: flow.id, organizationId: auth.organizationId },
    data: { trigger: { ...trigger, type: 'webhook', webhookSecretHash: hashToken(secret) } },
  })
  return { ...base, hasSecret: true, secret }
}, { permission: 'flow.write' })
