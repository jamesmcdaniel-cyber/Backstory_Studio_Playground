'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowUp, Loader2, MessageSquare, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { indentOnTab } from '@/components/ui/textarea'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { cn } from '@/lib/utils'
import type { RoiAnalysisView } from '@/lib/roi/types'
import { RunFeed } from './run-feed'
import { useAgentExecStream } from './use-agent-exec-stream'

/**
 * One analysis: the run while it is running, the dashboard once it is
 * done, and a conversation with the analyst beside it. The report renders
 * in an iframe with a scripts-only sandbox (no same-origin, no network) so
 * the charts can be interactive without the page trusting the document.
 */
export function AnalysisView({ id }: { id: string }) {
  const [analysis, setAnalysis] = useState<RoiAnalysisView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const chatEnd = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/roi/analyses/${id}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({})) as { analysis?: RoiAnalysisView; error?: string }
      if (!response.ok || !data.analysis) throw new Error(data.error || 'Could not load the analysis.')
      setAnalysis(data.analysis)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [id])

  const pendingAnswer = analysis?.chat.find((message) => message.status === 'pending')
  const running = Boolean(analysis && !isTerminalRunStatus(analysis.status))
  const busy = running || Boolean(pendingAnswer)

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => (busy ? startVisibleInterval(() => void refresh(), 10_000) : undefined), [busy, refresh])
  useAgentExecStream(pendingAnswer?.executionId, () => void refresh(), Boolean(pendingAnswer))
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'nearest' }) }, [analysis?.chat.length, pendingAnswer])

  const ask = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!question.trim() || asking || !analysis) return
    setAsking(true)
    try {
      const response = await fetch(`/api/roi/analyses/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) })
      const data = await response.json().catch(() => ({})) as { analysis?: RoiAnalysisView; error?: string }
      if (!response.ok || !data.analysis) throw new Error(data.error || 'The question could not be sent.')
      setAnalysis(data.analysis)
      setQuestion('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setAsking(false)
    }
  }

  if (error && !analysis) {
    return <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">{error} <Link href="/roi" className="underline">Back to ROI</Link></div>
  }
  if (!analysis) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/roi" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3 w-3" aria-hidden /> All analyses</Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{analysis.account}</h1>
          <p className="text-sm text-muted-foreground">{analysis.timeframeLabel} · {analysis.datasets.length} dataset{analysis.datasets.length === 1 ? '' : 's'} · started {new Date(analysis.createdAt).toLocaleString()}</p>
        </div>
        <Link href="/roi"><Button variant="outline" size="sm"><RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />New analysis</Button></Link>
      </div>

      {analysis.executionId && (running || analysis.status !== 'completed') && (
        <RunFeed executionId={analysis.executionId} status={analysis.status} onStatusChange={() => void refresh()} />
      )}

      {analysis.status !== 'completed' && isTerminalRunStatus(analysis.status) && (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-medium">The analysis {analysis.status}.</p>
          {analysis.error && <p className="mt-1">{analysis.error}</p>}
          {analysis.executionId && <Link href={`/agents?run=${analysis.executionId}`} className="mt-2 inline-block underline">Open the run</Link>}
        </div>
      )}

      {analysis.status === 'completed' && analysis.hasReport && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-white">
            <iframe
              title={`ROI dashboard for ${analysis.account}`}
              src={`/api/roi/analyses/${id}/report`}
              sandbox="allow-scripts"
              className="block h-[calc(100vh-220px)] min-h-[640px] w-full"
            />
          </div>
          <aside className="flex min-h-[420px] flex-col rounded-xl border border-border bg-background">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-medium"><MessageSquare className="h-4 w-4 text-horizon-600" aria-hidden /> Ask the analyst</div>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {!analysis.chat.length && <p className="text-xs text-muted-foreground">Ask about anything on the dashboard — why a number moved, what a cohort looks like, what to tell the customer. Answers are computed from the same extracts.</p>}
              {analysis.chat.map((message, index) => (
                <div key={`${message.createdAt}-${index}`} className={cn('text-sm', message.role === 'user' ? 'ml-6 rounded-xl bg-horizon-50 px-3 py-2 dark:bg-horizon-900/40' : '')}>
                  {message.role === 'agent' && message.status === 'pending' ? (
                    <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Working on it…</div>
                  ) : message.role === 'agent' ? (
                    <div className={cn(message.status === 'failed' && 'text-destructive')}><Markdown>{message.content}</Markdown></div>
                  ) : (
                    <p>{message.content}</p>
                  )}
                </div>
              ))}
              <div ref={chatEnd} />
            </div>
            <form onSubmit={ask} className="border-t border-border p-3">
              <label htmlFor="roi-question" className="sr-only">Question</label>
              <div className="flex items-end gap-2">
                <textarea
                  id="roi-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => { indentOnTab(event); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(event) } }}
                  rows={2}
                  maxLength={2000}
                  disabled={Boolean(pendingAnswer)}
                  placeholder={pendingAnswer ? 'Waiting for the answer…' : 'Why did executive meetings fall in Q2?'}
                  className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                />
                <Button type="submit" size="icon" disabled={!question.trim() || asking || Boolean(pendingAnswer)} aria-label="Send question">
                  {asking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
                </Button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </div>
  )
}
