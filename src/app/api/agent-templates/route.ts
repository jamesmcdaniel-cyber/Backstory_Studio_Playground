import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { serializeTemplate, listStoredCatalogue } from '@/lib/templates/catalogue'
import { withOutputContract } from '@/lib/templates/example-reports'
import { builtInTemplates } from '@/lib/templates/builtin-agents'
import { createTemplate } from '@/lib/templates/create-template'
import { enhanceAutomationInstructions } from '@/lib/templates/automation-assets'

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.string().default('Custom'),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  model: z.string().default('gpt-4o'),
  exampleOutput: z.string().optional(),
  icon: z.string().trim().max(8).optional(),
  allowSubagents: z.boolean().optional(),
  visibility: z.enum(['org', 'global']).optional(),
})


export const GET = withAuthenticatedApi(async (request, auth) => {
  // Org's own templates (any visibility) + other orgs' global community
  // templates, ranked own-first; built-ins last. Scoping/prioritization lives
  // in listStoredCatalogue (src/lib/templates/catalogue.ts).
  const stored = await listStoredCatalogue(auth.organizationId)
  const templates = [
    ...stored,
    // The instructions served here are what the detail page shows AND what
    // "Create agent" copies into the agent's objective — so the output contract
    // derived from the template's advertised example is appended here, next to
    // the domain instructions it constrains.
    ...builtInTemplates.map((t) => ({
      ...t,
      instructions: enhanceAutomationInstructions(withOutputContract(t.id, t.instructions)),
      custom: false,
      mine: false,
    })),
  ]
  const limit = Number(request.nextUrl.searchParams.get('limit'))
  return { success: true, templates: limit > 0 ? templates.slice(0, limit) : templates }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = templateSchema.parse(await request.json())
  const template = await createTemplate({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    name: data.name,
    category: data.category,
    description: data.description,
    // New templates default to org-private; the community "Publish" dialog
    // passes visibility: 'global' explicitly.
    visibility: data.visibility ?? 'org',
    configuration: {
      instructions: data.instructions,
      integrations: data.integrations,
      skills: data.skills,
      tags: data.tags,
      model: data.model,
      ...(data.exampleOutput ? { exampleOutput: data.exampleOutput } : {}),
      ...(data.icon ? { icon: data.icon } : {}),
      ...(data.allowSubagents ? { allowSubagents: true } : {}),
      authorName: auth.dbUser.name || auth.dbUser.email || '',
    },
  })
  return { success: true, template: serializeTemplate(template, auth.organizationId) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(templateSchema.partial()).parse(await request.json())
  const existing = await prisma.agentTemplate.findFirst({
    where: { id: body.id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  const config = (existing.configuration && typeof existing.configuration === 'object' ? existing.configuration : {}) as any
  const template = await prisma.agentTemplate.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.category !== undefined && { type: body.category }),
      configuration: {
        ...config,
        ...(body.instructions !== undefined && { instructions: body.instructions }),
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...(body.skills !== undefined && { skills: body.skills }),
        ...(body.tags !== undefined && { tags: body.tags }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.exampleOutput !== undefined && { exampleOutput: body.exampleOutput }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.allowSubagents !== undefined && { allowSubagents: body.allowSubagents }),
      },
      ...(body.visibility !== undefined && { visibility: body.visibility }),
    },
  })
  return { success: true, template: serializeTemplate(template, auth.organizationId) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.agentTemplate.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (!result.count) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  return { success: true }
})
