import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
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
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not generate a runnable flow.',
      graph: emptyGraph(),
    }
  }
}, { permission: 'flow.write' })
