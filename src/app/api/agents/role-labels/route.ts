import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { generateStructured } from '@/lib/llm/model-runner'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { sanitizeRoleLabel } from '@/lib/agents/role-label'
import { UNTRUSTED_DATA_RULE, fenceUntrusted } from '@/lib/security/prompt'
import { assertAiCallAllowed } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'

/**
 * Lazy backfill for the gallery's 1–2 word role labels. The gallery posts the
 * ids it's showing; agents that already carry `metadata.roleLabel` are returned
 * as-is, the rest get one batched model call (not one per agent) and the result
 * is persisted so the label is generated once per agent, not once per page view.
 *
 * Titles/descriptions/instructions are user-authored — attacker-influenceable
 * by definition in a shared workspace — so they go in fenced, and the output is
 * clamped by sanitizeRoleLabel before it's stored or rendered.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { agentIds } = z.object({ agentIds: z.array(z.string().min(1)).min(1).max(100) }).parse(await request.json())

  const agents = await prisma.agentTask.findMany({
    where: {
      id: { in: agentIds },
      organizationId: auth.organizationId,
      status: { not: 'DELETED' },
      ...agentVisibilityScope(auth.dbUser.id),
    },
    select: { id: true, description: true, objective: true, metadata: true },
  })

  const labels: Record<string, string> = {}
  const missing: typeof agents = []
  for (const agent of agents) {
    const existing = sanitizeRoleLabel(readAgentMetadata(agent.metadata).roleLabel)
    if (existing) labels[agent.id] = existing
    else missing.push(agent)
  }
  if (!missing.length) return { success: true, labels }

  // Gate only when a model call is actually about to happen — a fully-labeled
  // gallery poll must not burn the caller's AI rate budget.
  await assertAiCallAllowed({
    organizationId: auth.organizationId,
    rateKey: `role-labels:${auth.dbUser.id}`,
    limit: 6,
  })

  const roster = missing
    .map((agent, index) => {
      const metadata = readAgentMetadata(agent.metadata)
      const title = metadata.title || agent.description.split('\n')[0] || 'Untitled agent'
      const description = (metadata.description || agent.description || '').slice(0, 300)
      const instructions = (agent.objective || '').slice(0, 400)
      return `Agent ${index + 1}:\nName: ${title}\nDescription: ${description}\nInstructions: ${instructions}`
    })
    .join('\n\n')

  const text = await generateStructured({
    schemaName: 'agent_role_labels',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        labels: {
          type: 'array',
          items: { type: 'string', description: 'A 1-2 word job title, e.g. "Deal Researcher".' },
          minItems: missing.length,
          maxItems: missing.length,
          description: 'One label per agent, in the same order the agents were listed.',
        },
      },
      required: ['labels'],
    },
    system: [
      'You write job titles for AI agents on a team roster. For each agent described, produce a 1-2 word role that says WHAT IT DOES — like a coworker\'s job title ("Deal Researcher", "Pipeline Reporter", "Meeting Scribe").',
      'Base the role on the instructions, not the agent\'s self-chosen name — names are often vague or stale.',
      'Return exactly one label per agent, in order. No punctuation, no numbering.',
      UNTRUSTED_DATA_RULE,
    ].join('\n'),
    user: fenceUntrusted('agent roster', roster),
    maxTokens: 800,
  })
  if (text) {
    // Rough metering (~chars/4), same convention as the draft builder.
    void recordTokenUsage(auth.organizationId, Math.ceil((roster.length + text.length) / 4)).catch(() => undefined)
    let generated: string[] = []
    try {
      generated = (JSON.parse(text) as { labels?: unknown }).labels as string[] ?? []
    } catch {
      generated = []
    }
    await Promise.all(missing.map((agent, index) => {
      const label = sanitizeRoleLabel(generated[index])
      if (!label) return Promise.resolve()
      labels[agent.id] = label
      const metadata = agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata) ? agent.metadata : {}
      return prisma.agentTask.update({
        where: { id: agent.id, organizationId: auth.organizationId },
        data: { metadata: { ...metadata, roleLabel: label } },
      })
    }))
  }

  return { success: true, labels }
}, { permission: 'agent.read' })
