import type { FlowTemplate } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { triggerFromGraph } from '@/lib/flows/trigger'
import type { FlowGraph } from '@/lib/flows/graph'
import type { FlowTemplateBinding, FlowTemplateNotes } from '@/lib/flows/templates/types'

export interface CreateFlowTemplateParams {
  organizationId: string
  userId: string
  name: string
  description: string
  category: string
  graph: FlowGraph
  notes: FlowTemplateNotes
  bindings: FlowTemplateBinding[]
  integrations?: string[]
  tags?: string[]
  icon?: string
  exampleOutput?: string
  authorName?: string
  source?: 'user' | 'ai_generated'
  visibility?: 'org' | 'global'
}

/**
 * The single writer for FlowTemplate rows — the save-as-template route and the
 * proposal-accept path both go through here, so provenance (`source`) and
 * scope (`visibility`) are never left to a caller to remember. The trigger is
 * always derived from the graph rather than passed in, keeping the two from
 * drifting apart the way a hand-set trigger eventually would.
 */
export async function createFlowTemplate(params: CreateFlowTemplateParams): Promise<FlowTemplate> {
  return prisma.flowTemplate.create({
    data: {
      name: params.name,
      description: params.description,
      category: params.category,
      graph: JSON.parse(JSON.stringify(params.graph)),
      trigger: JSON.parse(JSON.stringify(triggerFromGraph(params.graph))),
      notes: JSON.parse(JSON.stringify(params.notes)),
      bindings: JSON.parse(JSON.stringify(params.bindings)),
      configuration: {
        integrations: params.integrations ?? [],
        tags: params.tags ?? [],
        icon: params.icon ?? '',
        exampleOutput: params.exampleOutput ?? '',
        authorName: params.authorName ?? '',
      },
      userId: params.userId,
      organizationId: params.organizationId,
      source: params.source ?? 'user',
      visibility: params.visibility ?? 'org',
    },
  })
}
