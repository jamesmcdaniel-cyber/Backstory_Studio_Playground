'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { EMBED_CONNECT_DONE_MESSAGE, isEmbedded, openEmbeddedPopup } from '@/lib/embed'

const POLL_MS = 1_500
/** Long enough for an SSO round trip with an MFA prompt in it, short enough
 *  that an abandoned popup stops the spinner rather than spinning forever. */
const GIVE_UP_MS = 5 * 60 * 1_000

export type EmbeddedOAuthLaunch = {
  /** The flow as the POPUP runs it — its returnTo must be EMBED_COMPLETE_PATH,
   *  the one landing page that notifies this frame and closes itself. */
  popupHref: string
  popupName: string
  /** Re-read the server; true once the flow really landed. The popup's
   *  message only ever prompts this — it is never the verdict. */
  check: () => Promise<boolean>
  /** Runs once, when the server confirms: refresh the surface in place. */
  onDone?: () => void
  /** Which control is waiting, for surfaces with one control per row. */
  key?: string
}

export type EmbeddedOAuthState = {
  /** The key of the launch in flight (popupName when none was given). */
  waitingFor: string | null
  blocked: boolean
  timedOut: boolean
  /** Ask the server now, for the "I finished in the other window" control. */
  checkNow: () => void
}

/**
 * Every OAuth redirect started inside the embedded app (the Salesforce frame)
 * runs here instead of in the frame.
 *
 * Followed by the frame, such a redirect is a dead end twice over: the
 * identity provider refuses to render framed, and the flow's SameSite=Lax
 * state cookie is never stored in a third-party context, so even a provider
 * that did render would land on a callback that finds no state. A popup is
 * top-level and first-party, where both hold. The frame then learns the flow
 * finished the way ConnectAction always has: the landing page's postMessage as
 * the fast path, polling the server as the path that always works (an IdP's
 * COOP can sever window.opener mid-flow, and with it the message).
 *
 * `launch` is the one call sites use: framed, it opens the popup and returns
 * true; top-level it returns false and the caller navigates exactly as it
 * always did. `launchFromLink` is the same for an <a> to the start route (the
 * default action is only prevented when the popup took over). `open` always
 * uses the popup, for a caller that already knows.
 */
export function useEmbeddedOAuth(): EmbeddedOAuthState & {
  open: (launch: EmbeddedOAuthLaunch) => boolean
  launch: (launch: EmbeddedOAuthLaunch) => boolean
  launchFromLink: (event: { preventDefault: () => void }, launch: EmbeddedOAuthLaunch) => void
} {
  const [active, setActive] = useState<EmbeddedOAuthLaunch | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  // Held in a ref so a re-rendered parent cannot restart the poll, and so
  // checkNow always asks with the launch actually in flight.
  const activeRef = useRef(active)
  activeRef.current = active
  const settlingRef = useRef(false)

  const settle = useCallback(async (launch: EmbeddedOAuthLaunch, isCancelled: () => boolean) => {
    if (isCancelled() || settlingRef.current) return
    settlingRef.current = true
    try {
      const done = await launch.check().catch(() => false)
      if (done && !isCancelled() && activeRef.current === launch) {
        setActive(null)
        launch.onDone?.()
      }
    } finally {
      settlingRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const isCancelled = () => cancelled
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data !== EMBED_CONNECT_DONE_MESSAGE) return
      // "Look again", never "it worked" — the server decides.
      void settle(active, isCancelled)
    }
    window.addEventListener('message', onMessage)
    const poll = setInterval(() => void settle(active, isCancelled), POLL_MS)
    const deadline = setTimeout(() => {
      if (cancelled) return
      setActive(null)
      setTimedOut(true)
    }, GIVE_UP_MS)
    return () => {
      cancelled = true
      window.removeEventListener('message', onMessage)
      clearInterval(poll)
      clearTimeout(deadline)
    }
  }, [active, settle])

  const open = useCallback((launch: EmbeddedOAuthLaunch) => {
    // Synchronous with the click: an awaited step first would cost the user
    // gesture, and the browser would block the popup.
    const popup = openEmbeddedPopup(launch.popupHref, launch.popupName)
    setTimedOut(false)
    if (!popup) {
      setBlocked(true)
      return true
    }
    setBlocked(false)
    setActive(launch)
    return true
  }, [])

  const launch = useCallback((next: EmbeddedOAuthLaunch) => (isEmbedded() ? open(next) : false), [open])

  // For a control that is a real link to the start route: top-level the click
  // is left alone and the browser follows the href as it always has.
  const launchFromLink = useCallback(
    (event: { preventDefault: () => void }, next: EmbeddedOAuthLaunch) => {
      if (launch(next)) event.preventDefault()
    },
    [launch],
  )

  const checkNow = useCallback(() => {
    const current = activeRef.current
    if (current) void settle(current, () => false)
  }, [settle])

  return {
    waitingFor: active ? (active.key ?? active.popupName) : null,
    blocked,
    timedOut,
    checkNow,
    open,
    launch,
    launchFromLink,
  }
}
