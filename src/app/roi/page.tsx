'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Loader2, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { RoiForm } from '@/components/roi/roi-form'
import type { RoiAnalysisView } from '@/lib/roi/types'
import { relativeTime } from '@/lib/relative-time'

const STATUS_LABEL: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  completed: 'Ready',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
}

export default function RoiPage() {
  const [analyses, setAnalyses] = useState<RoiAnalysisView[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/roi/analyses', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { analyses?: RoiAnalysisView[] }) => { if (!cancelled) setAnalyses(data.analyses ?? []) })
      .catch(() => { if (!cancelled) setAnalyses([]) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-horizon-700"><TrendingUp className="h-3.5 w-3.5" aria-hidden /> ROI analysis</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Build the ROI story for an account</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Pick the account, the time frame and the extracts. The ROI Analyst computes leading indicators, adoption cohorts, engagement-to-outcome correlations and persona timing, then hands you an interactive dashboard you can question.</p>
      </div>

      <div className="rounded-2xl border border-border bg-background p-5 shadow-sm">
        <RoiForm />
      </div>

      <section aria-labelledby="roi-past">
        <h2 id="roi-past" className="text-sm font-medium">Past analyses</h2>
        {analyses === null ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>
        ) : analyses.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing yet. The first analysis appears here as soon as it starts.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {analyses.map((analysis) => (
              <li key={analysis.id}>
                <Link href={`/roi/${analysis.id}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/50">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{analysis.account}</span>
                    <span className="block truncate text-xs text-muted-foreground">{analysis.timeframeLabel} · {relativeTime(analysis.createdAt)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant={analysis.status === 'completed' ? 'default' : analysis.status === 'failed' || analysis.status === 'blocked' ? 'destructive' : 'secondary'}>{STATUS_LABEL[analysis.status] ?? analysis.status}</Badge>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
