'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useProposals } from '@/components/providers/proposals-provider'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { inboxSubtitle, inboxTitle, proposalPersona } from '@/lib/templates/proposal-persona'
import { IntegrationChips, proposalHeadline, proposalIntegrations, proposalSubline } from './proposal-shared'

const COLLAPSE_KEY = 'backstory:recs-collapsed'

/**
 * The hiring desk: AI recommendations presented as people rather than rows.
 *
 * The roster shows agents as coworkers, so what suggests new ones reads as
 * candidates applying to join — each with a face, so the decision feels like
 * looking at an applicant rather than approving a config change. Improvements
 * to things already running are NOT dressed as applicants; they are existing
 * teammates flagging their own work, and they wear that teammate's real face.
 * See @/lib/templates/proposal-persona.
 */
export function RecommendationsBar() {
  const { proposals, busyId, accept, openDetail } = useProposals()
  // Default collapsed so the surface never dominates the page; the count keeps
  // it discoverable. Preference persists across visits.
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) !== 'false')
    } catch {
      /* private mode — keep default */
    }
  }, [])

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev
      try { window.localStorage.setItem(COLLAPSE_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
  }

  const personas = useMemo(() => proposals.map((proposal) => proposalPersona(proposal)), [proposals])
  const kinds = useMemo(() => personas.map((persona) => persona.kind), [personas])

  if (!proposals.length) return null

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-gray-50"
      >
        {/* A stack of faces: the bar reads as people waiting, even collapsed. */}
        <span className="flex shrink-0 -space-x-2" aria-hidden="true">
          {personas.slice(0, 3).map((persona) => (
            <AgentAvatar key={persona.seed} seed={persona.seed} className="h-8 w-7 rounded-lg ring-2 ring-white" />
          ))}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{inboxTitle(kinds)}</h3>
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{proposals.length}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">{inboxSubtitle(kinds)}</span>
        </span>
        <ChevronDown className={cn('ml-auto h-4 w-4 shrink-0 text-gray-400 transition-transform', !collapsed && 'rotate-180')} />
      </button>

      {!collapsed && (
        <ul className="divide-y border-t">
          {proposals.map((proposal, index) => {
            const persona = personas[index]
            return (
              <li key={proposal.id} className="flex items-center gap-3 px-4 py-2.5">
                <AgentAvatar seed={persona.seed} className="h-11 w-10 shrink-0 rounded-xl ring-1 ring-black/5" />
                <button
                  type="button"
                  onClick={() => openDetail(proposal)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-gray-900">{proposalHeadline(proposal)}</span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        persona.kind === 'applicant' ? 'bg-indigo-50 text-indigo-700' : 'bg-amber-50 text-amber-800',
                      )}
                    >
                      {persona.chip}
                    </span>
                    {/* The fault, demoted to detail — the name is the headline. */}
                    {proposalSubline(proposal) && (
                      <span className="truncate text-xs text-muted-foreground">{proposalSubline(proposal)}</span>
                    )}
                  </span>
                </button>
                <IntegrationChips slugs={proposalIntegrations(proposal)} />
                <button
                  type="button"
                  onClick={() => openDetail(proposal)}
                  className="shrink-0 text-xs font-medium text-indigo-600 hover:underline"
                >
                  {persona.kind === 'applicant' ? 'Résumé' : 'Details'}
                </button>
                <button
                  type="button"
                  disabled={busyId === proposal.id}
                  onClick={() => void accept(proposal)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {persona.kind === 'applicant'
                    ? <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                  {persona.action}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
