import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowGraphSchema } from '@/lib/flows/graph'
import { draftFlowTemplateNotes } from '@/lib/flows/templates/draft-notes'
import { loadBindingContext } from '@/lib/flows/templates/instantiate'
import { assertAiCallAllowed, recordEstimatedUsage } from '@/lib/usage/ai-guard'

export const runtime = 'nodejs'
export const maxDuration = 60

const bodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  graph: flowGraphSchema,
})

// POST /api/flow-templates/draft-notes — read a graph and draft the notes that
// explain it. Nothing is saved; the user edits the draft in the Save-as-template
// dialog and the POST to /api/flow-templates is what persists it.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json())
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `flow-template-notes:${auth.dbUser.id}`, limit: 6 })

  const context = await loadBindingContext(auth.organizationId, auth.dbUser.id)
  const { notes, bindings, rawParts } = await draftFlowTemplateNotes(body.graph, {
    name: body.name,
    description: body.description,
    agents: context.agents,
  })
  recordEstimatedUsage(auth.organizationId, ...rawParts)
  return { success: true, notes, bindings }
}, { permission: 'template.author' })
