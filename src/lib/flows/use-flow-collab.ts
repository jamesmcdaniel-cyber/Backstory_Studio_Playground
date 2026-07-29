'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import type { FlowGraph } from '@/lib/flows/graph'
import { diffGraph, applyGraphOps, isEmptyOps } from '@/lib/flows/graph-ops'
import { upsertCursor, pruneCursors, type CursorSpace, type RemoteCursor } from '@/lib/flows/cursor-store'
import { shouldAnswerBootstrap } from '@/lib/flows/collab-roles'

export type { RemoteCursor, CursorSpace }

export type CollabParticipant = {
  clientId: string
  userId: string
  name: string
  color: string
  /** May this participant edit? Feeds persister election (jam autosave). */
  canEdit?: boolean
  /** Node id this participant has selected/open — drives the editing ring. */
  selection?: string | null
  /** True while this participant is in the voice huddle. */
  inHuddle?: boolean
  /** Which builder view they're on. Cursor coordinates only mean the same
   *  thing between participants sharing a view, so the roster surfaces this
   *  (with a follow action) rather than hiding them. */
  view?: CursorSpace
}

/** Events other features (jam autosave, voice huddle) exchange over the
 *  flow's ONE channel. Bindings are fixed at subscribe time, so this set is
 *  a whitelist — add here before using a new event. */
export type BusEvent = 'saved' | 'huddle' | 'drag'
export type CollabBus = {
  send: (event: BusEvent, payload: Record<string, unknown>) => void
  on: (event: BusEvent, handler: (payload: Record<string, unknown>) => void) => () => void
}
const BUS_EVENTS: BusEvent[] = ['saved', 'huddle', 'drag']

// Coalesce edits to at most one message per interval (leading + trailing) so a
// 10-person session can't flood the channel while still feeling live.
const BROADCAST_INTERVAL_MS = 200
// Never put a single message larger than this on the wire. Incremental OPS are
// tiny so they never hit it; only a full-state sync of a huge graph might, and
// there the newcomer just falls back to the persisted graph they already loaded.
const MAX_BROADCAST_BYTES = 200_000
// Cursor stream: ~25 tiny messages/s per client at most; idle cursors fade.
const CURSOR_INTERVAL_MS = 40
const CURSOR_PRUNE_INTERVAL_MS = 1_000

// A small, high-contrast palette; a user hashes to a stable color so the same
// person is the same color across a session (Figma-style presence).
const PRESENCE_COLORS = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6']

/** Deterministic color for a user id. */
export function presenceColor(userId: string): string {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]
}

/** Dedupe a presence-state list to one entry per user (a user with two tabs
 *  shouldn't show twice); the newest clientId per user wins. */
export function dedupeParticipants(list: CollabParticipant[]): CollabParticipant[] {
  const byUser = new Map<string, CollabParticipant>()
  for (const p of list) if (p.userId) byUser.set(p.userId, p)
  return Array.from(byUser.values())
}

const isGraph = (v: unknown): v is FlowGraph =>
  Boolean(v && typeof v === 'object' && Array.isArray((v as FlowGraph).nodes) && Array.isArray((v as FlowGraph).edges))

const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] }

/**
 * Live collaboration on a flow via Supabase Realtime — ONE channel carrying:
 *  - PRESENCE: who's here, whether they can edit, which node they have
 *    selected, and whether they're in the voice huddle.
 *  - OP-BASED GRAPH SYNC: a local edit broadcasts the minimal change-set
 *    (upsert/remove nodes/edges by id); co-editors MERGE it (last op wins per
 *    node). A newcomer gets one FULL-state bootstrap from exactly one elected
 *    answerer (lowest present clientId).
 *  - CURSORS: content-space pointer positions, throttled, TTL-pruned.
 *  - BUS ('saved', 'huddle', 'drag'): jam-autosave base advancement, WebRTC
 *    huddle signaling, and in-flight node drags ride the same channel via a
 *    tiny event bus.
 *
 * Remote changes are applied via `onRemoteGraph` (which uses setGraph, NOT the
 * undo-history commit path — so a co-editor's change never pollutes your undo
 * stack nor re-broadcasts). Persistence conflicts are caught separately by the
 * save route's optimistic lock (FLOW_STALE_WRITE). Degrades cleanly (empty
 * presence, no-op broadcast) until `self` and a configured Supabase exist.
 */
export function useFlowCollab(
  flowId: string,
  self: { userId: string; name: string; canEdit: boolean } | null,
  onRemoteGraph: (graph: FlowGraph) => void,
  getLocalGraph: () => unknown,
): {
  participants: CollabParticipant[]
  roster: CollabParticipant[]
  cursors: RemoteCursor[]
  broadcastGraph: (graph: unknown) => void
  sendCursor: (x: number, y: number, space?: CursorSpace) => void
  setSelection: (nodeId: string | null) => void
  setInHuddle: (inHuddle: boolean) => void
  setView: (view: CursorSpace) => void
  bus: CollabBus
  selfClientId: string
} {
  const [participants, setParticipants] = useState<CollabParticipant[]>([])
  const [roster, setRoster] = useState<CollabParticipant[]>([])
  const [cursors, setCursors] = useState<RemoteCursor[]>([])
  const channelRef = useRef<RealtimeChannel | null>(null)
  const subscribedRef = useRef(false)
  // One id per tab so a user's own broadcasts are ignored and two tabs are one
  // presence entry (in the deduped list; the roster keeps both for election).
  const clientId = useMemo(
    () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.floor(performance.now())}`),
    [],
  )
  const onRemoteRef = useRef(onRemoteGraph)
  onRemoteRef.current = onRemoteGraph
  const getLocalRef = useRef(getLocalGraph)
  getLocalRef.current = getLocalGraph
  // The last graph state shared with the room (sent or received). Diffs are
  // computed against it; merges advance it. This is what keeps ops minimal and
  // convergent.
  const lastGraphRef = useRef<FlowGraph>(EMPTY_GRAPH)
  // Latest present clientIds — cursor pruning drops departed clients.
  const presentIdsRef = useRef<Set<string>>(new Set())
  // Bus listeners, keyed by event. Channel bindings are registered once at
  // subscribe time and dispatch into this map, so bus.on works before OR
  // after the channel connects.
  const busListeners = useRef<Map<BusEvent, Set<(payload: Record<string, unknown>) => void>>>(new Map())

  const userId = self?.userId
  const name = self?.name
  const canEdit = self?.canEdit ?? false

  // Our full presence payload. Mutated + re-tracked by setSelection/setInHuddle.
  const presenceRef = useRef<CollabParticipant | null>(null)
  const retrack = useCallback(() => {
    if (subscribedRef.current && presenceRef.current) {
      void channelRef.current?.track(presenceRef.current as unknown as Record<string, unknown>)?.catch?.(() => {})
    }
  }, [])

  // Serialize + size-guard, then send.
  const sendPayload = useCallback((payload: Record<string, unknown>) => {
    let size: number
    try { size = JSON.stringify(payload).length } catch { return }
    if (size > MAX_BROADCAST_BYTES) return
    channelRef.current?.send({ type: 'broadcast', event: 'graph', payload })
  }, [])

  useEffect(() => {
    if (!userId) return
    let channel: RealtimeChannel
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
      channel = supabase.channel(`flow:${flowId}`, { config: { presence: { key: clientId } } })
    } catch {
      return // Supabase not configured — presence simply stays empty.
    }
    const color = presenceColor(userId)
    presenceRef.current = {
      clientId,
      userId,
      name: name ?? 'Teammate',
      color,
      canEdit,
      selection: presenceRef.current?.selection ?? null,
      inHuddle: presenceRef.current?.inHuddle ?? false,
      view: presenceRef.current?.view ?? 'inline',
    }
    channelRef.current = channel
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<CollabParticipant>()
        const flat = Object.values(state).flat()
        presentIdsRef.current = new Set(flat.map((p) => p.clientId))
        setRoster(flat)
        setParticipants(dedupeParticipants(flat))
        setCursors((prev) => pruneCursors(prev, Date.now(), presentIdsRef.current))
      })
      .on('presence', { event: 'join' }, ({ key }) => {
        // Someone joined: exactly ONE present client (lowest clientId) sends
        // the CURRENT (possibly unsaved) FULL graph so the newcomer adopts the
        // live state, not the stale persisted graph they just loaded. The
        // same path heals a reconnecting client after a network blip — its
        // re-join triggers a fresh bootstrap.
        if (key === clientId) return
        const present = Object.keys(channel.presenceState())
        if (!shouldAnswerBootstrap(present, key, clientId)) return
        const graph = getLocalRef.current()
        if (isGraph(graph)) sendPayload({ clientId, full: graph })
      })
      .on('broadcast', { event: 'graph' }, ({ payload }) => {
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
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        const p = payload as { clientId?: string; x?: number; y?: number; name?: string; color?: string; space?: string } | undefined
        if (!p || p.clientId === clientId || typeof p.x !== 'number' || typeof p.y !== 'number') return
        setCursors((prev) =>
          upsertCursor(prev, {
            clientId: p.clientId!,
            x: p.x!,
            y: p.y!,
            name: p.name ?? 'Teammate',
            color: p.color ?? '#6366f1',
            // Packets from a client that predates the canvas carry no space.
            space: p.space === 'canvas' ? 'canvas' : 'inline',
            ts: Date.now(),
          }),
        )
      })
    for (const event of BUS_EVENTS) {
      channel.on('broadcast', { event }, ({ payload }) => {
        const p = payload as Record<string, unknown> | undefined
        if (!p || p.clientId === clientId) return // bus delivers REMOTE messages only
        for (const handler of busListeners.current.get(event) ?? []) handler(p)
      })
    }
    channel.subscribe((status) => {
      if (status !== 'SUBSCRIBED') {
        subscribedRef.current = false
        return
      }
      subscribedRef.current = true
      const graph = getLocalRef.current()
      if (isGraph(graph)) lastGraphRef.current = graph // baseline = the loaded graph
      retrack()
    })
    return () => {
      subscribedRef.current = false
      channelRef.current = null
      void channel.untrack().catch(() => {})
      void supabase.removeChannel(channel)
    }
  }, [flowId, userId, name, canEdit, clientId, sendPayload, retrack])

  // Idle cursors fade even without presence churn.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCursors((prev) => pruneCursors(prev, Date.now(), presentIdsRef.current))
    }, CURSOR_PRUNE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

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

  // Cursor stream: leading-edge throttle WITH a trailing flush. Without the
  // trailing send, a pointer that stops mid-interval left teammates looking at
  // the last position that happened to survive the throttle, not where the
  // cursor actually rests.
  const lastCursorAt = useRef(0)
  const pendingCursor = useRef<{ x: number; y: number; space: CursorSpace } | null>(null)
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const emitCursor = useCallback((x: number, y: number, space: CursorSpace) => {
    const me = presenceRef.current
    if (!me) return
    lastCursorAt.current = Date.now()
    channelRef.current?.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { clientId, x, y, name: me.name, color: me.color, space },
    })
  }, [clientId])
  const sendCursor = useCallback((x: number, y: number, space: CursorSpace = 'inline') => {
    const elapsed = Date.now() - lastCursorAt.current
    if (elapsed >= CURSOR_INTERVAL_MS) {
      emitCursor(x, y, space)
      return
    }
    pendingCursor.current = { x, y, space }
    if (cursorTimer.current) return
    cursorTimer.current = setTimeout(() => {
      cursorTimer.current = null
      const next = pendingCursor.current
      pendingCursor.current = null
      if (next) emitCursor(next.x, next.y, next.space)
    }, CURSOR_INTERVAL_MS - elapsed)
  }, [emitCursor])
  useEffect(() => () => { if (cursorTimer.current) clearTimeout(cursorTimer.current) }, [])

  const setSelection = useCallback((nodeId: string | null) => {
    if (!presenceRef.current || presenceRef.current.selection === nodeId) return
    presenceRef.current = { ...presenceRef.current, selection: nodeId }
    retrack()
  }, [retrack])

  const setInHuddle = useCallback((inHuddle: boolean) => {
    if (!presenceRef.current || presenceRef.current.inHuddle === inHuddle) return
    presenceRef.current = { ...presenceRef.current, inHuddle }
    retrack()
  }, [retrack])

  const setView = useCallback((view: CursorSpace) => {
    if (!presenceRef.current || presenceRef.current.view === view) return
    presenceRef.current = { ...presenceRef.current, view }
    retrack()
  }, [retrack])

  const bus = useMemo<CollabBus>(() => ({
    send: (event, payload) => {
      channelRef.current?.send({ type: 'broadcast', event, payload: { ...payload, clientId } })
    },
    on: (event, handler) => {
      const set = busListeners.current.get(event) ?? new Set()
      set.add(handler)
      busListeners.current.set(event, set)
      return () => { set.delete(handler) }
    },
  }), [clientId])

  return { participants, roster, cursors, broadcastGraph, sendCursor, setSelection, setInHuddle, setView, bus, selfClientId: clientId }
}
