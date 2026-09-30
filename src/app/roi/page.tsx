'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, ExternalLink, History, Loader2, MessageSquare, RotateCcw, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

/**
 * The ROI page leads with the dashboard: the newest finished analysis
 * renders here, full width, with the way to ask about it one click away.
 * Building a new one — another account, another window — is below it.
 */
export default function RoiPage() {
  const [analyses, setAnalyses] = useState<RoiAnalysisView[] | null>(null)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/roi/analyses', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { analyses?: RoiAnalysisView[] }) => { if (!cancelled) setAnalyses(data.analyses ?? []) })
      .catch(() => { if (!cancelled) setAnalyses([]) })
    return () => { cancelled = true }
  }, [])

  const latest = analyses?.find((analysis) => analysis.status === 'completed' && analysis.hasReport) ?? null
  // The dashboard lives on as an artifact: edits made through its assistant
  // are new versions there, so the page shows the artifact's current version.
  const artifactId = typeof (latest?.results as { artifactId?: unknown } | null)?.artifactId === 'string' ? (latest!.results as { artifactId: string }).artifactId : null
  const reportSrc = latest ? (artifactId ? `/api/artifacts/${artifactId}/versions/current/content` : `/api/roi/analyses/${latest.id}/report`) : null
  const askHref = latest ? (artifactId ? `/artifacts/${artifactId}` : `/roi/${latest.id}`) : null
  const formOpen = showForm || (analyses !== null && !latest)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-horizon-700"><TrendingUp className="h-3.5 w-3.5" aria-hidden /> ROI analysis</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{latest ? latest.account : 'Build the ROI story for an account'}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {latest
              ? `${latest.timeframeLabel} · built ${relativeTime(latest.updatedAt)} from the account's extracts in the Repository.`
              : 'Pick the account and the time frame. The ROI Analyst computes leading indicators, adoption cohorts, engagement-to-outcome correlations and persona timing, then hands you an interactive dashboard you can question.'}
          </p>
        </div>
        {latest && (
          <div className="flex items-center gap-2">
            <Link href={askHref!}><Button size="sm"><MessageSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden />Ask or change</Button></Link>
            {artifactId && <Link href={askHref!}><Button variant="outline" size="sm"><History className="mr-1.5 h-3.5 w-3.5" aria-hidden />Versions</Button></Link>}
            <a href={reportSrc!} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-muted">Full page <ExternalLink className="h-3 w-3" aria-hidden /></a>
            <Button variant="outline" size="sm" onClick={() => setShowForm((value) => !value)}><RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />{showForm ? 'Hide' : 'New analysis'}</Button>
          </div>
        )}
      </div>

      {latest && (
        <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
          <iframe
            title={`ROI dashboard for ${latest.account}`}
            src={reportSrc!}
            sandbox="allow-scripts"
            className="block h-[calc(100vh-200px)] min-h-[720px] w-full"
          />
        </div>
      )}

      {analyses === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>
      ) : formOpen ? (
        <div className="rounded-2xl border border-border bg-background p-5 shadow-sm">
          {latest && <h2 className="mb-4 text-sm font-medium">New analysis</h2>}
          <RoiForm />
        </div>
      ) : null}

      {analyses && analyses.length > 0 && (
        <section aria-labelledby="roi-past">
          <h2 id="roi-past" className="text-sm font-medium">All analyses</h2>
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
        </section>
      )}
    </div>
  )
}
