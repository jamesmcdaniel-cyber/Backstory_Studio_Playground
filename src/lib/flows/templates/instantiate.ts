import type { Flow } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { validateFlowGraph } from '@/lib/flows/validate'
import { missingIntegrations } from '@/lib/templates/instantiate'
import {
  applyBindings,
  buildSetupChecklist,
  resolveBindings,
  type BindingContext,
  type FlowTemplateSetupItem,
} from '@/lib/flows/templates/bindings'
import type { FlowTemplateBinding, FlowTemplateNotes, SerializedFlowTemplate } from '@/lib/flows/templates/types'

/**
 * "Use this flow" — turning a template into a live (DRAFT) flow.
 *
 * The flow is ALWAYS created, even when bindings don't resolve. A user seeing
 * the whole wired pipeline with two flagged gaps is far better off than one
 * blocked behind a wizard because they haven't connected Salesforce yet. The
 * unresolved slots come back as a setup checklist, and the flow stays DRAFT so
 * a half-configured pipeline can never fire on a schedule.
 *
 * Node ids are kept as authored: each instantiation is its own graph, so there
 * is nothing to collide with, and the template's per-step notes stay
 * addressable against the created flow.
 */

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** The workspace roster + tool catalog the binding matcher runs against. */
export async function loadBindingContext(organizationId: string, userId: string): Promise<BindingContext> {
  const [agents, connections] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId, status: 'ACTIVE', ...agentVisibilityScope(userId) },
      select: { id: true, description: true, metadata: true },
      take: 100,
    }),
    loadFlowToolCatalog(organizationId, { userId, takeConnections: 25, takeTools: 100 }).catch(() => []),
  ])
  return {
    agents: agents
      .map((agent) => ({ id: agent.id, name: readAgentMetadata(agent.metadata).title || agent.description }))
      .filter((entry) => entry.name),
    connections: connections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      tools: connection.tools.map((tool) => ({ name: tool.name })),
    })),
  }
}

export type InstantiatedFlowTemplate = {
  flow: Flow
  setup: FlowTemplateSetupItem[]
  /** Validation problems on the created graph, for the builder's checker panel. */
  issues: string[]
}

export async function instantiateFlowTemplate(
  organizationId: string,
  userId: string,
  template: Pick<SerializedFlowTemplate, 'name' | 'description' | 'graph' | 'notes' | 'bindings' | 'integrations'> & { icon?: string },
): Promise<InstantiatedFlowTemplate> {
  const context = await loadBindingContext(organizationId, userId)
  const resolutions = resolveBindings(template.bindings as FlowTemplateBinding[], context)
  const graph = applyBindings(template.graph, resolutions)

  const validation = validateFlowGraph(graph, {
    agents: context.agents.map((agent) => ({ id: agent.id, title: agent.name })),
    requireRunnable: graph.nodes.length > 1,
  })
  const missing = await missingIntegrations(organizationId, userId, template.integrations)
  const setup = buildSetupChecklist(resolutions, (template.notes as FlowTemplateNotes) ?? null, missing)

  const flow = await prisma.flow.create({
    data: {
      name: template.name,
      description: template.description,
      // The template's emoji follows the flow so cards stay tellable apart.
      icon: template.icon ?? '',
      // Always DRAFT: a template's trigger may be a schedule, and a flow with
      // unfilled slots must never start firing on its own.
      status: 'DRAFT',
      visibility: 'shared',
      trigger: jsonValue(triggerFromGraph(graph)),
      graph: jsonValue(graph),
      organizationId,
      userId,
    },
  })
  return { flow, setup, issues: validation.errors.map((error) => error.message) }
}
