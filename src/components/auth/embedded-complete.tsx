'use client'

import { useEffect } from 'react'
import { EMBED_SIGNIN_MESSAGE } from '@/lib/embed'

/**
 * The sign-in popup's landing page for embedded flows. By the time this
 * renders, the session cookies are set — the only job left is telling the
 * embedded frame (fast path; the frame also polls, so a severed opener is
 * harmless) and getting out of the user's way.
 */
export function EmbeddedComplete() {
  useEffect(() => {
    try {
      // Same-origin only: the embedded gateway checks event.origin too.
      window.opener?.postMessage(EMBED_SIGNIN_MESSAGE, window.location.origin)
    } catch {
      // Opener severed by an IdP's COOP mid-flow — the frame's poll covers it.
    }
    const timer = setTimeout(() => window.close(), 1200)
    return () => clearTimeout(timer)
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center bg-graphite-950 p-6 text-center text-white">
      <div>
        <p className="text-lg font-medium">You&apos;re signed in.</p>
        <p className="mt-2 text-sm text-white/60">
          This window will try to close itself — if it stays open, close it and
          head back to the Salesforce tab. Your workspace is already loading there.
        </p>
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-5 rounded-lg border border-white/20 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
        >
          Close window
        </button>
      </div>
    </main>
  )
}
