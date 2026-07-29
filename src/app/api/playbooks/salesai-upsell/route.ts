import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { buildUpsellGraph, PLAYBOOK_AGENTS, PLAYBOOK_FLOW_NAME } from '@/lib/playbooks/salesai-upsell'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * One-click provisioning of the SalesAI Upsell Engine playbook (BRD): creates
 * the three agents and the wired Flow. Idempotent — re-running reuses agents
 * matched by title and returns the existing flow instead of duplicating.
 */
export const POST = withAuthenticatedApi(async (_request, auth) => {
  // Reuse an existing playbook flow if one is already provisioned.
  const existingFlow = await prisma.flow.findFirst({
    where: { organizationId: auth.organizationId, name: PLAYBOOK_FLOW_NAME },
    select: { id: true },
  })
  if (existingFlow) return { success: true, flowId: existingFlow.id, created: false }

  // Create (or reuse, matched by title) each playbook agent.
  const agentIds: Record<string, string> = {}
  for (const [key, def] of Object.entries(PLAYBOOK_AGENTS)) {
    const existing = await prisma.agentTask.findFirst({
      where: {
        organizationId: auth.organizationId,
        status: { not: 'DELETED' },
        metadata: { path: ['title'], equals: def.title },
      },
      select: { id: true },
    })
    if (existing) {
      agentIds[key] = existing.id
      continue
    }
    const agent = await prisma.agentTask.create({
      data: {
        type: 'agent',
        agentType: 'CUSTOM',
        priority: 'HIGH',
        description: def.description,
        objective: def.instructions,
        context: {},
        schedule: { type: 'manual', timezone: 'UTC', isActive: false },
        status: 'ACTIVE',
        folder: 'SalesAI Upsell',
        visibility: 'shared',
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        metadata: {
          title: def.title,
          description: def.description,
          model: DEFAULT_AGENT_MODEL,
          integrations: [...def.integrations],
          skills: [],
          icon: '',
        },
      },
    })
    await syncAgentConnectors(agent.id, auth.organizationId, [...def.integrations])
    agentIds[key] = agent.id
  }

  const graph = buildUpsellGraph({
    puller: agentIds.puller,
    scorer: agentIds.scorer,
    composer: agentIds.composer,
    publisher: agentIds.publisher,
  })
  const flow = await prisma.flow.create({
    data: {
      name: PLAYBOOK_FLOW_NAME,
      description:
        'BRD playbook: pull in-segment accounts (Backstory + Snowflake), score each for SalesAI readiness in parallel, post the top-20 motion brief to Slack.',
      status: 'DRAFT',
      trigger: { type: 'manual' },
      graph: jsonValue(graph),
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    },
  })
  return { success: true, flowId: flow.id, created: true }
}, { permission: 'agent.run' })
