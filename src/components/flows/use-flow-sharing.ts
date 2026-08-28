'use client'

import { useCallback, useMemo, useState } from 'react'

/**
 * The share-link state for a flow: whether a link is live, what it grants, how
 * many anonymous views it has taken, and — for the one session that minted it —
 * the raw token.
 *
 * Five `useState`s and a five-argument callback in the flow editor page, with
 * the rule that actually matters buried in that callback: **a mint or rotate
 * hands back a fresh plaintext, while a role or anonymity change hands back
 * null, and null must not wipe the token already on screen.** The server stores
 * only a digest, so a token cleared by accident is unrecoverable — the user has
 * to rotate the link and re-send it to everyone.
 */

export type ShareRole = 'view' | 'edit'

export interface FlowSharing {
  /** Plaintext, and only in the session that minted it. Null otherwise. */
  token: string | null
  /** The durable fact — a link is live — which survives a reload. */
  enabled: boolean
  role: ShareRole
  anonymous: boolean
  views: number
  /** Adopt what the share API returned. */
  applyChange: (
    token: string | null,
    enabled: boolean,
    role: ShareRole,
    anonymous: boolean,
    views: number,
  ) => void
  /** Seed from a freshly loaded flow. */
  hydrate: (flow: {
    shareEnabled?: unknown
    shareRole?: unknown
    shareAnonymous?: unknown
    anonymousViews?: unknown
  }) => void
}

export function useFlowSharing(): FlowSharing {
  const [token, setToken] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  const [views, setViews] = useState(0)
  const [role, setRole] = useState<ShareRole>('view')

  const applyChange = useCallback<FlowSharing['applyChange']>(
    (nextToken, nextEnabled, nextRole, nextAnonymous, nextViews) => {
      // Keep the plaintext on screen when the response carries none. Only a
      // mint/rotate returns one, and only disabling the link should clear it.
      if (nextToken || !nextEnabled) setToken(nextToken)
      setEnabled(nextEnabled)
      setRole(nextRole)
      setAnonymous(nextAnonymous)
      setViews(nextViews)
    },
    [],
  )

  const hydrate = useCallback<FlowSharing['hydrate']>((flow) => {
    // The token is deliberately NOT hydrated: the server only ever has a digest,
    // so a reload cannot recover the plaintext and pretending otherwise would
    // put a wrong value on the clipboard.
    setEnabled(Boolean(flow.shareEnabled))
    setRole(flow.shareRole === 'edit' ? 'edit' : 'view')
    setAnonymous(Boolean(flow.shareAnonymous))
    setViews(Number(flow.anonymousViews ?? 0))
  }, [])

  return useMemo(
    () => ({ token, enabled, role, anonymous, views, applyChange, hydrate }),
    [token, enabled, role, anonymous, views, applyChange, hydrate],
  )
}
