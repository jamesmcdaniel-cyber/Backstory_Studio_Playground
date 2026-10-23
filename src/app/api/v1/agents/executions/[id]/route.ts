import { prisma } from '@/lib/prisma'
import { authenticatePublicApi, publicApiJson } from '@/lib/public-api/auth'
import { AGENTS_REPLY_SCOPE, WAITING_FOR_EXTERNAL } from '@/lib/agents/external/types'
import { executionIdFromPath, externalIngressLimited, externalNotFound } from '@/lib/agents/external/public-api'

export const runtime = 'nodejs'

/**
 * GET /api/v1/agents/executions/[id] — where one of THIS agent's tasks stands.
 *
 * For an agent whose reply call failed on the network: a reply token is
 * single-use, so instead of retrying blindly it asks here whether the reply
 * landed (`replyAccepted`). Only its own executions; everything else is 404.
 */
export async function GET(request: Request) {
  const flooded = await externalIngressLimited(request, 'status', 240)
  if (flooded) return flooded
  const auth = await authenticatePublicApi(request, AGENTS_REPLY_SCOPE)
  if (auth instanceof Response) return auth
  const external = await prisma.externalAgent.findFirst({
    where: { organizationId: auth.organizationId, apiKeyId: auth.keyId },
    select: { agentTaskId: true },
  })
  if (!external) return externalNotFound()
  const execution = await prisma.agentExecution.findFirst({
    where: { id: executionIdFromPath(request, false), organizationId: auth.organizationId, agentTaskId: external.agentTaskId },
    select: { id: true, status: true, replyTokenHash: true, replyTokenExpiresAt: true, completedAt: true },
  })
  if (!execution) return externalNotFound()
  const waiting = execution.status === WAITING_FOR_EXTERNAL
  return publicApiJson({
    data: {
      executionId: execution.id,
      status: execution.status,
      // Accepted = the run is past waiting on this agent, or its reply is in
      // and being applied right now.
      replyAccepted: !waiting ? execution.status === 'completed' || execution.status === 'failed' : !execution.replyTokenHash,
      replyExpiresAt: waiting ? execution.replyTokenExpiresAt?.toISOString() ?? null : null,
      completedAt: execution.completedAt?.toISOString() ?? null,
    },
  })
}
