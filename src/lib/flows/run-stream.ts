import { apiLogger } from '@/lib/logger'

/**
 * Realtime nudge for a flow run: broadcast a tick on a per-run channel the
 * instant a step changes, so the builder refreshes immediately instead of
 * waiting for its 2s poll. Reuses Supabase Realtime (already in the stack for
 * Jam collab) via the broadcast REST endpoint — no persistent socket from the
 * server, and a graceful no-op when Supabase isn't configured (local/CI), where
 * the poll fallback still drives updates.
 *
 * SECURITY: the payload carries only nodeId + status — never step output. The
 * run's full data is fetched over the authenticated runs API; the channel name
 * embeds the unguessable run id (the same capability model as Jam collab), so no
 * sensitive data rides the wire.
 */
export function broadcastFlowRunTick(runId: string, payload: { nodeId?: string; status: string }): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return
  void fetch(`${url}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [{ topic: flowRunChannel(runId), event: 'tick', payload }] }),
  }).catch((error) => apiLogger.warn('broadcastFlowRunTick failed', { error: error instanceof Error ? error.message : String(error) }))
}

/** The Realtime channel name for a run — shared by the server broadcaster and
 *  the client subscriber so both agree on the topic. */
export function flowRunChannel(runId: string): string {
  return `flow-run:${runId}`
}
