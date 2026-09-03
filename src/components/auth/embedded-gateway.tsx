'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { EMBED_SIGNIN_MESSAGE, openEmbeddedSignIn, probeSession } from '@/lib/embed'

/**
 * The sign-in ACTIONS for the app running inside an iframe (a Salesforce tab),
 * rendered inside the normal AuthGateway layout so the embedded page carries
 * the same design as the landing page rather than a bare stand-in.
 *
 * OAuth cannot run in a frame — Google returns 403 to framed sign-ins — so
 * the button opens the real login page in a popup and this block waits for the
 * session to exist, then reloads the frame. Two detection paths, because the
 * popup's opener link can be severed by an IdP's COOP headers mid-flow: a
 * postMessage fast path, and a same-origin session poll that always works.
 */
export function EmbeddedSignInActions() {
  const [waiting, setWaiting] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data === EMBED_SIGNIN_MESSAGE) {
        window.location.reload()
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const start = () => {
    const popup = openEmbeddedSignIn()
    if (!popup) {
      // Popup blocked: nothing opened, so there is nothing to wait for.
      setBlocked(true)
      return
    }
    setBlocked(false)
    setWaiting(true)
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      if (await probeSession()) window.location.reload()
    }, 1500)
  }

  return (
    <div>
      <Button
        className="h-14 w-full rounded-xl text-base font-semibold shadow-2 hover:shadow-3"
        loading={waiting}
        onClick={start}
      >
        {waiting ? 'Waiting for sign-in…' : 'Sign in'}
      </Button>
      {waiting && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 text-xs text-fg-muted underline underline-offset-2"
        >
          I finished signing in — continue
        </button>
      )}
      {blocked && (
        <p role="alert" className="mt-3 text-xs text-red-600">
          The sign-in window was blocked. Allow pop-ups for this page and try again.
        </p>
      )}
    </div>
  )
}
