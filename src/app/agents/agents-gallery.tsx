'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Users } from 'lucide-react'
import { RosterCard } from './roster-card'
import { TeammatePanel } from './teammate-panel'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { RecommendationsBar } from '@/components/onboarding/recommendations-bar'
import { buildRoster, type CardStats } from '@/lib/agents/roster'

import type { Agent, Teammate } from '@/lib/types'

type AgentKpis = Record<string, CardStats>

/**
 * The Agents landing view: a roster of coworker cards.
 *
 * A card is either a teammate avatar fronting several agents, or a solo agent
 * that belongs to no teammate. Clicking a solo card (or a teammate with exactly
 * one job) opens that agent's workspace; a teammate with several jobs opens its
 * roster panel first, because there is no single screen that means "the whole
 * avatar".
 */
export function AgentsGallery({
  agents,
  loading,
  onOpenAgent,
  onEditAgent,
  onCreateAgent,
}: {
  agents: Agent[]
  loading: boolean
  onOpenAgent: (id: string) => void
  onEditAgent: (id: string) => void
  onCreateAgent: () => void
}) {
  const [kpis, setKpis] = useState<AgentKpis>({})
  const [teammates, setTeammates] = useState<Teammate[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [teammateLabels, setTeammateLabels] = useState<Record<string, string>>({})
  const [openTeammateId, setOpenTeammateId] = useState<string | null>(null)
  // Subjects already sent for labeling, so a slow model call or a sanitizer
  // miss doesn't retrigger a request on every agents poll.
  const requestedLabels = useRef<Set<string>>(new Set())

  const loadTeammates = useCallback(() => {
    fetch('/api/teammates', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data?.teammates) setTeammates(data.teammates) })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    fetch('/api/agents/kpis', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data?.kpis) setKpis(data.kpis) })
      .catch(() => undefined)
    loadTeammates()
  }, [loadTeammates])

  const { teammateCards, agentCards } = useMemo(
    () => buildRoster(agents, teammates, kpis),
    [agents, teammates, kpis],
  )

  // Lazily backfill missing role labels — one batched call covering both kinds
  // of card; results are persisted server-side.
  useEffect(() => {
    const agentIds = agentCards
      .filter((card) => !card.agent.roleLabel && !labels[card.agent.id] && !requestedLabels.current.has(`agent:${card.agent.id}`))
      .map((card) => card.agent.id)
    const teammateIds = teammateCards
      .filter((card) => !card.teammate.roleLabel && !teammateLabels[card.teammate.id] && !requestedLabels.current.has(`teammate:${card.teammate.id}`))
      .map((card) => card.teammate.id)
    if (!agentIds.length && !teammateIds.length) return
    agentIds.forEach((id) => requestedLabels.current.add(`agent:${id}`))
    teammateIds.forEach((id) => requestedLabels.current.add(`teammate:${id}`))
    fetch('/api/agents/role-labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentIds: agentIds.slice(0, 100), teammateIds: teammateIds.slice(0, 100) }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.labels) setLabels((current) => ({ ...current, ...data.labels }))
        if (data?.teammateLabels) setTeammateLabels((current) => ({ ...current, ...data.teammateLabels }))
      })
      .catch(() => undefined)
  }, [agentCards, teammateCards, labels, teammateLabels])

  const openCard = teammateCards.find((card) => card.teammate.id === openTeammateId) ?? null
  const total = teammateCards.length + agentCards.length

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-6xl p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-56 rounded-2xl" />
          ))}
        </div>
      </div>
    )
  }

  if (!total) {
    return (
      <div className="mx-auto w-full max-w-2xl p-6">
        <EmptyState
          icon={Users}
          title="Hire your first agent"
          description="Agents are teammates that do real work — research accounts, draft reports, watch your pipeline. Create one and it shows up here."
        />
        <div className="mt-4 flex justify-center">
          <Button onClick={onCreateAgent}>
            <Plus className="mr-1.5 h-4 w-4" /> New agent
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <div className="mb-4">
        <RecommendationsBar />
      </div>
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">
            {total === 1 ? '1 teammate on your roster' : `${total} teammates on your roster`}
          </p>
        </div>
        <Button onClick={onCreateAgent}>
          <Plus className="mr-1.5 h-4 w-4" /> New agent
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {teammateCards.map(({ teammate, agents: roster, soleAgent, stats, presence }) => (
          <RosterCard
            key={teammate.id}
            seed={teammate.id}
            name={teammate.name}
            role={teammate.roleLabel || teammateLabels[teammate.id] || null}
            roleLoading={requestedLabels.current.has(`teammate:${teammate.id}`)}
            subtitle={roster.length === 1 ? '1 job' : `${roster.length} jobs`}
            stats={stats}
            presence={presence}
            // One job means the avatar IS that agent — skip the roster panel
            // and behave exactly like a solo card.
            onOpen={() => (soleAgent ? onOpenAgent(soleAgent.id) : setOpenTeammateId(teammate.id))}
            onConfigure={() => (soleAgent ? onEditAgent(soleAgent.id) : setOpenTeammateId(teammate.id))}
            configureLabel={soleAgent ? `Configure ${soleAgent.title}` : `Manage ${teammate.name}`}
          />
        ))}
        {agentCards.map(({ agent, stats, presence }) => (
          <RosterCard
            key={agent.id}
            seed={agent.id}
            name={agent.title}
            role={agent.roleLabel || labels[agent.id] || null}
            roleLoading={requestedLabels.current.has(`agent:${agent.id}`)}
            stats={stats}
            presence={presence}
            onOpen={() => onOpenAgent(agent.id)}
            onConfigure={() => onEditAgent(agent.id)}
            configureLabel={`Configure ${agent.title}`}
          />
        ))}
        <button
          type="button"
          onClick={onCreateAgent}
          className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 text-muted-foreground transition-colors duration-150 hover:border-indigo-300 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
        >
          <Plus className="h-6 w-6" aria-hidden="true" />
          <span className="text-sm font-medium">New agent</span>
        </button>
      </div>
      {openCard && (
        <TeammatePanel
          teammate={openCard.teammate}
          agents={openCard.agents}
          kpis={kpis}
          roleLabel={openCard.teammate.roleLabel || teammateLabels[openCard.teammate.id] || null}
          onOpenAgent={onOpenAgent}
          onEditAgent={onEditAgent}
          onClose={() => setOpenTeammateId(null)}
          onChanged={loadTeammates}
        />
      )}
    </div>
  )
}
