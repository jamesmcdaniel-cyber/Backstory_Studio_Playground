import { flowGraphSchema, type FlowGraph, type FlowNode } from '@/lib/flows/graph'

/**
 * Sanitize a flow graph for ANONYMOUS viewing (a share link opened without
 * signing in). This is a security boundary, so it is an ALLOWLIST: each node
 * type declares the fields that may cross it, and everything else is dropped
 * by construction rather than by remembering to strip it.
 *
 * What must never cross:
 *  - Credentials typed literally into a step — an http node's `headers`,
 *    `body`, `query`, `cookie`, a tool node's `args`, a code node's source.
 *    People do paste bearer tokens into these.
 *  - Org-internal ids that mean nothing outside the owning workspace and
 *    disclose its inventory — agentId, connectionId, credentialId, a subflow's
 *    child flowId, a poll trigger's connection.
 *  - Prompt/expression content that carries {{token}} references — raw token
 *    syntax must never reach a UI (standing product rule), and prompts are the
 *    other common place a key gets pasted.
 *
 * What crosses: the SHAPE (types, edges, branch labels) and the author's own
 * display copy (labels, notes, a sticky note's text) — exactly what makes a
 * shared flow legible to someone deciding whether it is worth a conversation.
 *
 * `PUBLIC_NODE_FIELDS` is exhaustive over FlowNode['type']; a new node type
 * fails to compile until it is classified here, so the boundary cannot be
 * widened by omission.
 */

/** Display-safe keys per node type. Everything absent is dropped. */
const PUBLIC_NODE_FIELDS: Record<FlowNode['type'], readonly string[]> = {
  trigger: ['label', 'note'],
  agent: ['label', 'note'],
  condition: ['label', 'note'],
  loop: ['label', 'note', 'body'],
  parallel: ['label', 'note', 'branches'],
  stop: ['label', 'note'],
  // toolName is a public action name ('send_message'), not a secret; the
  // connection it runs through is stripped below.
  tool: ['label', 'note', 'toolName'],
  http: ['label', 'note', 'method'],
  transform: ['label', 'note'],
  filter: ['label', 'note'],
  switch: ['label', 'note'],
  variable: ['label', 'note', 'op', 'name'],
  data: ['label', 'note', 'op'],
  code: ['label', 'note', 'language'],
  humanReview: ['label', 'note'],
  output: ['label', 'note'],
  join: ['label', 'note', 'mode'],
  wait: ['label', 'note', 'mode', 'amount', 'unit'],
  // A sticky note IS author prose meant to be read — that is its whole content.
  note: ['label', 'text'],
  ai: ['label', 'note', 'aiOp'],
  subflow: ['label', 'note'],
  knowledge: ['label', 'note'],
}

/**
 * Required-by-schema fields that carry sensitive values: blanked rather than
 * dropped, so the sanitized graph still parses as a FlowGraph (the preview
 * renderer is typed against it).
 */
const BLANKED: Partial<Record<FlowNode['type'], Record<string, unknown>>> = {
  agent: { agentId: '' },
  tool: { connectionId: '' },
  http: { url: '' },
  loop: { over: '' },
  code: { code: '' },
  humanReview: { message: '' },
  output: { outputs: [] },
  subflow: { flowId: '' },
  variable: { value: '' },
  data: {},
  ai: {},
}

/**
 * An http step's address, reduced to protocol + host + path. The query string
 * is dropped (API keys ride there) and a templated URL — `{{var.base}}/x` —
 * yields '' because it neither parses nor is safe to echo verbatim.
 */
export function publicUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('{{')) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return ''
  }
}

function publicNode(node: FlowNode): Record<string, unknown> {
  const allowed = PUBLIC_NODE_FIELDS[node.type]
  const data = node.data as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    if (data[key] !== undefined) out[key] = data[key]
  }
  Object.assign(out, BLANKED[node.type] ?? {})
  // The discriminating op/kind fields the schema requires, kept structural.
  if (node.type === 'trigger') {
    const type = (data.trigger as { type?: string } | undefined)?.type
    out.trigger = { type: type ?? 'manual' }
  }
  if (node.type === 'http') out.url = publicUrl(data.url)
  if (node.type === 'switch') {
    // Case ids/labels drive the branch chips on the canvas; the comparison
    // operands (which carry tokens) do not cross.
    const cases = Array.isArray(data.cases) ? data.cases : []
    out.cases = cases.map((entry) => {
      const c = entry as Record<string, unknown>
      // left/op/right are required by the schema; blanked (not dropped) so the
      // projection still parses while the comparison itself stays private.
      return { id: String(c.id ?? ''), label: typeof c.label === 'string' ? c.label : '', left: '', op: 'eq', right: '' }
    })
  }
  return { id: node.id, type: node.type, data: out }
}

/**
 * The anonymous-viewer projection of a graph. Returns a graph that still
 * satisfies flowGraphSchema (so the shared preview renderer accepts it);
 * nodes that cannot be re-parsed after sanitizing are dropped along with
 * their edges rather than served half-formed.
 */
export function publicFlowGraph(graph: FlowGraph): FlowGraph {
  const candidate = {
    nodes: graph.nodes.map(publicNode),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.branch ? { branch: edge.branch } : {}),
    })),
  }
  const parsed = flowGraphSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  // Defensive: keep only the nodes that individually survive a parse.
  const nodes = candidate.nodes.filter((node) => flowGraphSchema.safeParse({ nodes: [node], edges: [] }).success)
  const ids = new Set(nodes.map((node) => (node as { id: string }).id))
  return flowGraphSchema.parse({
    nodes,
    edges: candidate.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  })
}
