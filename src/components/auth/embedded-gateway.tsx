'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { EMBED_SIGNIN_MESSAGE, openEmbeddedSignIn, probeSession } from '@/lib/embed'

/**
 * Sign-in for the app running inside an iframe (a Salesforce tab).
 *
 * OAuth cannot run in a frame — Google returns 403 to framed sign-ins — so
 * the button opens the real login page in a popup and this panel waits for
 * the session to exist, then reloads the frame (the middleware then routes it
 * to wherever the frame was originally headed). Two detection paths, because
 * the popup's opener link can be severed by an IdP's COOP headers mid-flow:
 * a postMessage fast path, and a same-origin session poll that always works.
 */
export function EmbeddedGateway() {
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
    <main className="flex min-h-screen items-center justify-center bg-white p-6">
      <div className="w-full max-w-sm text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/backstory-symbol-black.png" alt="Backstory" className="mx-auto h-10 w-auto" />
        <h1 className="mt-5 text-xl font-semibold text-graphite-900">Sign in to Backstory</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {waiting
            ? 'Finish signing in using the window that just opened. This page will continue on its own.'
            : 'Sign-in opens in its own window — identity providers do not allow signing in inside an embedded page.'}
        </p>
        <Button className="mt-6 h-12 w-full rounded-xl" loading={waiting} onClick={start}>
          {waiting ? 'Waiting for sign-in…' : 'Sign in'}
        </Button>
        {waiting && (
          <button type="button" onClick={() => window.location.reload()} className="mt-3 text-xs text-fg-muted underline underline-offset-2">
            I finished signing in — continue
          </button>
        )}
        {blocked && (
          <p className="mt-3 text-xs text-red-600">
            The sign-in window was blocked. Allow pop-ups for this page and try again.
          </p>
        )}
      </div>
    </main>
  )
}
