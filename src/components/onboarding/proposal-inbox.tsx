'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, Sparkles, UserPlus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { landOnAcceptedProposal } from '@/lib/client/apply-proposal'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { proposalPersona } from '@/lib/templates/proposal-persona'
import { ProposalPreview, proposalHeadline, proposalSubline, type ProposalCard } from './proposal-shared'

export type { ProposalCard } from './proposal-shared'

/** Poll cadence + budget while generation may still be landing proposals. */
const POLL_MS = 5_000
const POLL_BUDGET = 24 // ~2 minutes, then the inbox goes static until remount

/**
 * "Your data takes shape" — the review inbox for AI-generated template
 * proposals. Accepting a template-kind proposal adds it to the org catalogue;
 * accepting an improvement opens the flow/agent it targets; dismissing is
 * terminal. Rows disappear optimistically and reappear with an honest toast
 * when the server disagrees.
 */
export function ProposalInbox({
  generating,
  hideWhenEmpty = false,
  title,
}: {
  generating: boolean
  hideWhenEmpty?: boolean
  /** When set, the list renders under this heading in a self-padded block (for
   *  persistent surfaces like the dashboard). */
  title?: string
}) {
  const [proposals, setProposals] = useState<ProposalCard[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const polls = useRef(0)

  useEffect(() => {
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
  }, [])

  const remove = (id: string) => setProposals((prev) => prev.filter((proposal) => proposal.id !== id))
  const restore = (proposal: ProposalCard) => setProposals((prev) => (prev.some((p) => p.id === proposal.id) ? prev : [proposal, ...prev]))

  const accept = async (proposal: ProposalCard) => {
    setBusyId(proposal.id)
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
  }

  const dismiss = async (proposal: ProposalCard) => {
    setBusyId(proposal.id)
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
  }

  // Persistent surfaces (dashboard) render nothing until there's a real
  // recommendation — no "checking…" or "no suggestions" chrome.
  if (hideWhenEmpty && !proposals.length) return null
  if (!loaded) {
    return <p className="text-sm text-gray-500">Checking for suggestions…</p>
  }
  if (!proposals.length) {
    return (
      <p className="text-sm leading-6 text-gray-500">
        {generating
          ? 'Your AI is still learning — this updates as it finds patterns.'
          : 'No suggestions right now — you can build your own anytime.'}
      </p>
    )
  }
  const list = (
    <ul className="space-y-3">
      {proposals.map((proposal) => {
        // Same persona as the hiring desk and the detail popup: one face and
        // one verb per proposal, wherever it is shown.
        const persona = proposalPersona(proposal)
        return (
        <li key={proposal.id} className="rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <AgentAvatar seed={persona.seed} className="h-10 w-10 shrink-0 rounded-full ring-1 ring-black/5" />
            <div className="min-w-0">
              <span
                className={cn(
                  'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
                  persona.kind === 'applicant' ? 'bg-indigo-50 text-indigo-700' : 'bg-amber-50 text-amber-800',
                )}
              >
                {persona.chip}
              </span>
              <p className="mt-1.5 text-sm font-semibold text-gray-900">{proposalHeadline(proposal)}</p>
              {proposalSubline(proposal) && (
                <p className="mt-0.5 text-xs text-muted-foreground">{proposalSubline(proposal)}</p>
              )}
              <p className="mt-1 text-sm leading-5 text-gray-600">{proposal.rationale}</p>
              <ProposalPreview proposal={proposal} />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busyId === proposal.id}
              onClick={() => void accept(proposal)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50',
              )}
            >
              {persona.kind === 'applicant'
                ? <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
              {persona.action}
            </button>
            <button
              type="button"
              disabled={busyId === proposal.id}
              onClick={() => void dismiss(proposal)}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> {persona.kind === 'applicant' ? 'Pass' : 'Dismiss'}
            </button>
          </div>
        </li>
        )
      })}
    </ul>
  )
  if (!title) return list
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-1.5">
        <Sparkles className="h-4 w-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      </div>
      {list}
    </div>
  )
}
