import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { emptyGraph } from '@/lib/flows/graph'
import { generateFlowGraph } from '@/lib/flows/generate-flow-graph'
import { assertAiCallAllowed, recordEstimatedUsage } from '@/lib/usage/ai-guard'

const requestSchema = z.object({
  description: z.string().min(1),
  currentGraph: z.unknown().optional(),
  issues: z.array(z.string()).max(50).optional(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { description, currentGraph, issues } = requestSchema.parse(await request.json())
  // Gate before any model spend: provider configured, caller under rate limit,
  // workspace under its monthly ceiling. Generation makes up to 3 model calls,
  // so a tighter per-minute limit than plain chat.
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `flow-copilot:${auth.dbUser.id}`, limit: 10 })

  try {
    const { graph, validation, rawParts } = await generateFlowGraph(auth.organizationId, auth.dbUser.id, description, { currentGraph, issues })
    recordEstimatedUsage(auth.organizationId, ...rawParts)
    const needsAttention = [...validation.errors, ...validation.warnings].map((issue) => ({ nodeId: issue.nodeId, message: issue.message }))
    return { success: true, graph, validation, needsAttention }
  } catch (error) {
    // Nothing in generateFlowGraph throws deliberately, so everything landing
    // here is an unexpected failure — a model timeout, a Prisma error, an
    // undici socket error. Their messages carry hosts, connection strings and
    // internal identifiers, and none of them tell the user anything useful, so
    // the real cause goes to the logs and Sentry while the client gets one
    // fixed sentence.
    apiLogger.error('flow copilot generation failed', {
      organizationId: auth.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { path: '/api/flows/copilot' })
    return {
      success: false,
      error: 'Could not generate a runnable flow. Try rephrasing the description.',
      graph: emptyGraph(),
    }
  }
}, { permission: 'flow.write' })
