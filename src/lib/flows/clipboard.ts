import { sanitizeCopiedNode, type CopiedSelection } from '@/lib/flows/mutate'
import { flowEdgeSchema, type FlowNode } from '@/lib/flows/graph'

/** v1 held exactly one step. v2 holds a selection (steps + the edges between
 *  them) so the canvas can copy a whole subgraph. v1 payloads still read, so a
 *  clipboard written before this change still pastes. */
export const FLOW_CLIPBOARD_KEY = 'flows.clipboard.v1'
export const FLOW_SELECTION_CLIPBOARD_KEY = 'flows.clipboard.v2'

/** Persist a copied step (survives reloads and works across flows). */
export function writeFlowClipboard(node: FlowNode): void {
  writeFlowSelection({ nodes: [node], edges: [] })
}

/** Persist a copied selection of steps plus the edges between them. */
export function writeFlowSelection(selection: CopiedSelection): void {
  try {
    localStorage.setItem(FLOW_SELECTION_CLIPBOARD_KEY, JSON.stringify(selection))
    // Keep v1 in step so a single-step copy still pastes on a surface that only
    // reads v1; a multi-step copy clears it rather than leaving a stale step.
    if (selection.nodes.length === 1) localStorage.setItem(FLOW_CLIPBOARD_KEY, JSON.stringify(selection.nodes[0]))
    else localStorage.removeItem(FLOW_CLIPBOARD_KEY)
  } catch {
    /* storage unavailable */
  }
  try {
    if (typeof navigator !== 'undefined') {
      const payload = selection.nodes.length === 1 ? selection.nodes[0] : selection
      void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2))
    }
  } catch {
    /* best-effort OS clipboard */
  }
}

/** Read + sanitize a single copied step, or null. */
export function readFlowClipboard(): FlowNode | null {
  return readFlowSelection()?.nodes[0] ?? null
}

/**
 * Read + sanitize the copied selection, or null. Edges survive only when both
 * endpoints did, so a partially-invalid payload can never paste a dangling edge.
 */
export function readFlowSelection(): CopiedSelection | null {
  const selection = readSelectionPayload() ?? readLegacyPayload()
  if (!selection || !selection.nodes.length) return null
  return selection
}

function readSelectionPayload(): CopiedSelection | null {
  try {
    const raw = localStorage.getItem(FLOW_SELECTION_CLIPBOARD_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { nodes?: unknown[]; edges?: unknown[] }
    const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
      .map(sanitizeCopiedNode)
      .filter((node): node is FlowNode => Boolean(node))
    const ids = new Set(nodes.map((node) => node.id))
    const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
      .map((edge) => flowEdgeSchema.safeParse(edge))
      .flatMap((result) => (result.success ? [result.data] : []))
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    return { nodes, edges }
  } catch {
    return null
  }
}

function readLegacyPayload(): CopiedSelection | null {
  try {
    const raw = localStorage.getItem(FLOW_CLIPBOARD_KEY)
    if (!raw) return null
    const node = sanitizeCopiedNode(JSON.parse(raw))
    return node ? { nodes: [node], edges: [] } : null
  } catch {
    return null
  }
}
