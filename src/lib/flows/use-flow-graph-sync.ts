'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { FlowGraph } from '@/lib/flows/graph'
import { diffGraph, applyGraphOps, isEmptyOps } from '@/lib/flows/graph-ops'
import { shouldAnswerBootstrap } from '@/lib/flows/collab-roles'
import { flowOpsTopic, type JamStatus } from '@/lib/flows/flow-channels'
import { useJamChannel, type JamChannel, type JamClient } from '@/lib/flows/use-jam-channel'

// Coalesce edits to at most one message per interval (leading + trailing) so a
// 10-person session can't flood the channel while still feeling live.
const BROADCAST_INTERVAL_MS = 200
// Never put a single message larger than this on the wire. Incremental OPS are
// tiny so they never hit it; only a full-state sync of a huge graph might, and
// there the newcomer just falls back to the persisted graph they already loaded.
const MAX_BROADCAST_BYTES = 200_000

const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] }

const isGraph = (v: unknown): v is FlowGraph =>
  Boolean(v && typeof v === 'object' && Array.isArray((v as FlowGraph).nodes) && Array.isArray((v as FlowGraph).edges))

/**
 * Graph sync on the EDITOR-ONLY topic (`flow:<id>:ops`). RLS allows INSERT
 * there only for editors, so a view-only participant receives every change but
 * cannot inject one — enforcement in Postgres rather than in the client.
 *
 * A local edit broadcasts the minimal change-set (upsert/remove nodes/edges by
 * id) which co-editors MERGE (last op wins per node). A newcomer gets one
 * FULL-state bootstrap from exactly one elected answerer. Election runs off
 * ROOM presence (see use-flow-room), not this topic's: every participant joins
 * the room, including viewers who can't write here and would otherwise never
 * be bootstrapped onto the live, unsaved graph.
 */
export function useFlowGraphSync(params: {
  client: JamClient | null
  flowId: string
  clientId: string
  enabled: boolean
  onRemoteGraph: (graph: FlowGraph) => void
  getLocalGraph: () => unknown
}): {
  broadcastGraph: (graph: unknown) => void
  answerBootstrap: (joinerKey: string, presentIds: string[]) => void
  status: JamStatus
} {
  const { client, flowId, clientId, enabled } = params
  const channelRef = useRef<JamChannel | null>(null)
  const onRemoteRef = useRef(params.onRemoteGraph)
  onRemoteRef.current = params.onRemoteGraph
  const getLocalRef = useRef(params.getLocalGraph)
  getLocalRef.current = params.getLocalGraph
  // The last graph state shared with the room (sent or received). Diffs are
  // computed against it; merges advance it. This is what keeps ops minimal and
  // convergent.
  const lastGraphRef = useRef<FlowGraph>(EMPTY_GRAPH)

  // Serialize + size-guard, then send.
  const sendPayload = useCallback((payload: Record<string, unknown>) => {
    let size: number
    try { size = JSON.stringify(payload).length } catch { return }
    if (size > MAX_BROADCAST_BYTES) return
    channelRef.current?.send({ type: 'broadcast', event: 'graph', payload })
  }, [])

  const bind = useCallback((channel: JamChannel) => {
    channel.on('broadcast', { event: 'graph' }, ({ payload }) => {
      const p = payload as { clientId?: string; full?: unknown; ops?: unknown } | undefined
      if (!p || p.clientId === clientId) return // ignore our own echo
      if (isGraph(p.full)) {
        // Bootstrap / re-sync: adopt the full state.
        lastGraphRef.current = p.full
        onRemoteRef.current(p.full)
        return
      }
      if (p.ops && typeof p.ops === 'object') {
        // Merge the change-set into OUR current local graph so our unsent
        // edits survive.
        const local = getLocalRef.current()
        const base = isGraph(local) ? local : lastGraphRef.current
        const merged = applyGraphOps(base, p.ops)
        // Advance the shared baseline by the RECEIVED ops (what the room now
        // knows) — NOT to `merged`, which also holds our own unsent local
        // edits. Setting it to merged made a pending trailing broadcast diff
        // merged→(stale local) and REVERT the teammate's just-merged edit.
        lastGraphRef.current = applyGraphOps(lastGraphRef.current, p.ops)
        onRemoteRef.current(merged)
      }
    })
  }, [clientId])

  const status = useJamChannel({
    client,
    topic: flowOpsTopic(flowId),
    enabled,
    presenceKey: clientId,
    channelRef,
    bind,
    onSubscribed: useCallback(() => {
      const graph = getLocalRef.current()
      if (isGraph(graph)) lastGraphRef.current = graph // baseline = the loaded graph
    }, []),
  })

  /** Someone joined the room: exactly ONE present client (lowest clientId)
   *  sends the CURRENT (possibly unsaved) FULL graph, so the newcomer adopts
   *  the live state rather than the stale persisted graph they just loaded.
   *  The same path heals a reconnecting client after a network blip. */
  const answerBootstrap = useCallback((joinerKey: string, presentIds: string[]) => {
    if (joinerKey === clientId) return
    if (!shouldAnswerBootstrap(presentIds, joinerKey, clientId)) return
    const graph = getLocalRef.current()
    if (isGraph(graph)) sendPayload({ clientId, full: graph })
  }, [clientId, sendPayload])

  // Op-based broadcast, throttled at the flush edge: diff the latest graph
  // against the last shared baseline and send only the change-set.
  const lastSentAt = useRef(0)
  const pendingGraph = useRef<FlowGraph | null>(null)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(() => {
    if (!pendingGraph.current) return
    pendingGraph.current = null
    // Diff the LATEST local graph, not the snapshot taken when this broadcast
    // was queued: if a remote merge landed while the flush was pending, the
    // snapshot is pre-merge and diffing it would revert the teammate's edit —
    // the live graph already includes it, so we send only our own delta.
    const local = getLocalRef.current()
    const target = isGraph(local) ? local : lastGraphRef.current
    const ops = diffGraph(lastGraphRef.current, target)
    lastGraphRef.current = target
    lastSentAt.current = Date.now()
    if (isEmptyOps(ops)) return
    sendPayload({ clientId, ops })
  }, [clientId, sendPayload])

  const broadcastGraph = useCallback((graph: unknown) => {
    if (!isGraph(graph)) return
    pendingGraph.current = graph
    const elapsed = Date.now() - lastSentAt.current
    if (elapsed >= BROADCAST_INTERVAL_MS) {
      flush()
      return
    }
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null
        flush()
      }, BROADCAST_INTERVAL_MS - elapsed)
    }
  }, [flush])

  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current) }, [])

  return { broadcastGraph, answerBootstrap, status }
}
