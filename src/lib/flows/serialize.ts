import { stepCountOf } from '@/lib/flows/graph'
import type { FlowGraph } from '@/lib/flows/graph'
import { canEditFlow } from '@/lib/flows/access'

/** How a role-aware caller describes THIS viewer's relationship to the flow.
 *  `includeShare` exposes the share token/role — same-org editors only. */
export type FlowViewerAccess = { role: 'edit' | 'view'; external: boolean; includeShare?: boolean }

/**
 * Strip server-only fields out of the stored trigger before it goes on the wire.
 *
 * `webhookSecretHash` is the SHA-256 of the flow's trigger secret. Nothing
 * client-side reads it — the builder learns whether a secret exists from
 * GET /api/flows/[id]/trigger-secret's `hasSecret` — but serializing the trigger
 * wholesale handed the hash to every reader of the flow, including view-only
 * cross-workspace guests holding a share link. The rest of the codebase already
 * treats it as server-only: the mint route returns the plaintext exactly once
 * and never the hash, `preserveWebhookSecretHash` re-attaches it on save because
 * the client is not expected to round-trip it, and the anonymous-share sanitizer
 * drops it. This closes the one boundary that still leaked it.
 */
function publicTrigger(trigger: unknown): unknown {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return { type: 'manual' }
  const { webhookSecretHash: _hash, ...rest } = trigger as Record<string, unknown>
  return rest
}

/** Wire shape for a flow, shared by the list page and the builder. */
export function serializeFlow(flow: {
  id: string
  name: string
  description: string
  status: string
  trigger: unknown
  graph: unknown
  publishedGraph?: unknown
  version?: number
  visibility: string
  shareToken?: string | null
  shareRole?: string
  shareAnonymous?: boolean
  anonymousViews?: number
  folder?: string
  userId?: string | null
  createdAt: Date
  updatedAt: Date
}, viewerId?: string, access?: FlowViewerAccess) {
  const graph = (flow.graph && typeof flow.graph === 'object' ? flow.graph : { nodes: [], edges: [] }) as FlowGraph
  // Every executable node is a step. Counting only `agent` nodes (the original
  // rule, from when a flow WAS a chain of agents) reported "1 step" for a
  // pipeline of tool/http/data/ai nodes — the card undercounted every flow that
  // wasn't agent-only. Matches stepCountOf() in the flow-template catalogue.
  const stepCount = stepCountOf(graph)
  const published = flow.publishedGraph != null
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    status: flow.status.toLowerCase(),
    trigger: publicTrigger(flow.trigger),
    graph,
    visibility: flow.visibility,
    // Whether THIS viewer may edit. Role-aware callers (share/single-flow/list
    // routes) pass `access`; legacy org-only callers keep the v1 derivation.
    canEdit: access
      ? access.role === 'edit'
      : viewerId === undefined
        ? true
        : canEditFlow({ visibility: flow.visibility, userId: flow.userId ?? null }, viewerId),
    // Flow owner — persister election prefers the owner's client during a jam.
    ownerId: flow.userId ?? null,
    ...(access && {
      role: access.role,
      // Cross-workspace guest: UI hides run/publish/settings; PUT enforces graph-only.
      external: access.external,
      ...(access.includeShare
        ? {
            shareToken: flow.shareToken ?? null,
            shareRole: flow.shareRole === 'edit' ? 'edit' : 'view',
            shareAnonymous: Boolean(flow.shareAnonymous),
            anonymousViews: flow.anonymousViews ?? 0,
          }
        : {}),
    }),
    folder: flow.folder ?? '',
    stepCount,
    version: flow.version ?? 1,
    published,
    // True when the draft differs from what's published (or nothing is published).
    unpublishedChanges: !published || JSON.stringify(flow.publishedGraph) !== JSON.stringify(graph),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
  }
}
