'use client'

/**
 * An interval that only runs while the tab is actually being looked at.
 *
 * The run-progress pollers tick every 2s, which is right when someone is
 * watching a run execute and pure waste when they are not. A backgrounded tab
 * left open on a long run kept issuing an authenticated request every 2 seconds
 * — indefinitely, invisibly, and multiplied by however many tabs and people are
 * in that state. Browsers throttle background timers, but they do not stop
 * them, and throttled-but-alive is still load on the API.
 *
 * The app-shell pollers (sidebar, notification bell, agents list) already gate
 * on `document.hidden`; this is the same behaviour, extracted so the per-run
 * pollers get it too.
 *
 * Returning to the tab fires `tick` immediately rather than waiting out the
 * remaining delay — otherwise pausing would show stale state at exactly the
 * moment someone came back to check on it.
 */
export function startVisibleInterval(tick: () => void, delayMs: number): () => void {
  if (typeof window === 'undefined') return () => {}

  const timer = window.setInterval(() => {
    if (!document.hidden) tick()
  }, delayMs)

  const onVisibility = () => {
    if (!document.hidden) tick()
  }
  document.addEventListener('visibilitychange', onVisibility)

  return () => {
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
