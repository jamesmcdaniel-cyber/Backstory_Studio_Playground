'use client'

/**
 * Your authenticators: what is enrolled, and how to remove one.
 *
 * Settings previously offered a single "disable MFA" switch that unenrolled
 * every factor from the browser with no guard at all — nothing asked whether the
 * session had recently proven possession, and nothing asked whether the account
 * was under a policy that would immediately lock it out. Both questions are
 * decided server-side by /api/auth/mfa/factors; everything here renders that
 * decision, which is why `removable` and `stepUpSatisfied` arrive from the API
 * rather than being recomputed on the client. A disabled button is an
 * explanation, not a security boundary.
 *
 * There are no printed backup codes, deliberately: assurance level is minted by
 * Supabase on a verified challenge, so an offline code we generated could never
 * produce an aal2 session. Recovery is the admin reset in
 * docs/runbooks/account-recovery.md.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ShieldCheck, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/settings/dialogs'

type Factor = {
  id: string
  friendlyName: string | null
  status: string
  createdAt: string | null
  removable: boolean
}

type FactorsResponse = {
  success?: boolean
  factors?: Factor[]
  policyRequired?: boolean
  stepUpSatisfied?: boolean
}

const fmtDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null

export function MfaSection({ onChanged }: { onChanged?: () => void } = {}) {
  const [factors, setFactors] = useState<Factor[]>([])
  const [policyRequired, setPolicyRequired] = useState(false)
  const [steppedUp, setSteppedUp] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Factor | null>(null)

  const load = useCallback(async () => {
    const data: FactorsResponse | null = await fetch('/api/auth/mfa/factors', { cache: 'no-store' })
      .then((response) => response.json())
      .catch(() => null)
    if (data?.success) {
      setFactors(data.factors ?? [])
      setPolicyRequired(Boolean(data.policyRequired))
      setSteppedUp(Boolean(data.stepUpSatisfied))
    }
    setLoaded(true)
  }, [])
  useEffect(() => { void load() }, [load])

  const remove = async (factor: Factor) => {
    setBusy(factor.id)
    try {
      const response = await fetch('/api/auth/mfa/factors', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factorId: factor.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not remove that authenticator.')
      setRemoving(null)
      toast.success('Authenticator removed.')
      onChanged?.()
      await load()
    } finally { setBusy(null) }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Authenticator apps</h3>
          <p className="text-xs text-muted-foreground">
            {policyRequired
              ? 'Your account requires multi-factor authentication, so your last authenticator can only be removed by an administrator.'
              : 'Time-based codes from an app on your phone.'}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href="/auth/mfa"><Smartphone className="h-3.5 w-3.5" /> Add authenticator</a>
        </Button>
      </div>

      {!loaded ? (
        <div className="h-16 animate-pulse rounded-lg border bg-muted/40" />
      ) : factors.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No authenticator enrolled"
          description="Add one to protect your account with a second factor."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {factors.map((factor) => (
            <li key={factor.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{factor.friendlyName || 'Authenticator app'}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {fmtDate(factor.createdAt) ? `Added ${fmtDate(factor.createdAt)}` : 'Added recently'}
                </div>
              </div>
              {factor.status === 'verified' ? (
                <Badge variant="good">Verified</Badge>
              ) : (
                <Badge variant="warn">Not finished</Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === factor.id || !factor.removable}
                title={
                  !factor.removable
                    ? 'Your account requires multi-factor authentication — an administrator has to reset this one.'
                    : undefined
                }
                onClick={() => setRemoving(factor)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {loaded && factors.length > 0 && !steppedUp && (
        // The removal itself is refused server-side without a recent
        // verification; saying so up front beats a 403 after the confirmation.
        <p className="text-xs text-muted-foreground">
          Removing an authenticator needs a fresh check.{' '}
          <a className="underline underline-offset-2" href="/auth/mfa">Verify with your authenticator</a>, then come back.
        </p>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null) }}
        title="Remove this authenticator?"
        description="You will need to enter a code from it one last time if your session has gone stale. Removing your only authenticator is not possible while your account requires multi-factor authentication."
        confirmLabel="Remove authenticator"
        destructive
        busy={busy === removing?.id}
        onConfirm={() => removing && remove(removing)}
      />
    </section>
  )
}
