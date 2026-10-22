import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret, hashToken } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'
import { recordAudit } from '@/lib/audit'
import { ApiError } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { publicFlowGraph } from '@/lib/flows/public-graph'
import { activityMatchColumns, triggerFromGraph } from '@/lib/flows/trigger'
import { findSecretCandidates, stripOrgReferences } from '@/lib/catalogue/sanitize'
import type { FlowGraph } from '@/lib/flows/graph'

/**
 * A flow's PUBLIC link — opt-in, view-only, no sign-in — and the only server
 * path that serves a flow to a visitor with no session.
 *
 * Deliberately NOT threaded through resolveFlowRole, and deliberately NOT the
 * jam share token: that token admits signed-in people to the builder as
 * collaborators, which a link meant to be posted anywhere must never do. This
 * one has its own 192-bit token (digest for lookup, encrypted so an editor can
 * copy the link again), an optional expiry, and resolves to a sanitized
 * projection of the graph and nothing else — no run data, no step outputs, no
 * credentials, no connection ids, no realtime topic.
 *
 * Lookups are rate-limited per client and the token is never echoed back. A
 * second opt-in (`publicAllowCopy`) lets a signed-in visitor copy the flow into
 * their own workspace, sanitized the way a catalogue submission is; copies
 * never flow back.
 */

/**
 * The anonymous payload, by construction: the serve path builds exactly these
 * keys and nothing else (deny by default — a new Flow column cannot reach a
 * visitor by being spread in). `public-share.test.ts` pins the list.
 */
export const PUBLIC_FLOW_VIEW_FIELDS = ['name', 'description', 'graph', 'stepCount', 'updatedAt', 'allowCopy'] as const

export type PublicFlowView = {
  name: string
  description: string
  /** The sanitized projection (public-graph.ts) — shape and author copy only. */
  graph: FlowGraph
  stepCount: number
  updatedAt: Date
  /** The owner also offers "Use this flow". */
  allowCopy: boolean
}

export type PublicFlowResult =
  | { status: 'ok'; flow: PublicFlowView }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'rate_limited' }

/** Requests per client per window for anonymous link opens. */
const ANON_LIMIT = { limit: 30, windowMs: 60_000 }
/** Shorter than any token we mint (32 base64url chars) — refused without a lookup. */
const MIN_TOKEN_LENGTH = 16
/** How far ahead an expiry can be set. */
const EXPIRY_MAX_MS = 5 * 365 * 24 * 60 * 60 * 1000

function newPublicToken(): string {
  return crypto.randomBytes(24).toString('base64url') // 192 bits
}

export function publicFlowUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/share/flow/${token}`
}

export function publicLinkExpired(expiresAt: Date | null | undefined, now = new Date()): boolean {
  return Boolean(expiresAt && expiresAt.getTime() <= now.getTime())
}

function graphOf(value: unknown): FlowGraph {
  const graph = value as FlowGraph | null
  return graph && typeof graph === 'object' && Array.isArray(graph.nodes) ? graph : { nodes: [], edges: [] }
}

/** Build the anonymous payload from a row — the field allowlist in code. */
export function publicFlowView(row: {
  name: string
  description: string | null
  graph: unknown
  publishedGraph: unknown
  updatedAt: Date
  publicAllowCopy: boolean
}): PublicFlowView {
  // Prefer the published graph — a public link should show what the flow IS,
  // not an owner's in-progress draft.
  const graph = publicFlowGraph(graphOf(row.publishedGraph ?? row.graph))
  return {
    name: row.name,
    description: row.description ?? '',
    graph,
    stepCount: graph.nodes.filter((node) => node.type !== 'trigger' && node.type !== 'note').length,
    updatedAt: row.updatedAt,
    allowCopy: row.publicAllowCopy,
  }
}

const PUBLIC_ROW_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  description: true,
  graph: true,
  publishedGraph: true,
  updatedAt: true,
  publicAllowCopy: true,
  publicExpiresAt: true,
} as const

/**
 * The one lookup every public path makes: the digest of what the visitor
 * presented, with the link on. Expiry is checked by the caller so a visitor
 * can be told the link expired rather than that it never existed.
 */
async function findPublicFlow(token: string) {
  // systemPrisma with justification: an anonymous visitor has no organization,
  // so there is no tenant to scope by. The lookup is keyed on the unique digest
  // of a 192-bit token AND requires the link to be on — a flow whose owner has
  // not opted in is unreachable here, and nothing about other orgs is
  // queryable. Every later read re-scopes to the row's own organizationId.
  return systemPrisma.flow.findFirst({
    where: { publicTokenDigest: hashToken(token), shareAnonymous: true },
    select: PUBLIC_ROW_SELECT,
  })
}

export async function resolveAnonymousFlowShare(
  token: string,
  options: { clientKey: string; countView?: boolean },
): Promise<PublicFlowResult> {
  if (!token || token.length < MIN_TOKEN_LENGTH) return { status: 'not_found' }

  const limited = await rateLimit(`flow-anon-share:${options.clientKey}`, ANON_LIMIT)
  if (!limited.ok) return { status: 'rate_limited' }

  const flow = await findPublicFlow(token)
  if (!flow) return { status: 'not_found' }
  if (publicLinkExpired(flow.publicExpiresAt)) return { status: 'expired' }

  if (options.countView !== false) {
    // Best-effort: a failed counter must never cost the visitor their page.
    await systemPrisma.flow
      .updateMany({ where: { id: flow.id, organizationId: flow.organizationId }, data: { anonymousViews: { increment: 1 } } })
      .catch(() => undefined)
  }
  return { status: 'ok', flow: publicFlowView(flow) }
}

// ── Managing the link (owner / editors) ─────────────────────────────────────

export type PublicLinkState = {
  enabled: boolean
  /** The link itself — null when off, or when it predates encryption (rotate to get one). */
  url: string | null
  views: number
  expiresAt: string | null
  expired: boolean
  allowCopy: boolean
}

export type PublicLinkPatch = {
  action?: 'enable' | 'disable' | 'rotate'
  /** ISO time the link stops working; null = never. */
  expiresAt?: string | null
  allowCopy?: boolean
}

/** A change that cannot be made as asked — the caller's to fix (400). */
export class PublicLinkInputError extends Error {}

type ManagedRow = {
  id: string
  shareAnonymous: boolean
  publicTokenCiphertext: string | null
  publicExpiresAt: Date | null
  publicAllowCopy: boolean
  anonymousViews: number
}

function stateOf(row: ManagedRow, origin: string, freshToken?: string): PublicLinkState {
  if (!row.shareAnonymous) return { enabled: false, url: null, views: row.anonymousViews, expiresAt: null, expired: false, allowCopy: row.publicAllowCopy }
  let token = freshToken ?? null
  if (!token && row.publicTokenCiphertext) {
    try {
      token = decryptSecret(row.publicTokenCiphertext)
    } catch {
      token = null
    }
  }
  return {
    enabled: true,
    url: token ? publicFlowUrl(origin, token) : null,
    views: row.anonymousViews,
    expiresAt: row.publicExpiresAt?.toISOString() ?? null,
    expired: publicLinkExpired(row.publicExpiresAt),
    allowCopy: row.publicAllowCopy,
  }
}

const MANAGED_SELECT = {
  id: true,
  visibility: true,
  userId: true,
  graph: true,
  publishedGraph: true,
  shareAnonymous: true,
  publicTokenCiphertext: true,
  publicExpiresAt: true,
  publicAllowCopy: true,
  anonymousViews: true,
} as const

/** The flow, when this person may manage its sharing (same-org editor); else 404/403. */
async function requireManagedFlow(organizationId: string, flowId: string, userId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id: flowId, organizationId, ...agentVisibilityScope(userId) },
    select: MANAGED_SELECT,
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, userId)
  return flow
}

export async function loadPublicLink(organizationId: string, flowId: string, userId: string, origin: string): Promise<PublicLinkState> {
  return stateOf(await requireManagedFlow(organizationId, flowId, userId), origin)
}

/** Literal credentials a copy of this graph would carry — the copy is refused while there are any. */
export function copyBlockers(graph: unknown): number {
  return findSecretCandidates(copyableFlowGraph(graphOf(graph))).length
}

export async function updatePublicLink(
  organizationId: string,
  flowId: string,
  userId: string,
  origin: string,
  patch: PublicLinkPatch,
): Promise<PublicLinkState> {
  const flow = await requireManagedFlow(organizationId, flowId, userId)
  const data: Prisma.FlowUpdateInput = {}
  let freshToken: string | undefined

  if ((patch.action === 'enable' && !flow.shareAnonymous) || patch.action === 'rotate') {
    freshToken = newPublicToken()
    let ciphertext: string | null = null
    try {
      ciphertext = encryptSecret(freshToken)
    } catch {
      ciphertext = null // without encryption the link is shown once, in this response
    }
    data.shareAnonymous = true
    data.publicTokenDigest = hashToken(freshToken)
    data.publicTokenCiphertext = ciphertext
    // A fresh link starts a fresh count; the old URL stops working now.
    data.anonymousViews = 0
  } else if (patch.action === 'disable') {
    data.shareAnonymous = false
    data.publicTokenDigest = null
    data.publicTokenCiphertext = null
    data.publicExpiresAt = null // a link turned back on later starts with no expiry
    data.publicAllowCopy = false
  }

  if (patch.expiresAt !== undefined && patch.action !== 'disable') {
    if (patch.expiresAt === null) data.publicExpiresAt = null
    else {
      const when = new Date(patch.expiresAt)
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) throw new PublicLinkInputError('Pick an expiry in the future.')
      if (when.getTime() > Date.now() + EXPIRY_MAX_MS) throw new PublicLinkInputError('An expiry can be at most five years away.')
      data.publicExpiresAt = when
    }
  }

  if (patch.allowCopy !== undefined && patch.action !== 'disable') {
    if (patch.allowCopy && copyBlockers(flow.publishedGraph ?? flow.graph) > 0) {
      throw new PublicLinkInputError('This flow has a credential typed into a step. Move it into a saved credential before letting people copy the flow.')
    }
    data.publicAllowCopy = patch.allowCopy
  }

  const updated = Object.keys(data).length
    ? await prisma.flow.update({ where: { id: flow.id, organizationId }, data, select: MANAGED_SELECT })
    : flow

  await recordAudit({
    organizationId,
    actorUserId: userId,
    action:
      patch.action === 'enable' && freshToken ? 'flow.public_link_enabled'
        : patch.action === 'rotate' ? 'flow.public_link_rotated'
          : patch.action === 'disable' ? 'flow.public_link_disabled'
            : 'flow.public_link_changed',
    resourceType: 'flow',
    resourceId: flow.id,
    detail: {
      ...(patch.action ? { action: patch.action } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: updated.publicExpiresAt?.toISOString() ?? null } : {}),
      ...(patch.allowCopy !== undefined ? { allowCopy: updated.publicAllowCopy } : {}),
    },
  }).catch(() => undefined)

  return stateOf(updated, origin, freshToken)
}

// ── "Use this flow" ─────────────────────────────────────────────────────────

/**
 * Keys a copy never carries beyond what stripOrgReferences already drops: ids
 * that only resolve in the owner's workspace (a saved credential resolver, an
 * MCP connection, a repository collection, a review assignee) and pinned
 * sample outputs — real data from the owner's runs.
 */
const COPY_DROPPED_KEYS = new Set(['credentialResolverId', 'mcpConnectionId', 'collectionId', 'assigneeUserId', 'webhookSecretHash'])

function dropKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !COPY_DROPPED_KEYS.has(key)).map(([key, entry]) => [key, dropKeys(entry)]))
  }
  return value
}

/** The graph a visitor's copy starts from: functional, minus the owner's ids and data. */
export function copyableFlowGraph(graph: FlowGraph): FlowGraph {
  const rest: Partial<FlowGraph> = { ...graph }
  delete rest.pinData
  const stripped = dropKeys(stripOrgReferences(rest as unknown)) as FlowGraph
  // A dropped id a node's schema requires (a tool's connectionId, an agent
  // step's agentId, a subflow's flowId) comes back BLANK, so the copy still
  // parses and the copier is asked to pick their own, as after an import.
  stripped.nodes = stripped.nodes.map((node, index) => {
    const before = (graph.nodes[index]?.data ?? {}) as Record<string, unknown>
    const data = { ...(node.data as Record<string, unknown>) }
    for (const [key, value] of Object.entries(before)) {
      if (typeof value === 'string' && !(key in data)) data[key] = ''
    }
    return { ...node, data } as FlowGraph['nodes'][number]
  })
  return stripped
}

export type CopyResult = { status: 'ok'; flowId: string } | { status: 'not_found' } | { status: 'expired' } | { status: 'not_offered' } | { status: 'blocked' }

/**
 * Copy the flow behind a public link into the CALLER's workspace, as a private
 * draft they own. Nothing links the copy to the original, so edits to either
 * never reach the other.
 */
export async function copyPublicFlow(token: string, caller: { organizationId: string; userId: string }): Promise<CopyResult> {
  if (!token || token.length < MIN_TOKEN_LENGTH) return { status: 'not_found' }
  const source = await findPublicFlow(token)
  if (!source) return { status: 'not_found' }
  if (publicLinkExpired(source.publicExpiresAt)) return { status: 'expired' }
  if (!source.publicAllowCopy) return { status: 'not_offered' }
  const graph = copyableFlowGraph(graphOf(source.publishedGraph ?? source.graph))
  // Re-checked at copy time: the graph may have changed since copying was
  // turned on, and a literal credential must never cross workspaces.
  if (findSecretCandidates(graph).length) return { status: 'blocked' }
  const trigger = triggerFromGraph(graph)
  const created = await prisma.flow.create({
    data: {
      name: `${source.name} (copy)`.slice(0, 200),
      description: source.description ?? '',
      status: 'DRAFT',
      visibility: 'private',
      trigger: trigger as unknown as Prisma.InputJsonValue,
      graph: graph as unknown as Prisma.InputJsonValue,
      settings: {},
      organizationId: caller.organizationId,
      userId: caller.userId,
      ...activityMatchColumns(trigger),
    },
    select: { id: true },
  })
  await recordAudit({
    organizationId: caller.organizationId,
    actorUserId: caller.userId,
    action: 'flow.copied_from_public_link',
    resourceType: 'flow',
    resourceId: created.id,
  }).catch(() => undefined)
  return { status: 'ok', flowId: created.id }
}
