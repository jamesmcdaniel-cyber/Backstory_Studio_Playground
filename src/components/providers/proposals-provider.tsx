'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSupabase } from './supabase-provider'
import { ProposalDetailDialog } from '@/components/onboarding/proposal-detail-dialog'
import { landOnAcceptedProposal } from '@/lib/client/apply-proposal'
import type { ProposalCard } from '@/components/onboarding/proposal-shared'
import { isCustomerEdition } from '@/lib/edition'

/** Poll cadence + budget while generation may still be landing proposals. */
const POLL_MS = 5_000
const POLL_BUDGET = 24 // ~2 minutes, then it goes static until the next remount

type ProposalsContextValue = {
  proposals: ProposalCard[]
  loaded: boolean
  busyId: string | null
  accept: (proposal: ProposalCard) => Promise<void>
  dismiss: (proposal: ProposalCard) => Promise<void>
  /** Open the shared detail popup for a proposal. */
  openDetail: (proposal: ProposalCard) => void
}

const Context = createContext<ProposalsContextValue | null>(null)

/**
 * Single source of truth for AI recommendation proposals, shared by every
 * surface that shows them (the home Recommendations bar and the notification
 * bell) so accepting or dismissing in one place updates them all. Fetching is
 * gated on an authenticated user, so public/auth pages never 401-spam.
 */
export function ProposalsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSupabase()
  const [proposals, setProposals] = useState<ProposalCard[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProposalCard | null>(null)
  const polls = useRef(0)

  useEffect(() => {
    // The customer edition has no AI proposals. The provider stays MOUNTED and
    // simply never fetches — removing it would make every useProposals()
    // consumer throw. Consumers already render nothing for an empty array
    // (RecommendationsBar returns null; the bell's section and badge both key
    // off proposals.length), so this one guard is the whole client-side change.
    if (isCustomerEdition()) {
      setLoaded(true)
      return
    }
    if (!user) {
      setProposals([])
      setLoaded(false)
      polls.current = 0
      return
    }
    let alive = true
    const load = async () => {
      const data = await fetch('/api/template-proposals', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
      if (!alive) return
      if (data?.success) setProposals((data.proposals ?? []).filter((p: ProposalCard) => p.status === 'open'))
      setLoaded(true)
    }
    void load()
    const timer = window.setInterval(() => {
      polls.current += 1
      if (polls.current > POLL_BUDGET) {
        window.clearInterval(timer)
        return
      }
      void load()
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [user])

  const remove = useCallback((id: string) => setProposals((prev) => prev.filter((p) => p.id !== id)), [])
  const restore = useCallback(
    (proposal: ProposalCard) => setProposals((prev) => (prev.some((p) => p.id === proposal.id) ? prev : [proposal, ...prev])),
    [],
  )

  const accept = useCallback(async (proposal: ProposalCard) => {
    setBusyId(proposal.id)
    setDetail((d) => (d?.id === proposal.id ? null : d))
    remove(proposal.id)
    try {
      const response = await fetch(`/api/template-proposals/${proposal.id}/accept`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        restore(proposal)
        toast.error(data.error || 'Could not accept that suggestion.')
        return
      }
      landOnAcceptedProposal(proposal.kind, data)
    } finally {
      setBusyId(null)
    }
  }, [remove, restore])

  const dismiss = useCallback(async (proposal: ProposalCard) => {
    setBusyId(proposal.id)
    setDetail((d) => (d?.id === proposal.id ? null : d))
    remove(proposal.id)
    try {
      const response = await fetch(`/api/template-proposals/${proposal.id}/dismiss`, { method: 'POST' })
      if (!response.ok) {
        restore(proposal)
        toast.error('Could not dismiss that suggestion.')
      }
    } finally {
      setBusyId(null)
    }
  }, [remove, restore])

  const value = useMemo<ProposalsContextValue>(
    () => ({ proposals, loaded, busyId, accept, dismiss, openDetail: setDetail }),
    [proposals, loaded, busyId, accept, dismiss],
  )

  return (
    <Context.Provider value={value}>
      {children}
      <ProposalDetailDialog
        proposal={detail}
        busy={detail ? busyId === detail.id : false}
        onOpenChange={(open) => { if (!open) setDetail(null) }}
        onAccept={accept}
        onDismiss={dismiss}
      />
    </Context.Provider>
  )
}

export function useProposals() {
  const context = useContext(Context)
  if (!context) throw new Error('useProposals must be used within ProposalsProvider')
  return context
}
