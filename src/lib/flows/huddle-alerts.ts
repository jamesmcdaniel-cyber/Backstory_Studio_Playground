/** The slice of CollabParticipant this policy needs. */
export type HuddleParticipant = { clientId: string; name: string; inHuddle?: boolean }

export type RingKind = 'jam' | 'huddle'

const inHuddleOthers = (list: HuddleParticipant[], selfClientId: string) =>
  list.filter((participant) => participant.inHuddle && participant.clientId !== selfClientId)

/**
 * Names the person who just started a huddle, or null when there is nothing to
 * announce. Fires only on the ZERO-TO-ONE transition, so a five-person huddle
 * produces one toast rather than one per joiner.
 *
 * Self is filtered from both sides, which is why the ordering of setJoined and
 * setInHuddle inside join() cannot produce a phantom "someone started" toast
 * for your own huddle.
 */
export function detectHuddleStart(
  prev: HuddleParticipant[],
  next: HuddleParticipant[],
  selfClientId: string,
  selfJoined: boolean,
): string | null {
  if (selfJoined) return null // you are in it; the bar is right there
  if (inHuddleOthers(prev, selfClientId).length > 0) return null
  const starters = inHuddleOthers(next, selfClientId)
  return starters.length > 0 ? starters[0].name : null
}

/**
 * Copy for a ring. The `jam` branch reproduces exactly what the invite endpoint
 * sent before `kind` existed — changing it would silently alter every existing
 * invite notification.
 */
export function ringNotification(
  kind: RingKind,
  inviterName: string,
  flowName: string,
  flowId: string,
): { type: string; level: 'action'; title: string; body: string; link: string } {
  const link = `/flows/${flowId}`
  if (kind === 'huddle') {
    return {
      type: 'flow.huddle_started',
      level: 'action',
      title: `${inviterName} started a huddle`,
      body: `Join the voice huddle on “${flowName}”.`,
      link,
    }
  }
  return {
    type: 'flow.jam_invite',
    level: 'action',
    title: `${inviterName} invited you to jam`,
    body: `Join “${flowName}” to edit it together in real time.`,
    link,
  }
}
