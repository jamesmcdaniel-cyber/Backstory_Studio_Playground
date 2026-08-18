'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cardAccent } from '@/lib/flows/card-accent'
import { relativeTime } from '@/lib/relative-time'
import { Skeleton } from '@/components/ui/skeleton'

/** How many shortcuts the row shows. */
const LIMIT = 3

type RecentFlow = {
  id: string
  name: string
  /** Emoji card icon ('' = the generic Workflow glyph). */
  icon?: string
  updatedAt: string
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
    fetch('/api/flows', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!alive || !data?.success) return
        setFlows(((data.flows ?? []) as RecentFlow[]).slice(0, LIMIT))
      })
      // A shortcut row is not worth an error state — it competes with the
      // composer for attention. A failure just leaves the row absent.
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
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
                  <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg text-base leading-none', accent.chip)}>
                    {flow.icon ? <span aria-hidden="true">{flow.icon}</span> : <Workflow className="h-4 w-4" />}
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
