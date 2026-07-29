import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope, executionVisibilityScope } from '@/lib/server/visibility'

function metadataOf(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

// Global ⌘K search across agents and runs. Agent titles live in metadata,
// but description always mirrors the title at create time, so text columns
// cover them.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const query = (request.nextUrl.searchParams.get('q') || '').trim()
  if (query.length < 2) return { success: true, agents: [], runs: [] }

  const text = { contains: query, mode: 'insensitive' as const }
  const [agents, runs] = await Promise.all([
    prisma.agentTask.findMany({
      where: {
        organizationId: auth.organizationId,
        status: { not: 'DELETED' },
        AND: [
          { OR: [{ description: text }, { objective: text }, { folder: text }] },
          agentVisibilityScope(auth.dbUser.id),
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 8,
    }),
    prisma.agentExecution.findMany({
      where: {
        organizationId: auth.organizationId,
        AND: [
          {
            OR: [
              { error: text },
              { agentType: text },
              { agentTask: { is: { OR: [{ description: text }, { objective: text }] } } },
            ],
          },
          executionVisibilityScope(auth.dbUser.id),
        ],
      },
      omit: { transcript: true },
      orderBy: { startedAt: 'desc' },
      take: 8,
    }),
  ])

  return {
    success: true,
    agents: agents.map((agent) => {
      const metadata = metadataOf(agent.metadata)
      return {
        id: agent.id,
        title: metadata.title || agent.description.split('\n')[0] || 'Untitled agent',
        icon: metadata.icon || '',
        folder: agent.folder,
        visibility: agent.visibility,
      }
    }),
    runs: runs.map((run) => {
      const metadata = metadataOf(run.metadata)
      return {
        id: run.id,
        title: metadata.title || run.agentType,
        headline: metadata.headline || null,
        status: run.status,
        startedAt: run.startedAt,
      }
    }),
  }
}, { permission: 'agent.read' })
