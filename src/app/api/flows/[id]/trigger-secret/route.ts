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

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  // Compare-and-set on updatedAt. Two editors open on one flow (the step card
  // and the drawer) each auto-mint when they see no secret; a plain
  // read-then-write let both write, the second secret replaced the first, and
  // the editor showing the first one displayed a secret that no longer worked.
  // Now a mint that loses the race re-reads and finds the secret exists.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const flow = await prisma.flow.findFirst({
      where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    })
    if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
    assertFlowEditable(flow, auth.dbUser.id)

    const trigger = (flow.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
    const hasSecret = typeof trigger.webhookSecretHash === 'string'
    const base = {
      success: true as const,
      url: `${baseUrl}/api/flows/${flow.id}/trigger`,
      usage: 'POST with header "x-trigger-secret: <secret>". Send {"input": ...} or any JSON body as the flow input.',
    }

    if (hasSecret && !rotate) {
      return { ...base, hasSecret: true, secret: null }
    }

    const secret = randomBytes(24).toString('base64url')
    const written = await prisma.flow.updateMany({
      where: { id: flow.id, organizationId: auth.organizationId, updatedAt: flow.updatedAt },
      data: { trigger: { ...trigger, type: 'webhook', webhookSecretHash: hashToken(secret) } },
    })
    if (written.count === 1) {
      const updated = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: auth.organizationId }, select: { updatedAt: true } })
      return { ...base, hasSecret: true, secret, updatedAt: updated?.updatedAt }
    }
    // Someone wrote the flow between our read and write: read again.
  }
  throw new ApiError('The flow is being edited right now — try again.', 409, 'FLOW_BUSY')
}, { permission: 'flow.write' })
