/**
 * A flow jam rides TWO private Supabase Realtime topics:
 *
 *   flow:<id>      — presence, cursors, huddle signaling, the `saved` and
 *                    `drag` bus. Writable by anyone with ANY access.
 *   flow:<id>:ops  — graph change-sets. RLS on realtime.messages allows INSERT
 *                    only for editors, so a view-only participant physically
 *                    cannot inject graph edits.
 *
 * Both are PRIVATE channels: joining requires Postgres to confirm the caller
 * can access the flow (see the flow_jam_rls migration's flow_topic_access).
 * The split exists because a single topic can only be authorized as a whole —
 * with one topic, "can read the jam" and "can edit the graph" are the same
 * permission, and view-only would stay an honor system.
 */
export function flowTopic(flowId: string): string {
  return `flow:${flowId}`
}

export function flowOpsTopic(flowId: string): string {
  return `flow:${flowId}:ops`
}

export function parseFlowTopic(topic: string): { flowId: string; kind: 'room' | 'ops' } | null {
  const parts = topic.split(':')
  if (parts[0] !== 'flow' || !parts[1]) return null
  if (parts.length === 2) return { flowId: parts[1], kind: 'room' }
  if (parts.length === 3 && parts[2] === 'ops') return { flowId: parts[1], kind: 'ops' }
  return null
}

/**
 * What the jam indicator shows. `degraded` means we expect to recover on our
 * own (a retry is scheduled); `error` means the join was refused and needs
 * attention — most likely the RLS policies aren't applied, or this viewer
 * genuinely can't access the flow.
 */
export type JamStatus = 'connecting' | 'live' | 'degraded' | 'error'

export function nextJamStatus(current: JamStatus, subscribeStatus: string): JamStatus {
  switch (subscribeStatus) {
    case 'SUBSCRIBED': return 'live'
    case 'CHANNEL_ERROR': return 'error'
    case 'TIMED_OUT':
    case 'CLOSED': return 'degraded'
    default: return current
  }
}

const SEVERITY: Record<JamStatus, number> = { live: 0, connecting: 1, degraded: 2, error: 3 }

/** The jam is only as healthy as its unhealthiest channel. */
export function worstStatus(a: JamStatus, b: JamStatus): JamStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b
}

const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 30_000

/** Capped exponential backoff, so a permanently-refused channel retries slowly
 *  instead of hammering the socket. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt))
}
