import type { Flow } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { loadFlowToolCatalog, type FlowToolCatalogConnection } from '@/lib/flows/tool-catalog'
import { activityMatchColumns, triggerFromGraph } from '@/lib/flows/trigger'
import { validateFlowGraph } from '@/lib/flows/validate'
import { missingIntegrations, provisionAgentFromConfig } from '@/lib/templates/instantiate'
import { BUILTIN_AGENT_SCHEDULES, builtInTemplates } from '@/lib/templates/builtin-agents'
import { withOutputContract } from '@/lib/templates/example-reports'
import { enhanceAutomationInstructions } from '@/lib/templates/automation-assets'
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
type LoadedBindingContext = BindingContext & { toolCatalog: FlowToolCatalogConnection[] }

export async function loadBindingContext(organizationId: string, userId: string): Promise<LoadedBindingContext> {
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
    toolCatalog: connections,
  }
}

/**
 * Built-in flows are allowed to depend on built-in agents. Importing the flow
 * provisions any missing dependency into the same workspace, so "Use flow"
 * never leaves a permanently empty agent step merely because the user did not
 * know there was a second catalogue item to install first.
 */
async function provisionMissingBuiltinAgents(
  organizationId: string,
  userId: string,
  bindings: FlowTemplateBinding[],
  context: LoadedBindingContext,
): Promise<void> {
  const existing = new Set(context.agents.map((agent) => agent.name.trim().toLowerCase()))
  const wanted = [...new Set(bindings
    .filter((binding) => binding.kind === 'agent')
    .map((binding) => binding.match.agentName?.trim())
    .filter((name): name is string => Boolean(name)))]

  for (const name of wanted) {
    if (existing.has(name.toLowerCase())) continue
    const template = builtInTemplates.find((entry) => entry.name.trim().toLowerCase() === name.toLowerCase())
    if (!template) continue
    const { agent } = await provisionAgentFromConfig(
      organizationId,
      userId,
      {
        ...template,
        ...(BUILTIN_AGENT_SCHEDULES[template.id] ? { schedule: BUILTIN_AGENT_SCHEDULES[template.id] } : {}),
        instructions: enhanceAutomationInstructions(withOutputContract(template.id, template.instructions)),
      },
      template.name,
      `builtin:${template.id}`,
    )
    context.agents.push({ id: agent.id, name: template.name })
    existing.add(template.name.trim().toLowerCase())
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
  await provisionMissingBuiltinAgents(organizationId, userId, template.bindings as FlowTemplateBinding[], context)
  const resolutions = resolveBindings(template.bindings as FlowTemplateBinding[], context)
  const graph = applyBindings(template.graph, resolutions)

  const validation = validateFlowGraph(graph, {
    agents: context.agents.map((agent) => ({ id: agent.id, title: agent.name })),
    toolCatalog: context.toolCatalog,
    requireRunnable: graph.nodes.length > 1,
  })
  const missing = await missingIntegrations(organizationId, userId, template.integrations)
  const setup = buildSetupChecklist(resolutions, (template.notes as FlowTemplateNotes) ?? null, missing)

  const trigger = triggerFromGraph(graph)
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
      trigger: jsonValue(trigger),
      graph: jsonValue(graph),
      organizationId,
      userId,
      ...activityMatchColumns(trigger),
    },
  })
  return { flow, setup, issues: validation.errors.map((error) => error.message) }
}
