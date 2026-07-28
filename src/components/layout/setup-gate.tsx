'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

type SetupStatus = { entitled: boolean; backstoryConnected: boolean }

/**
 * Hard onboarding gate for app routes: until the signed-in user has an
 * authorized Backstory MCP connection, every app surface redirects to the
 * /connect setup flow. Server APIs enforce the same rule (403
 * BACKSTORY_MCP_REQUIRED) — this component is the navigation counterpart.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/setup/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        if (data?.success) {
          if (!data.backstoryConnected) {
            window.location.assign('/connect')
            return
          }
          setStatus({ entitled: Boolean(data.entitled), backstoryConnected: true })
        } else {
          // Status endpoint failed (401 handled by middleware; transient 5xx):
          // fail open so an outage doesn't lock the product. APIs still gate.
          setStatus({ entitled: true, backstoryConnected: true })
        }
      })
      .catch(() => {
        if (!cancelled) setStatus({ entitled: true, backstoryConnected: true })
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!status) {
    return (
      <div className="flex h-full min-h-[40dvh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return <>{children}</>
}
