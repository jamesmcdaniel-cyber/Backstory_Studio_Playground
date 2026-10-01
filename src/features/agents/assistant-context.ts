import type { AgentTask } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { retrieveContext, renderContext } from '@/lib/rag/retrieve'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { loadPeopleAiPlaneGroup } from '@/features/agents/tool-planes'
import { withinBudget } from '@/lib/async-budget'

/**
 * Server-side context assembly for the agent-scoped assistant chat. Pulls the
 * agent's configuration plus its recent run history (with tool calls and the
 * latest failure's error detail) into a compact JSON blob the model can ground
 * its answers in. Long values are clipped so a big run output cannot blow the
 * prompt budget.
 */

const RECENT_RUN_LIMIT = 8

function clip(value: unknown, max = 1200): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

type ExecutionRow = {
  id: string
  status: string
  error: string | null
  output: unknown
  metadata: unknown
  startedAt: Date
  completedAt: Date | null
}

function metadataOf(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

function summarizeRun(execution: ExecutionRow) {
  const metadata = metadataOf(execution.metadata)
  return {
    id: execution.id,
    status: execution.status,
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt ? execution.completedAt.toISOString() : null,
    headline: typeof metadata.headline === 'string' ? metadata.headline : null,
    error: clip(execution.error, 1500) || null,
    output: clip(execution.output, 2000) || null,
  }
}

export type AssistantContext = {
  agent: {
    id: string
    title: string
    description: string
    instructions: string
    model: string | null
    integrations: string[]
    skills: string[]
    schedule: unknown
    status: string
  }
  recentRuns: ReturnType<typeof summarizeRun>[]
  latestRun: (ReturnType<typeof summarizeRun> & { toolCalls: unknown[]; conversation: unknown[] }) | null
  latestFailedRun: (ReturnType<typeof summarizeRun> & { toolCalls: unknown[]; conversation: unknown[] }) | null
  /** Live Backstory MCP catalog, scoped to the viewing user and organization. */
  backstoryTools: { name: string; description: string }[]
  /** Graph-RAG correlated context (Sales AI signals, integration data, related runs). Empty string when RAG is unconfigured. */
  correlated: string
}

/**
 * Graph-RAG context for an assistant question about this agent. Seeds expansion
 * from the agent node so answers can reference correlated Sales AI signals and
 * prior cross-agent runs. Best-effort — returns '' when embeddings/store are
 * unconfigured or on any failure.
 */
async function correlatedContext(agent: AgentTask, question: string, viewerUserId: string | null): Promise<string> {
  try {
    const context = await retrieveContext(getGraphRagStore(), {
      organizationId: agent.organizationId,
      // The user asking is the viewer — scope to shared data + their own private
      // nodes so the assistant never surfaces another rep's private book.
      viewerUserId,
      query: `${question}\n${agent.objective}`.slice(0, 2000),
      seedNodeIds: [`agent:${agent.id}`],
    })
    return renderContext(context)
  } catch {
    return ''
  }
}

export async function buildAssistantContext(agent: AgentTask, question = '', viewerUserId: string | null = null): Promise<AssistantContext> {
  // Start optional external context alongside DB reads; don't add a second
  // waterfall or block configuration/debugging answers on a remote outage.
  const extraContext = Promise.all([
    withinBudget(correlatedContext(agent, question, viewerUserId), 2000, ''),
    withinBudget(loadPeopleAiPlaneGroup(agent.organizationId, viewerUserId), 2000, null),
  ])
  const executions = await prisma.agentExecution.findMany({
    where: { agentTaskId: agent.id, organizationId: agent.organizationId },
    omit: { transcript: true },
    orderBy: { startedAt: 'desc' },
    take: RECENT_RUN_LIMIT,
  })

  const latest = executions[0]
  const latestFailed = executions.find((execution) => execution.status === 'failed')
  const detailIds = [...new Set([latest?.id, latestFailed?.id].filter((id): id is string => Boolean(id)))]

  const [steps, messages] = detailIds.length
    ? await Promise.all([
        prisma.workflowStep.findMany({
          where: { executionId: { in: detailIds } },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.executionMessage.findMany({
          where: { executionId: { in: detailIds } },
          orderBy: { createdAt: 'asc' },
        }),
      ])
    : [[], []]

  const detailFor = (execution: ExecutionRow) => ({
    ...summarizeRun(execution),
    toolCalls: steps
      .filter((step) => step.executionId === execution.id)
      .map((step) => ({
        tool: step.node,
        status: step.status,
        input: clip(step.input, 600) || null,
        output: clip(step.output, 800) || null,
        error: clip(step.error, 800) || null,
      })),
    conversation: messages
      .filter((message) => message.executionId === execution.id)
      .map((message) => ({ role: message.role, content: clip(message.content, 600) })),
  })

  const agentMetadata = readAgentMetadata(agent.metadata)
  const [correlated, peopleAiGroup] = await extraContext

  return {
    agent: {
      id: agent.id,
      title: agentMetadata.title || agent.description.split('\n')[0] || 'Untitled agent',
      description: agentMetadata.description || agent.description,
      instructions: agent.objective,
      model: agentMetadata.model || null,
      integrations: agentMetadata.integrations || [],
      skills: agentMetadata.skills || [],
      schedule: agent.schedule,
      status: agent.status.toLowerCase(),
    },
    recentRuns: executions.map(summarizeRun),
    latestRun: latest ? detailFor(latest) : null,
    latestFailedRun: latestFailed ? detailFor(latestFailed) : null,
    backstoryTools: (peopleAiGroup?.tools ?? []).map(({ name, description }) => ({ name, description })),
    correlated,
  }
}
