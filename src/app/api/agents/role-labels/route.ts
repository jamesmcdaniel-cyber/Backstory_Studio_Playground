import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { generateStructured } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { sanitizeRoleLabel } from '@/lib/agents/role-label'
import { UNTRUSTED_DATA_RULE, fenceUntrusted } from '@/lib/security/prompt'
import { assertAiCallAllowed } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'

/**
 * Lazy backfill for the gallery's 1–2 word role labels, for both kinds of card:
 * a solo agent, and a teammate avatar that fronts a group of agents.
 *
 * The gallery posts the ids it's showing; anything already carrying a label is
 * returned as-is and the rest are labeled in ONE batched model call (not one
 * per card), then persisted — so a label costs a model call once per subject,
 * not once per page view.
 *
 * Names, descriptions and instructions are user-authored, and in a shared
 * workspace that makes them attacker-influenceable, so they go in fenced and
 * every answer is clamped by sanitizeRoleLabel before it is stored or rendered.
 */

/** One thing to be labeled, plus how it gets described to the model. */
type Subject = { kind: 'agent' | 'teammate'; id: string; block: string }

function agentTitle(agent: { description: string; metadata: unknown }) {
  return readAgentMetadata(agent.metadata).title || agent.description.split('\n')[0] || 'Untitled agent'
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { agentIds, teammateIds } = z
    .object({
      agentIds: z.array(z.string().min(1)).max(100).default([]),
      teammateIds: z.array(z.string().min(1)).max(100).default([]),
    })
    .parse(await request.json())
  if (!agentIds.length && !teammateIds.length) {
    throw new ApiError('Name at least one agent or teammate to label', 400, 'NOTHING_TO_LABEL')
  }

  const labels: Record<string, string> = {}
  const teammateLabels: Record<string, string> = {}
  const subjects: Subject[] = []

  if (agentIds.length) {
    const agents = await prisma.agentTask.findMany({
      where: {
        id: { in: agentIds },
        organizationId: auth.organizationId,
        status: { not: 'DELETED' },
        ...agentVisibilityScope(auth.dbUser.id),
      },
      select: { id: true, description: true, objective: true, metadata: true },
    })
    for (const agent of agents) {
      const existing = sanitizeRoleLabel(readAgentMetadata(agent.metadata).roleLabel)
      if (existing) {
        labels[agent.id] = existing
        continue
      }
      const metadata = readAgentMetadata(agent.metadata)
      subjects.push({
        kind: 'agent',
        id: agent.id,
        block: [
          'Subject: a single agent.',
          `Name: ${agentTitle(agent)}`,
          `Description: ${(metadata.description || agent.description || '').slice(0, 300)}`,
          `Instructions: ${(agent.objective || '').slice(0, 400)}`,
        ].join('\n'),
      })
    }
  }

  if (teammateIds.length) {
    const teammates = await prisma.agentTeammate.findMany({
      where: { id: { in: teammateIds }, organizationId: auth.organizationId },
      select: { id: true, name: true, roleLabel: true },
    })
    const unlabeled = teammates.filter((teammate) => {
      const existing = sanitizeRoleLabel(teammate.roleLabel)
      if (existing) teammateLabels[teammate.id] = existing
      return !existing
    })
    if (unlabeled.length) {
      // One query for every roster, then grouped in memory — a query per avatar
      // would scale with the size of the gallery.
      const members = await prisma.agentTask.findMany({
        where: {
          teammateId: { in: unlabeled.map((teammate) => teammate.id) },
          organizationId: auth.organizationId,
          status: { not: 'DELETED' },
          ...agentVisibilityScope(auth.dbUser.id),
        },
        select: { id: true, teammateId: true, description: true, objective: true, metadata: true },
        take: 300,
      })
      for (const teammate of unlabeled) {
        const roster = members.filter((member) => member.teammateId === teammate.id).slice(0, 8)
        // An avatar with no visible agents has nothing to summarise; leaving it
        // unlabeled is better than inventing a job from a name alone.
        if (!roster.length) continue
        subjects.push({
          kind: 'teammate',
          id: teammate.id,
          block: [
            `Subject: a teammate who runs ${roster.length} agent${roster.length === 1 ? '' : 's'}. Summarise the whole group as ONE role.`,
            `Teammate name: ${teammate.name}`,
            ...roster.map((member, index) =>
              `  Agent ${index + 1}: ${agentTitle(member)} — ${(member.objective || member.description || '').slice(0, 200)}`),
          ].join('\n'),
        })
      }
    }
  }

  if (!subjects.length) return { success: true, labels, teammateLabels }

  // Gate only when a model call is actually about to happen — a fully-labeled
  // gallery poll must not burn the caller's AI rate budget.
  await assertAiCallAllowed({
    organizationId: auth.organizationId,
    rateKey: `role-labels:${auth.dbUser.id}`,
    limit: 6,
  })

  const roster = subjects.map((subject, index) => `[${index + 1}]\n${subject.block}`).join('\n\n')
  const text = await generateStructured({
    schemaName: 'agent_role_labels',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        labels: {
          type: 'array',
          items: { type: 'string', description: 'A 1-2 word job title, e.g. "Deal Researcher".' },
          minItems: subjects.length,
          maxItems: subjects.length,
          description: 'One label per numbered subject, in the same order they were listed.',
        },
      },
      required: ['labels'],
    },
    system: [
      'You write job titles for AI agents on a team roster. For each numbered subject, produce a 1-2 word role that says WHAT IT DOES — like a coworker\'s job title ("Deal Researcher", "Pipeline Reporter", "Meeting Scribe").',
      'Base the role on what the work actually is, not on the name it was given — names are often vague or stale.',
      'A subject that covers several agents gets ONE role describing the group, broad enough to fit every job listed.',
      'Return exactly one label per subject, in order. No punctuation, no numbering.',
      UNTRUSTED_DATA_RULE,
    ].join('\n'),
    user: fenceUntrusted('agent roster', roster),
    maxTokens: 1000,
  })

  if (text) {
    // Rough metering (~chars/4), same convention as the draft builder.
    void recordTokenUsage(auth.organizationId, Math.ceil((roster.length + text.length) / 4)).catch(() => undefined)
    let generated: string[] = []
    try {
      generated = ((JSON.parse(text) as { labels?: unknown }).labels as string[]) ?? []
    } catch {
      generated = []
    }
    await Promise.all(subjects.map(async (subject, index) => {
      const label = sanitizeRoleLabel(generated[index])
      if (!label) return
      if (subject.kind === 'teammate') {
        teammateLabels[subject.id] = label
        await prisma.agentTeammate.updateMany({
          where: { id: subject.id, organizationId: auth.organizationId },
          data: { roleLabel: label },
        })
        return
      }
      labels[subject.id] = label
      const agent = await prisma.agentTask.findFirst({
        where: { id: subject.id, organizationId: auth.organizationId },
        select: { metadata: true },
      })
      const metadata = agent?.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata) ? agent.metadata : {}
      await prisma.agentTask.updateMany({
        where: { id: subject.id, organizationId: auth.organizationId },
        data: { metadata: { ...metadata, roleLabel: label } },
      })
    }))
  }

  return { success: true, labels, teammateLabels }
}, { permission: 'agent.read' })
