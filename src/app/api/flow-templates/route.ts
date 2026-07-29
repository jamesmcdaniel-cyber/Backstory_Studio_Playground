import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowGraphSchema } from '@/lib/flows/graph'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { createFlowTemplate } from '@/lib/flows/templates/create'
import { listFlowTemplateCatalogue, serializeFlowTemplate } from '@/lib/flows/templates/catalogue'
import {
  flowTemplateBindingSchema,
  flowTemplateNotesIssues,
  flowTemplateNotesSchema,
} from '@/lib/flows/templates/types'

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.string().default('Custom'),
  graph: flowGraphSchema,
  notes: flowTemplateNotesSchema,
  bindings: z.array(flowTemplateBindingSchema).default([]),
  integrations: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  icon: z.string().trim().max(8).optional(),
  exampleOutput: z.string().optional(),
})

export const GET = withAuthenticatedApi(async (request, auth) => {
  const templates = await listFlowTemplateCatalogue(auth.organizationId)
  const limit = Number(request.nextUrl.searchParams.get('limit'))
  return { success: true, templates: limit > 0 ? templates.slice(0, limit) : templates }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = templateSchema.parse(await request.json())
  // The notes-to-graph contract is the whole point of a flow template — a row
  // that violates it renders a detail page with unexplained steps, so reject it
  // at the door rather than letting it into the catalogue.
  const issues = flowTemplateNotesIssues(data.graph, data.notes, data.bindings)
  if (issues.length) throw new ApiError(issues[0], 400, 'INCOMPLETE_TEMPLATE_NOTES')

  const template = await createFlowTemplate({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    name: data.name,
    description: data.description,
    category: data.category,
    graph: data.graph,
    notes: data.notes,
    bindings: data.bindings,
    integrations: data.integrations,
    tags: data.tags,
    icon: data.icon,
    exampleOutput: data.exampleOutput,
    authorName: auth.dbUser.name || auth.dbUser.email || '',
    // Catalogue visibility is SERVER-controlled: a template is org-scoped until
    // a reviewer publishes it from an approved CatalogueSubmission. There is no
    // request body that can put a row in the shared catalogue.
    visibility: 'org',
  })
  return { success: true, template: serializeFlowTemplate(template, auth.organizationId) }
}, { permission: 'template.author' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(templateSchema.partial()).parse(await request.json())
  const existing = await prisma.flowTemplate.findFirst({ where: { id: body.id, organizationId: auth.organizationId } })
  if (!existing) throw new ApiError('Flow template not found', 404, 'NOT_FOUND')

  const config = (existing.configuration && typeof existing.configuration === 'object' ? existing.configuration : {}) as Record<string, unknown>
  const template = await prisma.flowTemplate.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.category !== undefined && { category: body.category }),
      // Trigger follows the graph — never set independently, so they can't drift.
      ...(body.graph !== undefined && {
        graph: JSON.parse(JSON.stringify(body.graph)),
        trigger: JSON.parse(JSON.stringify(triggerFromGraph(body.graph))),
      }),
      ...(body.notes !== undefined && { notes: JSON.parse(JSON.stringify(body.notes)) }),
      ...(body.bindings !== undefined && { bindings: JSON.parse(JSON.stringify(body.bindings)) }),
      // No visibility passthrough: an update cannot promote a template into
      // the shared catalogue. Only the reviewer publish path writes 'global'.
      configuration: {
        ...config,
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...(body.tags !== undefined && { tags: body.tags }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.exampleOutput !== undefined && { exampleOutput: body.exampleOutput }),
      },
    },
  })
  return { success: true, template: serializeFlowTemplate(template, auth.organizationId) }
}, { permission: 'template.author' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.flowTemplate.deleteMany({ where: { id, organizationId: auth.organizationId } })
  if (!result.count) throw new ApiError('Flow template not found', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'template.author' })
