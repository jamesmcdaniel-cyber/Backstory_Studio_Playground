import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { hashToken } from '@/lib/crypto/secrets'

// Returns the agent's webhook trigger secret status, minting one on first call.
// The plaintext secret is only ever returned at creation/rotation time — only a
// SHA-256 hash is stored, so an existing secret can be validated but never
// re-read. Pass { rotate: true } to invalidate the old secret and mint a new one.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const { rotate } = z.object({ rotate: z.boolean().default(false) })
    .parse(await request.json().catch(() => ({})))

  // Private agents: only the owner may mint/rotate the trigger secret.
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, status: { not: 'DELETED' }, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const metadata = agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata)
    ? agent.metadata as Record<string, unknown>
    : {}
  const hasSecret = typeof metadata.triggerSecretHash === 'string' || typeof metadata.triggerSecret === 'string'

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  const base = {
    success: true as const,
    url: `${baseUrl}/api/agents/${agent.id}/trigger`,
    usage: 'POST with header "x-trigger-secret: <secret>" and optional JSON body {"input": "..."}',
  }

  if (hasSecret && !rotate) {
    // Secret already exists and we never stored the plaintext — nothing to reveal.
    return { ...base, hasSecret: true, secret: null }
  }

  const secret = randomBytes(24).toString('base64url')
  const nextMetadata = { ...metadata, triggerSecretHash: hashToken(secret) }
  // Drop any legacy plaintext secret from before hashing was introduced.
  delete (nextMetadata as Record<string, unknown>).triggerSecret
  await prisma.agentTask.update({
    where: { id: agent.id, organizationId: auth.organizationId },
    data: { metadata: nextMetadata },
  })

  return { ...base, hasSecret: true, secret }
}, { permission: 'agent.write' })
