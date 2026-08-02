'use client'

import { useEffect, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { FlowGraph } from '@/lib/flows/graph'
import type { CursorSpace, RemoteCursor } from '@/lib/flows/cursor-store'
import { worstStatus, type JamStatus } from '@/lib/flows/flow-channels'
import type { JamClient } from '@/lib/flows/use-jam-channel'
import {
  useFlowRoom,
  presenceColor,
  dedupeParticipants,
  type CollabParticipant,
  type CollabBus,
  type BusEvent,
} from '@/lib/flows/use-flow-room'
import { useFlowGraphSync } from '@/lib/flows/use-flow-graph-sync'

export type { RemoteCursor, CursorSpace, CollabParticipant, CollabBus, BusEvent, JamStatus }
export { presenceColor, dedupeParticipants }

/**
 * Live collaboration on a flow, over TWO private Supabase Realtime topics:
 *
 *  - `flow:<id>` (the room) — presence (who's here, what they can do, which
 *    node they have open, which view they're on, whether they're in the
 *    huddle), cursors, and the small bus carrying autosave `saved`, huddle
 *    signaling and in-flight `drag`. Anyone with access may read AND write.
 *  - `flow:<id>:ops` — graph change-sets, where RLS permits INSERT only for
 *    editors. A view-only participant sees everything and can inject nothing.
 *
 * Both channels are PRIVATE: Postgres authorizes the join (see the
 * flow_jam_rls migration), and a refused join fails closed — `status` says so
 * rather than the page silently degrading to no collaboration at all.
 *
 * Remote changes are applied via `onRemoteGraph` (which uses setGraph, NOT the
 * undo-history commit path — so a co-editor's change never pollutes your undo
 * stack nor re-broadcasts). Persistence conflicts are caught separately by the
 * save route's optimistic lock (FLOW_STALE_WRITE).
 */
export function useFlowCollab(
  flowId: string,
  self: { userId: string; name: string; canEdit: boolean } | null,
  onRemoteGraph: (graph: FlowGraph) => void,
  getLocalGraph: () => unknown,
  options?: { client?: JamClient },
): {
  participants: CollabParticipant[]
  roster: CollabParticipant[]
  cursors: RemoteCursor[]
  status: JamStatus
  broadcastGraph: (graph: unknown) => void
  sendCursor: (x: number, y: number, space?: CursorSpace) => void
  setSelection: (nodeId: string | null) => void
  setInHuddle: (inHuddle: boolean) => void
  setCapture: (capturing: boolean, captureSessionId: string | null) => void
  setView: (view: CursorSpace) => void
  bus: CollabBus
  selfClientId: string
} {
  // One id per tab so a user's own broadcasts are ignored and two tabs are one
  // presence entry (in the deduped list; the roster keeps both for election).
  const clientId = useMemo(
    () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.floor(performance.now())}`),
    [],
  )

  // The injected client is what lets tests drive two peers over an in-memory
  // transport. In the app it's the browser Supabase client; when Supabase isn't
  // configured this yields null and the jam is simply unavailable.
  const injected = options?.client
  const client = useMemo<JamClient | null>(() => {
    if (injected) return injected
    try {
      return createClient() as unknown as JamClient
    } catch {
      return null
    }
  }, [injected])

  const room = useFlowRoom({ client, flowId, clientId, self })
  const sync = useFlowGraphSync({
    client,
    flowId,
    clientId,
    enabled: Boolean(self?.userId),
    onRemoteGraph,
    getLocalGraph,
  })

  // Bootstrap handshake. A newcomer says `hello` on the ROOM channel once BOTH
  // of its channels are live, and exactly one present peer replies with the
  // current (possibly unsaved) graph on the ops topic.
  //
  // The trigger is the newcomer's own readiness, NOT its presence arriving:
  // presence lands as soon as the room channel joins, which is before the ops
  // channel is subscribed, so a presence-triggered reply was routinely sent
  // into a channel the newcomer hadn't joined yet and lost. Saying hello from
  // the room (writable by everyone) also means view-only participants get
  // bootstrapped, which they couldn't if the request rode the editor-only topic.
  const { bus, getPresentIds, status: roomStatus } = room
  const { answerBootstrap, status: syncStatus } = sync
  const announced = useRef(false)
  useEffect(() => {
    if (roomStatus !== 'live' || syncStatus !== 'live') {
      announced.current = false // a reconnect re-announces, which re-heals state
      return
    }
    if (announced.current) return
    announced.current = true
    bus.send('hello', {})
  }, [roomStatus, syncStatus, bus])

  useEffect(() => bus.on('hello', (payload) => {
    const key = typeof payload.clientId === 'string' ? payload.clientId : null
    if (key) answerBootstrap(key, getPresentIds())
  }), [bus, getPresentIds, answerBootstrap])

  return {
    participants: room.participants,
    roster: room.roster,
    cursors: room.cursors,
    // The jam is only as healthy as its unhealthiest channel.
    status: worstStatus(room.status, sync.status),
    broadcastGraph: sync.broadcastGraph,
    sendCursor: room.sendCursor,
    setSelection: room.setSelection,
    setInHuddle: room.setInHuddle,
    setCapture: room.setCapture,
    setView: room.setView,
    bus: room.bus,
    selfClientId: clientId,
  }
}
