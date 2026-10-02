import { prisma } from '@/lib/prisma'
import { startOfUtcDay } from '@/lib/usage/free-tier-limits'
import { GUEST_COPILOT_LIMITS } from './template-policy'

/**
 * What an anonymous visitor has used of today's allowance on their copy of a
 * shared template (GUEST_COPILOT_LIMITS, per UTC day, for as long as the link
 * lives). A query is a message they sent — a run of the copy's copilot. A
 * change is a run that saved at least one version: several saves inside one
 * run are one change, and a version the visitor restored themselves is none.
 */

/** Runs today that changed the copy, optionally not counting the one in progress. */
export async function guestChangesToday(organizationId: string, artifactId: string, exceptExecutionId?: string): Promise<number> {
  const runs = await prisma.artifactVersion.findMany({
    where: { organizationId, artifactId, createdAt: { gte: startOfUtcDay() }, AND: [{ executionId: { not: null } }, ...(exceptExecutionId ? [{ executionId: { not: exceptExecutionId } }] : [])] },
    distinct: ['executionId'],
    select: { executionId: true },
  })
  return runs.length
}

/** Messages the visitor sent their copy's copilot today. */
export function guestQueriesToday(organizationId: string, agentTaskId: string): Promise<number> {
  return prisma.agentExecution.count({ where: { organizationId, agentTaskId, startedAt: { gte: startOfUtcDay() } } })
}

export type GuestUsage = { queries: { used: number; limit: number }; changes: { used: number; limit: number } }

export async function guestUsage(organizationId: string, artifactId: string, agentTaskId: string | null): Promise<GuestUsage> {
  const [queries, changes] = await Promise.all([
    agentTaskId ? guestQueriesToday(organizationId, agentTaskId) : 0,
    guestChangesToday(organizationId, artifactId),
  ])
  return {
    queries: { used: queries, limit: GUEST_COPILOT_LIMITS.messagesPerVisitor },
    changes: { used: changes, limit: GUEST_COPILOT_LIMITS.changesPerVisitor },
  }
}
