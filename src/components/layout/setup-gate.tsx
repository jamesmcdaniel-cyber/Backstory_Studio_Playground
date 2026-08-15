'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

type SetupStatus = { entitled: boolean; backstoryConnected: boolean }

/**
 * Where the setup-status response says this session must go before the app can
 * load, or null to render (fail-open on transient failures — APIs still gate).
 *
 * MFA_REQUIRED is a session-level refusal, not a setup step: every API answers
 * 403 with it (privileged accounts are held to MFA whatever the workspace
 * policy says), so without a route here the app renders as a dead shell of
 * failed requests. /auth/mfa is the public enrollment page named by
 * requireAuthContext as the recovery path.
 */
export function resolveSetupNavigation(data: unknown): string | null {
  const payload = data as { success?: boolean; backstoryConnected?: boolean; code?: string } | null
  if (payload?.success) {
    return payload.backstoryConnected ? null : '/connect'
  }
  if (payload?.code === 'SSO_REQUIRED') return '/auth/sso-required'
  if (payload?.code === 'MFA_REQUIRED') return '/auth/mfa'
  return null
}

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
        const destination = resolveSetupNavigation(data)
        if (destination) {
          window.location.assign(destination)
          return
        }
        if (data?.success) {
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
