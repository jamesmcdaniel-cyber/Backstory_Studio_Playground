'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Settings2, Users } from 'lucide-react'
import { AgentAvatar } from './agent-avatar'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { RecommendationsBar } from '@/components/onboarding/recommendations-bar'
import { cn } from '@/lib/utils'

import type { Agent } from '@/lib/types'

type AgentKpis = Record<string, { runs: number; completed: number; failed: number }>

/**
 * The Agents landing view: a roster of coworker-style cards — avatar with a
 * presence dot, an AI-written job title, and two lifetime stats. Clicking a
 * card opens that agent's workspace; the gear opens its configuration.
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
  const [labels, setLabels] = useState<Record<string, string>>({})
  // Ids already sent for labeling this page view, so a slow model call or a
  // sanitizer miss doesn't retrigger a request on every agents poll.
  const requestedLabels = useRef<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/agents/kpis', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data?.kpis) setKpis(data.kpis) })
      .catch(() => undefined)
  }, [])

  // Lazily backfill missing role labels — one batched call for whatever the
  // roster is currently missing; results are persisted server-side.
  useEffect(() => {
    const missing = agents
      .filter((agent) => !agent.roleLabel && !labels[agent.id] && !requestedLabels.current.has(agent.id))
      .map((agent) => agent.id)
    if (!missing.length) return
    missing.forEach((id) => requestedLabels.current.add(id))
    fetch('/api/agents/role-labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentIds: missing.slice(0, 100) }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data?.labels) setLabels((current) => ({ ...current, ...data.labels })) })
      .catch(() => undefined)
  }, [agents, labels])

  const roster = useMemo(
    () => [...agents].sort((a, b) => a.title.localeCompare(b.title)),
    [agents],
  )

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

  if (!roster.length) {
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
            {roster.length === 1 ? '1 teammate on your roster' : `${roster.length} teammates on your roster`}
          </p>
        </div>
        <Button onClick={onCreateAgent}>
          <Plus className="mr-1.5 h-4 w-4" /> New agent
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {roster.map((agent) => {
          const kpi = kpis[agent.id]
          const runs = kpi?.runs ?? agent.executionCount ?? 0
          const finished = (kpi?.completed ?? 0) + (kpi?.failed ?? 0)
          const successRate = finished > 0 ? `${Math.round(((kpi?.completed ?? 0) / finished) * 100)}%` : '—'
          const role = agent.roleLabel || labels[agent.id] || null
          const active = agent.status === 'active' && Boolean(agent.instructions?.trim())
          return (
            <div
              key={agent.id}
              className="group relative rounded-2xl border bg-white shadow-1 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md focus-within:shadow-md"
            >
              <button
                type="button"
                onClick={() => onEditAgent(agent.id)}
                aria-label={`Configure ${agent.title}`}
                title="Configure agent"
                className="absolute right-2.5 top-2.5 z-10 rounded-lg p-1.5 text-gray-400 opacity-60 transition-all duration-150 hover:bg-gray-100 hover:text-gray-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 group-hover:opacity-100"
              >
                <Settings2 className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onOpenAgent(agent.id)}
                className="flex w-full flex-col items-center rounded-2xl px-4 pb-4 pt-6 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
              >
                <span className="relative">
                  <AgentAvatar seed={agent.id} className="h-16 w-16 rounded-full ring-1 ring-black/5" />
                  {/* Presence dot: green when the agent is set up and on the
                      clock (active schedule), gray while it's idle or unfinished. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white',
                      active && agent.schedule?.isActive ? 'bg-emerald-500' : active ? 'bg-emerald-300' : 'bg-gray-300',
                    )}
                  />
                </span>
                <span className="mt-3 line-clamp-1 w-full text-sm font-semibold text-foreground">{agent.title}</span>
                <span className="mt-1.5 flex h-6 items-center">
                  {role ? (
                    <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">{role}</span>
                  ) : (
                    <span className="h-5 w-20 animate-pulse rounded-full bg-gray-100" />
                  )}
                </span>
                <span className="mt-4 grid w-full grid-cols-2 divide-x border-t pt-3">
                  <span className="flex flex-col gap-0.5 px-2">
                    <span className="text-base font-semibold tabular-nums text-foreground">{runs.toLocaleString()}</span>
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Runs</span>
                  </span>
                  <span className="flex flex-col gap-0.5 px-2">
                    <span className="text-base font-semibold tabular-nums text-foreground">{successRate}</span>
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Success</span>
                  </span>
                </span>
              </button>
            </div>
          )
        })}
        <button
          type="button"
          onClick={onCreateAgent}
          className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 text-muted-foreground transition-colors duration-150 hover:border-indigo-300 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
        >
          <Plus className="h-6 w-6" aria-hidden="true" />
          <span className="text-sm font-medium">New agent</span>
        </button>
      </div>
    </div>
  )
}
