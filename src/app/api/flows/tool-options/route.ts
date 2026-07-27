import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { prepareToolArgs } from '@/features/flows/tool-args'
import { flowToolOutput } from '@/features/flows/tool-output'
import { pageItems } from '@/lib/flows/http-pagination'

export const runtime = 'nodejs'

const schema = z.object({
  connectionId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  itemsPath: z.string().optional(),
})

/**
 * Run a READ tool and return its result items, for the builder's "pick from a
 * list" resource picker — the loadOptions-style live picker (choose a channel /
 * board / record from the connection instead of typing an id). Read-only: a
 * write tool is refused, so the picker can never fire a side effect.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = schema.parse(await request.json())
  const { plane, ref } = parseFlowToolConnectionId(body.connectionId)
  const executor = await resolveFlowToolExecutor({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    plane,
    ref,
    toolName: body.toolName,
  })
  if (executor.isWrite) {
    return { success: false as const, error: 'Only read actions can populate a picker.' }
  }
  const result = flowToolOutput(await executor.execute(body.toolName, prepareToolArgs(body.args ?? {})))
  const items = pageItems(result, body.itemsPath)
  // Cap what we return to the picker so a large list can't bloat the response.
  return { success: true as const, items: items.slice(0, 200) }
})
