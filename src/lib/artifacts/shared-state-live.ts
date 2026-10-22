/**
 * Live shared artifact state — the part both sides agree on, plus the viewer's
 * relay. No server or browser imports: the server broadcaster
 * (shared-state.ts) and the viewer (stateful-artifact-frame.tsx) both use it.
 *
 * The wire: after a successful compare-and-set, the server fires a `tick` on
 * `artifact-shared:<artifactId>` carrying `{ key, revision }` and nothing else.
 * A viewer that hears it refetches the key over the authenticated
 * GET /api/artifacts/:id/shared-state and hands the value to its frame.
 *
 * SECURITY: tick topics are public Supabase broadcast channels — the same
 * capability model as `flow-run:<id>` / `agent-exec:<id>`: the topic embeds an
 * unguessable artifact UUID, and the payload is only a state key name (a short
 * identifier the page author picked) and an integer revision. Someone in
 * another org who somehow learned the UUID learns "key X changed, now at
 * revision N" — no value, no user, no tenant data; reading the value still
 * goes through the route's org scope and requireReadable check.
 */

const KEY = /^[a-zA-Z0-9_-]{1,64}$/

/** The broadcast topic for an artifact's shared state. */
export function artifactSharedChannel(artifactId: string): string {
  return `artifact-shared:${artifactId}`
}

export type SharedTick = { key: string; revision: number }
export type SharedChange = SharedTick & { value: unknown }

/** A tick's payload as the viewer accepts it: a valid key and a positive integer revision. */
export function parseSharedTick(payload: unknown): SharedTick | null {
  if (!payload || typeof payload !== 'object') return null
  const { key, revision } = payload as Record<string, unknown>
  if (typeof key !== 'string' || !KEY.test(key)) return null
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  return { key, revision }
}

export function isSharedStateKey(key: unknown): key is string {
  return typeof key === 'string' && KEY.test(key)
}

type Timer = ReturnType<typeof setTimeout>

/**
 * The viewer's side of live shared state, for one frame:
 *  - only keys the frame has asked about are followed (`watch`);
 *  - `observe` records revisions the frame already holds (its own reads and
 *    writes, relayed through the bridge), so the echo of its own save — the
 *    tick for the revision it just wrote — is dropped;
 *  - ticks that arrive while the frame's own write to that key is in flight
 *    are held until it settles, then judged against the revision it got
 *    (the tick can beat the PUT's response);
 *  - bursts coalesce: a trailing debounce, capped so a key that changes
 *    constantly still refreshes, and one fetch per key at a time.
 */
export function createSharedStateRelay(options: {
  fetchLatest: (key: string) => Promise<{ value: unknown; revision: number }>
  deliver: (change: SharedChange) => void
  debounceMs?: number
  maxWaitMs?: number
  maxKeys?: number
}) {
  const debounceMs = options.debounceMs ?? 200
  const maxWaitMs = options.maxWaitMs ?? 1_000
  const maxKeys = options.maxKeys ?? 32
  const watched = new Set<string>()
  const known = new Map<string, number>()
  const writing = new Map<string, number>()
  const held = new Map<string, number>()
  const timers = new Map<string, { timer: Timer; first: number }>()
  const fetching = new Set<string>()
  const again = new Set<string>()
  let disposed = false

  const behind = (key: string, revision: number) => revision > (known.get(key) ?? 0)
  const observe = (key: string, revision: unknown) => {
    if (typeof revision === 'number' && Number.isInteger(revision) && behind(key, revision)) known.set(key, revision)
  }

  function schedule(key: string) {
    if (disposed) return
    const now = Date.now()
    const existing = timers.get(key)
    if (existing) clearTimeout(existing.timer)
    const first = existing?.first ?? now
    const wait = Math.max(0, Math.min(debounceMs, first + maxWaitMs - now))
    timers.set(key, { first, timer: setTimeout(() => { timers.delete(key); void run(key) }, wait) })
  }

  async function run(key: string) {
    if (disposed) return
    if (fetching.has(key)) { again.add(key); return }
    fetching.add(key)
    try {
      const latest = await options.fetchLatest(key)
      if (disposed || !Number.isInteger(latest.revision) || !behind(key, latest.revision)) return
      // A write of the frame's own that started meanwhile decides first.
      if (writing.get(key)) { held.set(key, Math.max(held.get(key) ?? 0, latest.revision)); return }
      known.set(key, latest.revision)
      options.deliver({ key, value: latest.value, revision: latest.revision })
    } catch {
      // A failed refetch is not the page's problem: the next tick, a reload or
      // the page's next save (its revision check) reconciles.
    } finally {
      fetching.delete(key)
      if (again.delete(key)) schedule(key)
    }
  }

  return {
    /** The frame reads or writes this key, so changes to it are followed. */
    watch(key: string): boolean {
      if (!isSharedStateKey(key)) return false
      if (!watched.has(key) && watched.size >= maxKeys) return false
      watched.add(key)
      return true
    },
    /** The frame holds this revision (from a read or its own write). */
    observe,
    beginWrite(key: string) {
      writing.set(key, (writing.get(key) ?? 0) + 1)
    },
    /** The frame's write settled; `revision` is what it got (undefined when it failed). */
    endWrite(key: string, revision?: unknown) {
      observe(key, revision)
      const left = (writing.get(key) ?? 1) - 1
      if (left > 0) { writing.set(key, left); return }
      writing.delete(key)
      const pending = held.get(key)
      held.delete(key)
      if (pending !== undefined && behind(key, pending)) schedule(key)
    },
    /** A broadcast tick arrived on the artifact's topic. */
    tick(payload: unknown) {
      const tick = parseSharedTick(payload)
      if (!tick || disposed || !watched.has(tick.key) || !behind(tick.key, tick.revision)) return
      if (writing.get(tick.key)) { held.set(tick.key, Math.max(held.get(tick.key) ?? 0, tick.revision)); return }
      schedule(tick.key)
    },
    dispose() {
      disposed = true
      for (const { timer } of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
