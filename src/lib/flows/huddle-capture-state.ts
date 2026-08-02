/** The slice of presence the capture policy reads. */
export type CaptureParticipant = {
  clientId: string
  inHuddle?: boolean
  capturing?: boolean
  captureSessionId?: string | null
}

/**
 * The capture session currently live in the room, if any.
 *
 * Ownership: only the participant who ENABLED note-taking advertises the
 * session id; followers advertise just their own `capturing` flag. That
 * asymmetry is what makes "turn note-taking off" possible — if followers
 * re-advertised the id, they would keep the session alive for each other and
 * nobody could end it. The owner's `capturing` flag is deliberately not
 * required: an owner who opted their own voice out still keeps the session
 * running for everyone else.
 */
export function liveCaptureSession(roster: CaptureParticipant[]): string | null {
  for (const participant of roster) {
    if (participant.captureSessionId) return participant.captureSessionId
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
