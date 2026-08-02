/** The slice of presence the capture policy reads. */
export type CaptureParticipant = {
  clientId: string
  inHuddle?: boolean
  capturing?: boolean
  captureSessionId?: string | null
}

/**
 * The capture session currently live in the room, if any. Whoever enabled
 * capture advertises it via presence; late joiners read it from the roster.
 * Only participants actively capturing count — a stale id on someone who
 * switched capture off must not resurrect a session.
 */
export function liveCaptureSession(roster: CaptureParticipant[]): string | null {
  for (const participant of roster) {
    if (participant.capturing && participant.captureSessionId) return participant.captureSessionId
  }
  return null
}

/**
 * Whether THIS client, on leaving, should trigger the summary: it knew of a
 * session and nobody is left in the huddle. Both last participants may answer
 * yes at once — the summary endpoint is idempotent and its unique constraint
 * settles the race, so erring towards "yes" only costs a no-op request.
 */
export function shouldSummarize(sessionId: string | null, remaining: CaptureParticipant[]): boolean {
  if (!sessionId) return false
  return !remaining.some((participant) => participant.inHuddle)
}
