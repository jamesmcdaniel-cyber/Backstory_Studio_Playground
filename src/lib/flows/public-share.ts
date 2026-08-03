import { systemPrisma } from '@/lib/prisma'
import { rateLimit } from '@/lib/ratelimit'
import { publicFlowGraph } from '@/lib/flows/public-graph'
import type { FlowGraph } from '@/lib/flows/graph'

/**
 * Anonymous share-link resolution — the ONLY server path that serves a flow to
 * a visitor with no session.
 *
 * Deliberately NOT threaded through resolveFlowRole: an anonymous visitor never
 * becomes a role on a flow, never enters the builder, and never joins a
 * realtime topic. They get this projection of a published-or-draft graph and
 * nothing else, so the authenticated authorization model is untouched by the
 * feature — there is no null-user branch for a future change to get wrong.
 *
 * A share token is a bearer credential, so lookups are rate-limited per client
 * (a 128-bit token is not guessable, but an unbounded public lookup endpoint is
 * still free load) and the token is never echoed back in the payload.
 */

export type PublicFlowView = {
  name: string
  description: string
  graph: FlowGraph
  stepCount: number
  updatedAt: Date
}

export type PublicFlowResult =
  | { status: 'ok'; flow: PublicFlowView }
  | { status: 'not_found' }
  | { status: 'rate_limited' }

/** Requests per client per window for anonymous link opens. */
const ANON_LIMIT = { limit: 30, windowMs: 60_000 }

export async function resolveAnonymousFlowShare(
  token: string,
  options: { clientKey: string; countView?: boolean },
): Promise<PublicFlowResult> {
  if (!token || token.length < 8) return { status: 'not_found' }

  const limited = await rateLimit(`flow-anon-share:${options.clientKey}`, ANON_LIMIT)
  if (!limited.ok) return { status: 'rate_limited' }

  // systemPrisma with justification: an anonymous visitor has no organization,
  // so there is no tenant to scope by. The lookup is keyed on a unique
  // 128-bit token AND requires shareAnonymous — a flow whose owner has not
  // opted in is unreachable here, and nothing about other orgs is queryable.
  const flow = await systemPrisma.flow.findFirst({
    where: { shareToken: token, shareAnonymous: true },
    select: { id: true, name: true, description: true, graph: true, publishedGraph: true, updatedAt: true },
  })
  if (!flow) return { status: 'not_found' }

  if (options.countView !== false) {
    // Best-effort: a failed counter must never cost the visitor their page.
    await systemPrisma.flow
      .update({ where: { id: flow.id }, data: { anonymousViews: { increment: 1 } } })
      .catch(() => undefined)
  }

  // Prefer the published graph — a public link should show what the flow IS,
  // not an owner's in-progress draft.
  const source = (flow.publishedGraph ?? flow.graph) as FlowGraph
  const graph = publicFlowGraph(
    source && typeof source === 'object' && Array.isArray(source.nodes) ? source : { nodes: [], edges: [] },
  )
  return {
    status: 'ok',
    flow: {
      name: flow.name,
      description: flow.description ?? '',
      graph,
      stepCount: graph.nodes.filter((node) => node.type !== 'trigger' && node.type !== 'note').length,
      updatedAt: flow.updatedAt,
    },
  }
}
