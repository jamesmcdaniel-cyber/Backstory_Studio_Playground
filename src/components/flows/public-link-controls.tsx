'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

/** The public (no sign-in) link's state, as GET/POST /api/flows/[id]/public-link return it. */
export type PublicLinkState = {
  enabled: boolean
  url: string | null
  views: number
  expiresAt: string | null
  expired: boolean
  allowCopy: boolean
}

export type PublicLinkPatch = { action?: 'enable' | 'disable' | 'rotate'; expiresAt?: string | null; allowCopy?: boolean }

/**
 * The flow's public link, loaded for editors while the panel is open. The link
 * has its own token (never the jam link's), stored encrypted, so unlike the jam
 * link its URL survives a reload.
 */
export function usePublicLink(flowId: string, active: boolean) {
  const [state, setState] = useState<PublicLinkState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    fetch(`/api/flows/${flowId}/public-link`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setState(data as PublicLinkState)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [flowId, active])

  const update = useCallback(async (patch: PublicLinkPatch): Promise<PublicLinkState | null> => {
    setBusy(true)
    try {
      const res = await fetch(`/api/flows/${flowId}/public-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not update the public link.')
        return null
      }
      setState(data as PublicLinkState)
      return data as PublicLinkState
    } finally {
      setBusy(false)
    }
  }, [flowId])

  return { state, busy, update }
}

const EXPIRY_CHOICES: { label: string; days: number | null }[] = [
  { label: 'Never expires', days: null },
  { label: 'Expires in 7 days', days: 7 },
  { label: 'Expires in 30 days', days: 30 },
  { label: 'Expires in 90 days', days: 90 },
]

/**
 * Expiry and "Use this flow" for a live public link. Rotation sits with the
 * other link controls in the jam panel; this is what only the public link has.
 */
export function PublicLinkControls({
  state,
  busy,
  canEdit,
  onUpdate,
}: {
  state: PublicLinkState
  busy: boolean
  canEdit: boolean
  onUpdate: (patch: PublicLinkPatch) => Promise<PublicLinkState | null>
}) {
  const expiryLabel = state.expiresAt
    ? `${state.expired ? 'Expired' : 'Expires'} ${new Date(state.expiresAt).toLocaleDateString()}`
    : 'Never expires'

  const setExpiry = async (days: number | null) => {
    const next = await onUpdate({ expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString() })
    if (next) toast.success(days === null ? 'The link no longer expires.' : `The link now stops working on ${new Date(next.expiresAt ?? '').toLocaleDateString()}.`)
  }

  const setAllowCopy = async (allowCopy: boolean) => {
    const next = await onUpdate({ allowCopy })
    if (next) toast.success(allowCopy ? 'Signed-in visitors can now copy this flow.' : 'Visitors can no longer copy this flow.')
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={state.expired ? 'text-xs font-medium text-destructive' : 'text-xs text-fg-muted'}>{expiryLabel}</span>
        {canEdit && (
          <select
            aria-label="Link expiry"
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            disabled={busy}
            value=""
            onChange={(event) => {
              const choice = EXPIRY_CHOICES[Number(event.target.value)]
              if (choice) void setExpiry(choice.days)
            }}
          >
            <option value="" disabled>Change expiry…</option>
            {EXPIRY_CHOICES.map((choice, index) => (
              <option key={choice.label} value={index}>{choice.label}</option>
            ))}
          </select>
        )}
      </div>
      <div className="flex items-start gap-2 text-xs">
        <input
          id="public-link-allow-copy"
          type="checkbox"
          className="mt-0.5"
          checked={state.allowCopy}
          disabled={!canEdit || busy}
          aria-describedby="public-link-allow-copy-hint"
          onChange={(event) => void setAllowCopy(event.target.checked)}
        />
        <div>
          <label htmlFor="public-link-allow-copy" className="font-medium text-foreground">Let signed-in visitors copy it</label>
          <p id="public-link-allow-copy-hint" className="text-fg-muted">
            They get a private copy in their own workspace, without your connected accounts, saved credentials or run
            data. Their changes never reach this flow.
          </p>
        </div>
      </div>
    </div>
  )
}
