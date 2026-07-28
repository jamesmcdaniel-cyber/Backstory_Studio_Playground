'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Nango, { type ConnectUI } from '@nangohq/frontend'
import { toast } from 'sonner'

/**
 * The Nango connect / verify / disconnect round-trip, shared by every surface
 * that can start a connection — the integrations grid AND the in-context
 * connect dialog that templates open. One copy means the connect-UI lifecycle
 * (session token, close on failure, verify right after connecting) behaves
 * identically wherever a user connects from.
 *
 * `overlayActive` is true while Nango's own modal owns the screen. Callers that
 * live inside a modal MUST hide theirs while it's set: Nango mounts its iframe
 * on document.body, and a Radix dialog's focus trap and `pointer-events: none`
 * would otherwise make that iframe unclickable.
 */

export type ConnectableIntegration = { id: string; name: string }

export function useNangoConnect(onChanged?: () => void | Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [overlayActive, setOverlayActive] = useState(false)
  const connectUIRef = useRef<ConnectUI | null>(null)
  // A successful connect schedules a verify; the connect UI's own `close` event
  // must not drop the overlay flag before that finishes, or a host dialog pops
  // back up mid-verification.
  const verifyPendingRef = useRef(false)
  // Held in a ref so handlers stay stable even when the caller passes an inline
  // callback — a re-created `connect` mid-flow would strand the open UI.
  const changedRef = useRef(onChanged)
  useEffect(() => {
    changedRef.current = onChanged
  }, [onChanged])

  useEffect(() => {
    return () => {
      connectUIRef.current?.close()
      connectUIRef.current = null
    }
  }, [])

  const notifyChanged = useCallback(async () => {
    try {
      await changedRef.current?.()
    } catch {
      // Revalidation is best-effort — never let it swallow the user's result.
    }
  }, [])

  const verify = useCallback(
    async (integration: ConnectableIntegration) => {
      setVerifying(integration.id)
      try {
        const response = await fetch(`/api/nango/connections/${encodeURIComponent(integration.id)}/verify`, {
          method: 'POST',
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `Verification failed (HTTP ${response.status}).`)
        toast.success(`${integration.name} credentials verified`)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Provider credentials could not be verified.')
      } finally {
        await notifyChanged()
        verifyPendingRef.current = false
        setVerifying(null)
        setBusy(null)
        setOverlayActive(false)
      }
    },
    [notifyChanged],
  )

  const connect = useCallback(
    async (integration: ConnectableIntegration) => {
      setBusy(integration.id)
      setOverlayActive(true)
      try {
        const nango = new Nango()
        const connectBaseUrl = process.env.NEXT_PUBLIC_NANGO_CONNECT_URL
        const connectUI = nango.openConnectUI({
          ...(connectBaseUrl ? { baseURL: connectBaseUrl } : {}),
          onEvent: (event) => {
            if (event.type === 'connect') {
              toast.message(`${integration.name} connected — verifying credentials…`)
              connectUIRef.current = null
              verifyPendingRef.current = true
              window.setTimeout(() => void verify(integration), 400)
            } else if (event.type === 'close') {
              connectUIRef.current = null
              setBusy(null)
              if (!verifyPendingRef.current) setOverlayActive(false)
            } else if (event.type === 'error') {
              toast.error(event.payload.errorMessage || 'Unable to connect account')
              setBusy(null)
              verifyPendingRef.current = false
              setOverlayActive(false)
            }
          },
        })
        connectUIRef.current = connectUI

        const response = await fetch('/api/nango/session-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ integrationId: integration.id }),
        })
        const data = await response.json()
        if (!response.ok || !data.sessionToken) {
          connectUI.close()
          connectUIRef.current = null
          throw new Error(data.error || 'Unable to start the connection flow')
        }
        connectUI.setSessionToken(data.sessionToken)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to connect account')
        setBusy(null)
        verifyPendingRef.current = false
        setOverlayActive(false)
      }
    },
    [verify],
  )

  const disconnect = useCallback(
    async (integration: ConnectableIntegration) => {
      if (!window.confirm(`Disconnect ${integration.name}?`)) return
      setBusy(integration.id)
      try {
        const response = await fetch(`/api/nango/connections/${encodeURIComponent(integration.id)}`, {
          method: 'DELETE',
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Unable to disconnect account')
        await notifyChanged()
        setBusy(null)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to disconnect account')
        setBusy(null)
      }
    },
    [notifyChanged],
  )

  return { busy, verifying, overlayActive, connect, verify, disconnect }
}
