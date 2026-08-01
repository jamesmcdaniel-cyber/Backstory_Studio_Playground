export type PeerAction = 'wait' | 'restart-ice' | 'close'

/** `disconnected` is frequently transient — a wifi blip, a network switch.
 *  Waiting this long before acting avoids tearing down a link that recovers
 *  on its own, which is what the huddle used to do. */
export const PEER_GRACE_MS = 5_000

export const PEER_MAX_RESTARTS = 2

const BACKOFF_MS = [1_000, 4_000]

/**
 * What to do about a peer in trouble. Only the side that originally sent the
 * offer restarts, mirroring the deterministic-initiator rule in
 * huddle-signals.ts — if both sides restarted we would recreate the glare that
 * rule exists to prevent.
 */
export function nextPeerAction(
  state: RTCPeerConnectionState,
  attempts: number,
  isInitiator: boolean,
): PeerAction {
  if (state === 'closed') return 'close'
  if (state !== 'disconnected' && state !== 'failed') return 'wait'
  if (attempts >= PEER_MAX_RESTARTS) return 'close'
  return isInitiator ? 'restart-ice' : 'wait'
}

/** How long to wait before acting: a grace period for the first transient
 *  disconnect, capped backoff after that. `failed` is terminal — no grace. */
export function recoveryDelayMs(state: RTCPeerConnectionState, attempts: number): number {
  if (attempts === 0) return state === 'failed' ? 0 : PEER_GRACE_MS
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]
}
