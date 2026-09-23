'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { EMBED_CONNECT_DONE_MESSAGE, openEmbeddedPopup } from '@/lib/embed'

const POLL_MS = 1_500
/** Long enough for an SSO round trip with an MFA prompt in it, short enough
 *  that an abandoned popup stops the spinner rather than spinning forever. */
const GIVE_UP_MS = 5 * 60 * 1_000

type Props = {
  href: string
  label: string
  popupName: string
  embedded: boolean
  disabled?: boolean
  /** Re-read the server's setup status; true once THIS step is done. */
  check: () => Promise<boolean>
}

const BUTTON_CLASS =
  'mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-1 transition-all duration-fast ease-out-quart hover:bg-gray-800 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] aria-disabled:pointer-events-none aria-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50'

/**
 * One onboarding OAuth hand-off, rendered the only way its context allows.
 *
 * Top-level, it is a plain link — the browser follows the redirect chain and
 * comes back to /connect. Inside the Salesforce frame that exact link is a dead
 * end: the identity provider refuses to render framed, and the flow's
 * SameSite=Lax state cookie is never stored in a third-party context, so the
 * callback finds no state and redirects the frame back to step 1 — which is
 * what new users were hitting. Embedded, the same URL is opened in a popup,
 * where the flow is top-level and first-party, and the frame waits for the
 * server to agree the step is done: postMessage as the fast path, polling as
 * the one that always works (an IdP's COOP can sever the opener mid-flow).
 */
export function ConnectAction({ href, label, popupName, embedded, disabled, check }: Props) {
  const [waiting, setWaiting] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  // Held in a ref so a re-rendered parent cannot restart the poll.
  const checkRef = useRef(check)
  checkRef.current = check

  useEffect(() => {
    if (!waiting) return
    let cancelled = false
    const settle = async () => {
      if (cancelled) return
      if (await checkRef.current()) {
        if (!cancelled) setWaiting(false)
      }
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data !== EMBED_CONNECT_DONE_MESSAGE) return
      // The message says "look again", never "it worked" — the server decides.
      void settle()
    }
    window.addEventListener('message', onMessage)
    const poll = setInterval(() => void settle(), POLL_MS)
    const deadline = setTimeout(() => {
      if (cancelled) return
      setWaiting(false)
      setTimedOut(true)
    }, GIVE_UP_MS)
    return () => {
      cancelled = true
      window.removeEventListener('message', onMessage)
      clearInterval(poll)
      clearTimeout(deadline)
    }
  }, [waiting])

  if (!embedded) {
    return (
      <a href={href} aria-disabled={disabled} className={BUTTON_CLASS}>
        {label} <ArrowRight className="h-4 w-4" />
      </a>
    )
  }

  const start = () => {
    const popup = openEmbeddedPopup(href, popupName)
    if (!popup) {
      setBlocked(true)
      return
    }
    setBlocked(false)
    setTimedOut(false)
    setWaiting(true)
  }

  return (
    <div>
      <button type="button" onClick={start} disabled={disabled || waiting} className={BUTTON_CLASS}>
        {waiting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for the connection…
          </>
        ) : (
          <>
            {label} <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
      {waiting && (
        <button
          type="button"
          onClick={() => void checkRef.current()}
          className="mt-2 text-xs text-fg-muted underline underline-offset-2"
        >
          I finished in the other window — check now
        </button>
      )}
      {timedOut && (
        <p className="mt-2 text-xs text-fg-muted">
          We stopped waiting. If you finished in the other window, try again — it will pick up where it left off.
        </p>
      )}
      {blocked && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          The connection window was blocked. Allow pop-ups for this page and try again.
        </p>
      )}
    </div>
  )
}
