export type PersisterCandidate = { clientId: string; userId: string; canEdit?: boolean }

/**
 * Deterministically pick the ONE client that persists during a jam: the flow
 * owner's lowest clientId when the owner is present as an editor, else the
 * lowest editor clientId overall. Input order must not matter — every peer
 * computes this from its own presence snapshot and must reach the same
 * answer, or two clients would race the optimistic lock.
 */
export function electPersister(candidates: PersisterCandidate[], ownerUserId?: string | null): string | null {
  const editors = candidates.filter((c) => c.canEdit)
  if (!editors.length) return null
  const pool = ownerUserId && editors.some((c) => c.userId === ownerUserId)
    ? editors.filter((c) => c.userId === ownerUserId)
    : editors
  return pool.map((c) => c.clientId).sort()[0] ?? null
}

/**
 * Should THIS client write the graph to Postgres?
 *
 * `electPersister` answers "who, among the peers presence reports". That is the
 * right question during a jam and the wrong one when presence reports nothing:
 * the roster is fed exclusively by realtime presence, it starts empty, and it
 * STAYS empty when the jam channel can't subscribe (it fails closed by design —
 * there is no public-channel fallback). An empty roster elects nobody, so
 * autosave was gated off entirely and a solo editor's canvas edits — a dragged
 * node most visibly, since a drag has no dirty-state prompt — were discarded on
 * navigation.
 *
 * So: if presence reports NO peers, we are the only writer there can be, and we
 * persist our own work. The moment presence reports anyone, it also reports us,
 * and the jam election takes over unchanged — which keeps the single-writer
 * guarantee that stops peers racing the optimistic lock.
 */
export function shouldPersistGraph(params: {
  roster: PersisterCandidate[]
  selfClientId: string
  selfUserId: string
  canEdit: boolean
  ownerId?: string | null
}): boolean {
  if (!params.canEdit) return false
  if (!params.roster.length) return true
  return electPersister(params.roster, params.ownerId) === params.selfClientId
}

/**
 * When a newcomer joins, exactly ONE existing client answers with the full
 * live graph (lowest clientId among those already present) — instead of every
 * peer blasting a bootstrap at once.
 */
export function shouldAnswerBootstrap(
  presentClientIds: string[],
  joiningClientId: string,
  selfClientId: string,
): boolean {
  const others = presentClientIds.filter((id) => id !== joiningClientId).sort()
  return others.length > 0 && others[0] === selfClientId
}

/**
 * Client-side audit coalescing for jam autosave: at most one flow-edited
 * audit row per window instead of one per debounce tick, so the activity
 * timeline isn't flooded by a live session.
 */
export function shouldRecordJamAudit(lastRecordedAt: number, now: number, windowMs = 10 * 60 * 1000): boolean {
  return now - lastRecordedAt >= windowMs
}
