'use client'

import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { flowTopic, type JamStatus } from '@/lib/flows/flow-channels'
import { useJamChannel, type JamChannel, type JamClient } from '@/lib/flows/use-jam-channel'
import { upsertCursor, pruneCursors, type CursorSpace, type RemoteCursor } from '@/lib/flows/cursor-store'

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
  /** True while this participant's own mic is being captured for huddle notes. */
  capturing?: boolean
  /** The capture session this participant is part of (minted by whoever
   *  enabled capture; late joiners read it from the roster). */
  captureSessionId?: string | null
  /** Which builder view they're on. Cursor coordinates only mean the same
   *  thing between participants sharing a view, so the roster surfaces this
   *  (with a follow action) rather than hiding them. */
  view?: CursorSpace
}

/** Events other features exchange over the room channel. Bindings are fixed at
 *  subscribe time, so this set is a whitelist — add here before using a new
 *  event. */
export type BusEvent = 'saved' | 'huddle' | 'drag' | 'hello'
export type CollabBus = {
  send: (event: BusEvent, payload: Record<string, unknown>) => void
  on: (event: BusEvent, handler: (payload: Record<string, unknown>) => void) => () => void
}
const BUS_EVENTS: BusEvent[] = ['saved', 'huddle', 'drag', 'hello']

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

/**
 * The jam's ROOM: who's here, where their pointers are, and the small event bus
 * (autosave `saved`, huddle signaling, in-flight `drag`). Everyone with any
 * access to the flow can read AND write here — a view-only teammate still has
 * presence, a cursor and a voice. Graph edits ride a separate, editor-only
 * topic (see use-flow-graph-sync).
 */
export function useFlowRoom(params: {
  client: JamClient | null
  flowId: string
  clientId: string
  self: { userId: string; name: string; canEdit: boolean } | null
}): {
  participants: CollabParticipant[]
  roster: CollabParticipant[]
  cursors: RemoteCursor[]
  status: JamStatus
  sendCursor: (x: number, y: number, space?: CursorSpace) => void
  /** Room presence keys, for bootstrap election. */
  getPresentIds: () => string[]
  setSelection: (nodeId: string | null) => void
  setInHuddle: (inHuddle: boolean) => void
  setCapture: (capturing: boolean, captureSessionId: string | null) => void
  setView: (view: CursorSpace) => void
  bus: CollabBus
} {
  const { client, flowId, clientId, self } = params
  const [participants, setParticipants] = useState<CollabParticipant[]>([])
  const [roster, setRoster] = useState<CollabParticipant[]>([])
  const [cursors, setCursors] = useState<RemoteCursor[]>([])
  const channelRef = useRef<JamChannel | null>(null)
  const subscribedRef = useRef(false)
  // Latest present clientIds — cursor pruning drops departed clients.
  const presentIdsRef = useRef<Set<string>>(new Set())
  const busListeners = useRef<Map<BusEvent, Set<(payload: Record<string, unknown>) => void>>>(new Map())

  const userId = self?.userId
  const name = self?.name
  const canEdit = self?.canEdit ?? false

  // Our full presence payload. Mutated + re-tracked by the setters below.
  const presenceRef = useRef<CollabParticipant | null>(null)
  const retrack = useCallback(() => {
    if (subscribedRef.current && presenceRef.current) {
      const tracked = channelRef.current?.track(presenceRef.current as unknown as Record<string, unknown>)
      void Promise.resolve(tracked).catch(() => undefined)
    }
  }, [])

  // Build our presence payload and RE-ANNOUNCE it whenever identity or
  // permissions change. This effect is declared before the channel is opened so
  // the payload exists by the time a subscribe completes.
  //
  // `canEdit` is not known until the flow loads, and the channel deliberately
  // does not re-subscribe when it changes — so without this re-announce a
  // participant would advertise the permissions it held at join time forever.
  // A view-only peer still claiming canEdit can WIN the autosave persister
  // election (when the owner isn't in the room), and since that peer's own
  // autosave is correctly refused locally, nobody persists the jam at all.
  useEffect(() => {
    if (!userId) return
    presenceRef.current = {
      clientId,
      userId,
      name: name ?? 'Teammate',
      color: presenceColor(userId),
      canEdit,
      selection: presenceRef.current?.selection ?? null,
      inHuddle: presenceRef.current?.inHuddle ?? false,
      capturing: presenceRef.current?.capturing ?? false,
      captureSessionId: presenceRef.current?.captureSessionId ?? null,
      view: presenceRef.current?.view ?? 'inline',
    }
    retrack()
  }, [userId, name, canEdit, clientId, retrack])

  const bind = useCallback((channel: JamChannel) => {
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<CollabParticipant>()
        const flat = Object.values(state).flat()
        presentIdsRef.current = new Set(flat.map((p) => p.clientId))
        setRoster(flat)
        setParticipants(dedupeParticipants(flat))
        setCursors((prev) => pruneCursors(prev, Date.now(), presentIdsRef.current))
      })
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        const p = payload as { clientId?: string; x?: number; y?: number; name?: string; color?: string; space?: string } | undefined
        if (!p || !p.clientId || p.clientId === clientId) return
        const { clientId: from, x, y } = p
        if (typeof x !== 'number' || typeof y !== 'number') return
        setCursors((prev) =>
          upsertCursor(prev, {
            clientId: from,
            x,
            y,
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
  }, [clientId])

  const status = useJamChannel({
    client,
    topic: flowTopic(flowId),
    enabled: Boolean(userId),
    presenceKey: clientId,
    channelRef,
    bind,
    onSubscribed: useCallback(() => {
      subscribedRef.current = true
      retrack()
    }, [retrack]),
  })

  // Idle cursors fade even without presence churn.
  useEffect(() => {
    const timer = setInterval(() => {
      setCursors((prev) => (prev.length ? pruneCursors(prev, Date.now(), presentIdsRef.current) : prev))
    }, CURSOR_PRUNE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

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

  const setCapture = useCallback((capturing: boolean, captureSessionId: string | null) => {
    if (!presenceRef.current) return
    if (presenceRef.current.capturing === capturing && presenceRef.current.captureSessionId === captureSessionId) return
    presenceRef.current = { ...presenceRef.current, capturing, captureSessionId }
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

  const getPresentIds = useCallback(() => Array.from(presentIdsRef.current), [])

  return { participants, roster, cursors, status, sendCursor, getPresentIds, setSelection, setInHuddle, setCapture, setView, bus }
}
