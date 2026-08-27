'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

type ReviewStatus = 'open' | 'approved' | 'rejected' | 'withdrawn'

type ReviewState = {
  required: boolean
  review: { id: string; status: ReviewStatus } | null
  matchesDraft: boolean
  canDecide: boolean
  canWithdraw: boolean
}

/**
 * The definition-review backend used to be reachable only by hand-written API
 * calls. This compact control puts the entire request/approve/reject/withdraw
 * lifecycle next to Publish, where the gate is encountered.
 */
export function FlowReviewControl({
  flowId,
  prepareRequest,
  disabled = false,
}: {
  flowId: string
  /** Persist local edits before the server snapshots the draft for review. */
  prepareRequest: () => Promise<boolean>
  disabled?: boolean
}) {
  const [state, setState] = useState<ReviewState | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch(`/api/flows/${flowId}/review`, { cache: 'no-store' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Could not load review status.')
    setState({
      required: Boolean(data.required),
      review: data.review ?? null,
      matchesDraft: Boolean(data.matchesDraft),
      canDecide: Boolean(data.canDecide),
      canWithdraw: Boolean(data.canWithdraw),
    })
  }, [flowId])

  useEffect(() => {
    let cancelled = false
    void load().catch(() => { if (!cancelled) setState(null) })
    return () => { cancelled = true }
  }, [load])

  const requestReview = async () => {
    setBusy(true)
    try {
      if (!(await prepareRequest())) return
      const response = await fetch(`/api/flows/${flowId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not request review.')
      await load()
      toast.success('Review requested. A teammate can now approve this draft.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not request review.')
    } finally {
      setBusy(false)
    }
  }

  const decide = async (decision: 'approved' | 'rejected' | 'withdrawn') => {
    setBusy(true)
    try {
      const response = await fetch(`/api/flows/${flowId}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not update the review.')
      await load()
      toast.success(decision === 'approved'
        ? 'Draft approved for publishing.'
        : decision === 'rejected'
          ? 'Draft rejected.'
          : 'Review request withdrawn.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the review.')
    } finally {
      setBusy(false)
    }
  }

  if (!state?.required) return null

  const status = state.review?.status
  return (
    <div className="flex items-center gap-1.5" aria-label="Flow review status">
      {status === 'open' ? (
        <>
          <Badge variant="secondary" className="gap-1 whitespace-nowrap">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
            Review pending
          </Badge>
          {state.canDecide && (
            <>
              <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={() => void decide('approved')} title="Approve this draft">
                <Check className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={() => void decide('rejected')} title="Reject this draft">
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
          {state.canWithdraw && (
            <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={() => void decide('withdrawn')}>
              Withdraw
            </Button>
          )}
        </>
      ) : status === 'approved' && state.matchesDraft ? (
        <Badge variant="secondary" className="gap-1 whitespace-nowrap text-emerald-700">
          <Check className="h-3 w-3" /> Approved
        </Badge>
      ) : (
        <Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => void requestReview()}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1.5 h-4 w-4" />}
          {status === 'rejected' || status === 'approved' ? 'Request review again' : 'Request review'}
        </Button>
      )}
    </div>
  )
}
