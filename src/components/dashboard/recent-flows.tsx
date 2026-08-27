'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cardAccent } from '@/lib/flows/card-accent'
import { relativeTime } from '@/lib/relative-time'
import { Skeleton } from '@/components/ui/skeleton'
import type { FlowOperationalStatus } from '@/lib/flows/operational-status'

/** How many shortcuts the row shows. */
const LIMIT = 3

type RecentFlow = {
  id: string
  name: string
  /** Emoji card icon ('' = the generic Workflow glyph). */
  icon?: string
  updatedAt: string
  /** null means a cross-workspace share whose run activity is private. */
  operationalStatus?: FlowOperationalStatus | null
}

const STATUS_VIEW: Record<FlowOperationalStatus, { label: string; dot: string; pill: string }> = {
  running: {
    label: 'Running',
    dot: 'bg-emerald-500 motion-safe:animate-pulse',
    pill: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  queued: {
    label: 'Queued',
    dot: 'bg-amber-500',
    pill: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  blocked: {
    label: 'Blocked',
    dot: 'bg-rose-500',
    pill: 'border-rose-200 bg-rose-50 text-rose-700',
  },
  idle: {
    label: 'Idle',
    dot: 'bg-gray-400',
    pill: 'border-gray-200 bg-gray-50 text-gray-600',
  },
}

/**
 * Quick starts back into the flows you were last editing, so continuing work
 * doesn't cost a trip through the Flows grid.
 *
 * `GET /api/flows` already returns newest-edited first, so this takes the head
 * of that list rather than asking for its own ordering.
 */
export function RecentFlows() {
  const [flows, setFlows] = useState<RecentFlow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    let listInFlight = false
    let statusInFlight = false
    let visibleIds: string[] = []
    const refreshList = async () => {
      if (listInFlight) return
      listInFlight = true
      try {
        const response = await fetch('/api/flows', { cache: 'no-store' })
        const data = response.ok ? await response.json() : null
        if (alive && data?.success) {
          const recent = ((data.flows ?? []) as RecentFlow[]).slice(0, LIMIT)
          visibleIds = recent.filter((flow) => flow.operationalStatus !== null).map((flow) => flow.id)
          setFlows(recent)
        }
      } catch {
        // A shortcut row is not worth an error state — it competes with the
        // composer for attention. A failure just leaves the last good row.
      } finally {
        listInFlight = false
        if (alive) setLoading(false)
      }
    }
    const refreshStatuses = async () => {
      if (statusInFlight || !visibleIds.length) return
      statusInFlight = true
      try {
        const query = new URLSearchParams(visibleIds.map((id) => ['id', id])).toString()
        const response = await fetch(`/api/flows/statuses?${query}`, { cache: 'no-store' })
        const data = response.ok ? await response.json() : null
        if (!alive || !data?.success || !data.statuses || typeof data.statuses !== 'object') return
        const statuses = data.statuses as Record<string, unknown>
        setFlows((current) => current.map((flow) => {
          const next = statuses[flow.id]
          return typeof next === 'string' && next in STATUS_VIEW
            ? { ...flow, operationalStatus: next as FlowOperationalStatus }
            : flow
        }))
      } catch {
        // Preserve the last confirmed status through a transient poll failure.
      } finally {
        statusInFlight = false
      }
    }
    void refreshList()
    // Execution state changes independently of edits, so keep the compact
    // status current through the lightweight status-only route while this
    // landing shelf is visible.
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshStatuses()
    }, 5_000)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshStatuses()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      alive = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  // A workspace with no flows gets no empty shelf, and neither does a failed fetch.
  if (!loading && flows.length === 0) return null

  return (
    <div className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-muted">Recent flows</p>
        <Link
          href="/flows"
          className="group inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-muted transition-colors hover:text-horizon-600"
        >
          All flows
          <ArrowRight className="h-3 w-3 transition-transform duration-base group-hover:translate-x-0.5" />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {loading
          ? // Same footprint as the real cards, so nothing shifts when data lands.
            Array.from({ length: LIMIT }, (_, i) => (
              <div key={i} className="rounded-xl border border-gray-200 bg-white p-4 shadow-1">
                <Skeleton className="h-9 w-9 rounded-lg" />
                <Skeleton className="mt-3 h-4 w-3/4 rounded" />
                <Skeleton className="mt-2 h-3 w-1/3 rounded" />
              </div>
            ))
          : flows.map((flow) => {
              const accent = cardAccent(flow.id)
              // Older API payloads degrade to idle; explicit null is the
              // privacy marker for a flow shared in from another workspace.
              const status = flow.operationalStatus === null
                ? null
                : STATUS_VIEW[flow.operationalStatus ?? 'idle']
              return (
                <Link
                  key={flow.id}
                  href={`/flows/${flow.id}`}
                  className={cn(
                    'group relative overflow-hidden rounded-xl border border-gray-200 bg-white p-4 shadow-1 transition-[transform,border-color,box-shadow] duration-base hover:-translate-y-0.5 hover:shadow-2 active:translate-y-0',
                    accent.border,
                  )}
                >
                  <div className={cn('absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
                  <div
                    aria-hidden="true"
                    className={cn('pointer-events-none absolute -right-8 -top-8 h-20 w-20 rounded-full opacity-50 blur-2xl transition-opacity duration-base group-hover:opacity-90', accent.glow)}
                  />
                  <span className="flex items-start justify-between gap-3">
                    <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg text-base leading-none', accent.chip)}>
                      {flow.icon ? <span aria-hidden="true">{flow.icon}</span> : <Workflow className="h-4 w-4" />}
                    </span>
                    {status && (
                      <span
                        className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.08em]', status.pill)}
                        aria-label={`Flow status: ${status.label}`}
                      >
                        <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', status.dot)} />
                        {status.label}
                      </span>
                    )}
                  </span>
                  <p className="mt-3 truncate text-sm font-medium text-gray-900">{flow.name}</p>
                  <p className="mt-1 text-xs text-fg-muted">edited {relativeTime(flow.updatedAt)}</p>
                </Link>
              )
            })}
      </div>
    </div>
  )
}
