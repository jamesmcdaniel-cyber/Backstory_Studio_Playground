'use client'

import { Settings2 } from 'lucide-react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { cn } from '@/lib/utils'

/** Lifetime run stats for one card, already aggregated by the caller. */
export type CardStats = { runs: number; completed: number; failed: number }

/**
 * One tile on the agents roster. The same card serves a solo agent and a
 * teammate avatar fronting several agents — they differ only in what `subtitle`
 * says and where the two buttons lead, so they share a shape rather than
 * drifting into two lookalike components.
 */
export function RosterCard({
  seed,
  name,
  role,
  roleLoading,
  subtitle,
  stats,
  presence,
  onOpen,
  onConfigure,
  configureLabel,
}: {
  /** Stable avatar seed — the teammate id, or the agent id for a solo agent. */
  seed: string
  name: string
  role: string | null
  roleLoading: boolean
  subtitle?: string
  stats: CardStats
  /** 'working' = set up and on a schedule, 'ready' = set up, 'idle' = unfinished. */
  presence: 'working' | 'ready' | 'idle'
  onOpen: () => void
  onConfigure: () => void
  configureLabel: string
}) {
  const finished = stats.completed + stats.failed
  const successRate = finished > 0 ? `${Math.round((stats.completed / finished) * 100)}%` : '—'
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-1 transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-200/80 hover:shadow-lg focus-within:shadow-md">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-indigo-50/70 via-slate-50/45 to-transparent opacity-80 transition-opacity duration-200 group-hover:opacity-100" />
      <div className="pointer-events-none absolute -left-8 -top-10 h-24 w-24 rounded-full bg-indigo-100/30 blur-2xl" />
      <button
        type="button"
        onClick={onConfigure}
        aria-label={configureLabel}
        title={configureLabel}
        className="absolute right-2.5 top-2.5 z-10 rounded-lg p-1.5 text-fg-muted opacity-60 transition-all duration-150 hover:bg-gray-100 hover:text-gray-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 group-hover:opacity-100"
      >
        <Settings2 className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="relative flex w-full flex-col items-center rounded-2xl px-4 pb-4 pt-6 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-300"
      >
        <span className="relative rounded-full bg-white p-1 shadow-[0_8px_24px_-8px_rgba(30,41,59,0.38)] ring-1 ring-black/[0.06] transition-transform duration-200 group-hover:scale-[1.035]">
          <AgentAvatar seed={seed} className="h-[4.5rem] w-[4.5rem] rounded-full" />
          {/* Presence dot: green on the clock, pale when set up but manual,
              gray while setup is unfinished. */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute bottom-0 right-0 h-4 w-4 rounded-full border-[3px] border-white shadow-sm',
              presence === 'working' ? 'bg-emerald-500' : presence === 'ready' ? 'bg-emerald-300' : 'bg-slate-300',
            )}
          />
        </span>
        <span className="mt-3 line-clamp-1 w-full text-sm font-semibold text-foreground">{name}</span>
        <span className="mt-1.5 flex h-6 items-center">
          {role ? (
            <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">{role}</span>
          ) : roleLoading ? (
            <span className="h-5 w-20 animate-pulse rounded-full bg-gray-100" />
          ) : null}
        </span>
        {subtitle && <span className="mt-1 line-clamp-1 w-full text-xs text-muted-foreground">{subtitle}</span>}
        <span className="mt-4 grid w-full grid-cols-2 divide-x border-t pt-3">
          <span className="flex flex-col gap-0.5 px-2">
            <span className="text-base font-semibold tabular-nums text-foreground">{stats.runs.toLocaleString()}</span>
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
}
