'use client'

import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EmbeddedOAuthState } from '@/hooks/use-embedded-oauth'

/**
 * What a surface says while an OAuth flow runs in the embedded popup: that it
 * is waiting, how to nudge it, that it gave up, or that the popup was blocked.
 * Renders nothing top-level, where the flow is a plain redirect and none of
 * these states can happen.
 */
export function EmbeddedOAuthStatus({ state, className, waitingLabel = 'Waiting for you to finish signing in in the other window…' }: {
  state: EmbeddedOAuthState
  className?: string
  waitingLabel?: string
}) {
  const { waitingFor, blocked, timedOut, checkNow } = state
  if (!waitingFor && !blocked && !timedOut) return null
  return (
    <div className={cn('space-y-1 text-xs', className)}>
      {waitingFor && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          <span>{waitingLabel}</span>
          <button type="button" onClick={checkNow} className="underline underline-offset-2">
            I finished in the other window — check now
          </button>
        </p>
      )}
      {timedOut && !waitingFor && (
        <p className="text-fg-muted">
          We stopped waiting. If you finished in the other window, try again — it will pick up where it left off.
        </p>
      )}
      {blocked && (
        <p role="alert" className="text-red-600">
          The sign-in window was blocked. Allow pop-ups for this page and try again.
        </p>
      )}
    </div>
  )
}
