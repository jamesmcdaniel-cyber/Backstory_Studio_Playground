/**
 * One write at a time per flow, from this browser tab.
 *
 * The builder writes the flow row from several places: the debounced autosave,
 * an explicit Save, the settings and sharing panels, clearing import notes,
 * and webhook-secret mints in the trigger editor. Each sends the
 * optimistic-concurrency base it last saw, so two of them in flight together
 * sent the SAME base: the server rightly refused the second as a stale write
 * (409 FLOW_STALE_WRITE) and the page reloaded with "A teammate saved changes"
 * — the teammate being the user's own first save.
 *
 * Queued writes run in order, and each builds its request when its turn
 * comes, so it carries the base the previous write returned. Pass a thunk that
 * creates the fetch, not a started fetch.
 *
 * A write that never settles (a dropped connection mid-deploy) must not freeze
 * saving for the rest of the session: the next write waits for it at most
 * QUEUE_WAIT_MS, then goes anyway (worst case: the old stale-write refusal).
 */
const chains = new Map<string, Promise<void>>()
export const QUEUE_WAIT_MS = 30_000

export function queueFlowWrite<T>(flowId: string, write: () => Promise<T>): Promise<T> {
  const previous = chains.get(flowId) ?? Promise.resolve()
  const run = previous.then(write)
  const done = run.then(() => undefined, () => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = Promise.race([done, new Promise<void>((resolve) => { timer = setTimeout(resolve, QUEUE_WAIT_MS) })])
    .finally(() => clearTimeout(timer))
  chains.set(flowId, settled)
  void settled.then(() => { if (chains.get(flowId) === settled) chains.delete(flowId) })
  return run
}
