import { prisma } from '@/lib/prisma'
import { flowGraphSchema } from '@/lib/flows/graph'
import {
  graphDependsOn,
  rankDependents,
  type CredentialDependent,
  type CredentialRef,
} from '@/lib/credentials/dependents'

/**
 * Everything in a workspace that would stop working without this credential.
 *
 * Reads the PUBLISHED graph when a flow has one and the draft otherwise, which
 * is what each flow would actually run. A flow whose draft has moved off the
 * credential but whose published version still uses it is still broken by a
 * revoke, and reading only the draft would have said otherwise.
 *
 * Bounded rather than paginated: this exists to answer "is this safe to
 * revoke", and a screen that lists two hundred flows has already answered it.
 */
export async function credentialDependents(
  organizationId: string,
  ref: CredentialRef,
  limit = 50,
): Promise<CredentialDependent[]> {
  const [flows, connectors] = await Promise.all([
    prisma.flow.findMany({
      where: { organizationId },
      select: { id: true, name: true, graph: true, publishedGraph: true },
      take: 500,
    }),
    ref.kind === 'mcp_connection'
      ? prisma.agentConnector.findMany({
          where: { organizationId, mcpConnectionId: ref.id },
          select: { agentTask: { select: { id: true, description: true, objective: true } } },
          take: limit,
        })
      : Promise.resolve([]),
  ])

  const dependents: CredentialDependent[] = []

  for (const flow of flows) {
    const published = flow.publishedGraph != null
    const source = flow.publishedGraph ?? flow.graph
    const parsed = flowGraphSchema.safeParse(source)
    // A graph too malformed to parse cannot be reasoned about. Left out rather
    // than reported as safe: it is already broken for a reason unrelated to this.
    if (!parsed.success) continue
    if (graphDependsOn(parsed.data, ref)) {
      dependents.push({ type: 'flow', id: flow.id, name: flow.name, published })
    }
    if (dependents.length >= limit) break
  }

  for (const connector of connectors) {
    const agent = connector.agentTask
    if (!agent) continue
    dependents.push({
      type: 'agent',
      id: agent.id,
      name: (agent.description || agent.objective || 'Agent').slice(0, 80),
    })
  }

  return rankDependents(dependents).slice(0, limit)
}
