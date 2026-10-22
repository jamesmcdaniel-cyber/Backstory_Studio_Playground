/**
 * An end-to-end bound for one streamed model call.
 *
 * The SDK's `timeout` covers the fetch, which for a stream resolves when the
 * response HEADERS arrive — after that, a stream that stalls or trickles has
 * no bound at all, and the caller (an agent run, an interactive request) hangs
 * with it. This aborts the call at an overall deadline, and earlier when no
 * stream event has arrived for `idleMs`; the abort surfaces as an error that
 * says which bound tripped, not the SDK's bare "Request was aborted."
 *
 * Usage: pass `signal` to the SDK call, call `touch()` on every stream event,
 * run the call through `guard()`, and always `clear()` in a finally.
 */
export function streamDeadline(opts: { totalMs: number; idleMs: number; label: string }) {
  const controller = new AbortController()
  let reason: string | null = null
  const abort = (message: string) => {
    if (reason) return
    reason = message
    controller.abort(new Error(message))
  }
  const minutes = (ms: number) => `${Math.round((ms / 60_000) * 10) / 10} min`
  const total = setTimeout(() => abort(`${opts.label} exceeded its ${minutes(opts.totalMs)} deadline.`), opts.totalMs)
  let idle = setTimeout(() => abort(`${opts.label} stalled: nothing streamed for ${minutes(opts.idleMs)}.`), opts.idleMs)
  return {
    signal: controller.signal,
    touch() {
      if (reason) return
      clearTimeout(idle)
      idle = setTimeout(() => abort(`${opts.label} stalled: nothing streamed for ${minutes(opts.idleMs)}.`), opts.idleMs)
    },
    /** Await the call; if a bound tripped, throw the bound's message instead of the SDK's abort error. */
    async guard<T>(call: Promise<T>): Promise<T> {
      try {
        return await call
      } catch (error) {
        if (reason) throw new Error(reason)
        throw error
      }
    },
    clear() {
      clearTimeout(total)
      clearTimeout(idle)
    },
  }
}
