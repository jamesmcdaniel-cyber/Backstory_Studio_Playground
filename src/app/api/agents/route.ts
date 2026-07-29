import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { serializeAgent } from '@/lib/agents/serialize'
import { indexAgent, removeAgentFromGraph } from '@/lib/rag/indexer'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'

/** Best-effort graph-RAG indexing of an agent node (gated on embeddings). */
function indexAgentRow(agent: { id: string; organizationId: string; objective: string; description: string; metadata: unknown; userId?: string | null; visibility?: string }): Promise<void> {
  const metadata = readAgentMetadata(agent.metadata)
  return indexAgent({
    id: agent.id,
    organizationId: agent.organizationId,
    title: metadata.title || agent.description.split('\n')[0] || 'Untitled agent',
    objective: agent.objective,
    description: metadata.description || agent.description,
    // Per-rep scope: a private agent's node is visible only to its owner.
    ownerUserId: agent.userId ?? null,
    visibility: agent.visibility === 'private' ? 'private' : 'shared',
  }).catch(() => undefined)
}

const scheduleSchema = z.object({
  type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron', 'once']).default('manual'),
  time: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().default('UTC'),
  // YYYY-MM-DD calendar date for a one-time ('once') run, paired with `time`.
  runAt: z.string().optional(),
  isActive: z.boolean().default(false),
})

const agentSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  instructions: z.string().min(1),
  model: z.string().default(DEFAULT_AGENT_MODEL),
  priority: z.string().default('medium'),
  integrations: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  folder: z.string().trim().max(60).nullish(),
  visibility: z.enum(['shared', 'private']).default('shared'),
  icon: z.string().trim().max(8).optional(),
  // Lets this agent delegate to other agents via the run_agent tool (pipelines).
  allowSubagents: z.boolean().optional(),
  // Restrict which agents it may run. Empty/omitted = any visible agent.
  subagentIds: z.array(z.string()).optional(),
  // Lets this agent run published flows via the run_flow tool.
  allowFlows: z.boolean().optional(),
  // Restrict which flows it may run. Empty/omitted = any visible published flow.
  flowIds: z.array(z.string()).optional(),
  // The outcome this agent ultimately serves — steers every run + self-evaluation.
  goal: z.string().max(2000).nullable().optional(),
  // When true, a question closely matching a past answer is auto-answered from memory.
  autoAnswerFromMemory: z.boolean().optional(),
  // When true, every run starts with an explicit numbered plan before any tool call.
  alwaysStrategize: z.boolean().optional(),
  // When true, this agent's outbound writes (Slack/Gmail/Salesforce delivery) are
  // queued for human approval instead of executing inline. Defaults to off, so
  // existing agents keep their current behavior.
  requireApproval: z.boolean().optional(),
  schedule: scheduleSchema.default({ type: 'manual', timezone: 'UTC', isActive: false }),
})

// serializeAgent lives in @/lib/agents/serialize so /api/snapshot returns the
// exact same agent shape as this route.

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const agents = await prisma.agentTask.findMany({
    where: {
      organizationId: auth.organizationId,
      status: { not: 'DELETED' },
      ...agentVisibilityScope(auth.dbUser.id),
    },
    orderBy: { updatedAt: 'desc' },
    // Bounded: this list is polled by the sidebar + dashboard; an org with a
    // runaway number of agents must not turn every poll into a full scan.
    take: 300,
  })
  return { success: true, agents: agents.map(serializeAgent) }
}, { permission: 'agent.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = agentSchema.parse(await request.json())
  const agent = await prisma.agentTask.create({
    data: {
      type: 'agent',
      agentType: 'CUSTOM',
      priority: data.priority.toUpperCase(),
      description: data.description || data.title,
      objective: data.instructions,
      context: {},
      schedule: data.schedule,
      status: 'ACTIVE',
      folder: data.folder || null,
      visibility: data.visibility,
      goal: data.goal?.trim() ? data.goal.trim() : null,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      metadata: {
        title: data.title,
        description: data.description,
        model: data.model,
        integrations: data.integrations,
        skills: data.skills,
        icon: data.icon || '',
        allowSubagents: data.allowSubagents === true,
        subagentIds: data.subagentIds ?? [],
        allowFlows: data.allowFlows === true,
        flowIds: data.flowIds ?? [],
        autoAnswerFromMemory: data.autoAnswerFromMemory === true,
        alwaysStrategize: data.alwaysStrategize === true,
        requireApproval: data.requireApproval === true,
      },
    },
  })
  // Project the selection into typed connector bindings (await: a fresh agent
  // has no rows yet, so the very next run must see them, not the fallback).
  await syncAgentConnectors(agent.id, auth.organizationId, data.integrations)
  void indexAgentRow(agent)
  return { success: true, agent: serializeAgent(agent) }
}, { permission: 'agent.write' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(agentSchema.partial()).parse(await request.json())
  const existing = await prisma.agentTask.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  const metadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? existing.metadata : {}
  const agent = await prisma.agentTask.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.description !== undefined && { description: body.description || body.title || existing.description }),
      ...(body.instructions !== undefined && { objective: body.instructions }),
      ...(body.priority !== undefined && { priority: body.priority.toUpperCase() }),
      ...(body.schedule !== undefined && { schedule: body.schedule }),
      ...(body.folder !== undefined && { folder: body.folder || null }),
      ...(body.visibility !== undefined && { visibility: body.visibility }),
      ...(body.goal !== undefined && { goal: body.goal?.trim() ? body.goal.trim() : null }),
      metadata: {
        ...metadata,
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...(body.skills !== undefined && { skills: body.skills }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.allowSubagents !== undefined && { allowSubagents: body.allowSubagents }),
        ...(body.subagentIds !== undefined && { subagentIds: body.subagentIds }),
        ...(body.allowFlows !== undefined && { allowFlows: body.allowFlows }),
        ...(body.flowIds !== undefined && { flowIds: body.flowIds }),
        ...(body.autoAnswerFromMemory !== undefined && { autoAnswerFromMemory: body.autoAnswerFromMemory }),
        ...(body.alwaysStrategize !== undefined && { alwaysStrategize: body.alwaysStrategize }),
        ...(body.requireApproval !== undefined && { requireApproval: body.requireApproval }),
        // A saved NON-EMPTY goal supersedes any prior AI-suggested one; saving
        // other fields with the goal still blank keeps the proposal visible.
        ...(typeof body.goal === 'string' && body.goal.trim() ? { suggestedGoal: undefined } : {}),
      },
    },
  })
  // Re-sync typed connector bindings when the selection changed. Await so a
  // run enqueued right after the edit reads the updated bindings.
  if (body.integrations !== undefined) {
    await syncAgentConnectors(agent.id, auth.organizationId, body.integrations)
  }
  void indexAgentRow(agent)
  return { success: true, agent: serializeAgent(agent) }
}, { permission: 'agent.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.agentTask.updateMany({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    data: { status: 'DELETED' },
  })
  if (!result.count) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  // Purge the agent + its run nodes from the graph so deleted content can't
  // resurface in retrieval. Fire-and-forget; best-effort.
  void removeAgentFromGraph(auth.organizationId, id).catch(() => undefined)
  return { success: true }
}, { permission: 'agent.write' })
