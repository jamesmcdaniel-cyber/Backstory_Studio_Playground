'use client'

import { useEffect, useState } from 'react'
import { resolveEmbedCompletion, type EmbedCompletion } from '@/lib/embed'

const COPY: Record<EmbedCompletion['outcome'], { title: string; detail: string }> = {
  'signed-in': {
    title: "You're signed in.",
    detail:
      'This window will try to close itself — if it stays open, close it and head back to the Salesforce tab. Your workspace is already loading there.',
  },
  connected: {
    title: 'Connected.',
    detail:
      'This window will try to close itself — if it stays open, close it and head back to the Salesforce tab. Setup carries on there.',
  },
  failed: {
    title: "That connection didn't finish.",
    detail:
      'Close this window and try the step again from the Salesforce tab. If it keeps failing, contact support.',
  },
}

/**
 * The popup's landing page for every flow the embedded app cannot run in the
 * frame — sign-in and both OAuth connect steps. By the time this renders the
 * work is done (or has failed); the only job left is telling the frame which
 * it was and getting out of the user's way.
 */
export function EmbeddedComplete() {
  // Resolved after mount: the server render cannot see the query string the
  // callback appended, and must match the first client render.
  const [completion, setCompletion] = useState<EmbedCompletion | null>(null)

  useEffect(() => {
    const resolved = resolveEmbedCompletion(window.location.search)
    setCompletion(resolved)
    try {
      // Same-origin only: the embedded gateway checks event.origin too.
      window.opener?.postMessage(resolved.message, window.location.origin)
    } catch {
      // Opener severed by an IdP's COOP mid-flow — the frame's poll covers it.
    }
    // A failure stays on screen: it is the only place the reason is legible,
    // and the frame has already been told to stop waiting.
    if (resolved.outcome === 'failed') return
    const timer = setTimeout(() => window.close(), 1200)
    return () => clearTimeout(timer)
  }, [])

  const copy = COPY[completion?.outcome ?? 'signed-in']

  return (
    <main className="flex min-h-screen items-center justify-center bg-graphite-950 p-6 text-center text-white">
      <div>
        <p className="text-lg font-medium">{copy.title}</p>
        <p className="mt-2 text-sm text-white/60">{copy.detail}</p>
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
