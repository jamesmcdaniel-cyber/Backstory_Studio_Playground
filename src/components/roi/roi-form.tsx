'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Database, Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { indentOnTab } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ROI_TIMEFRAMES, type RoiTimeframePreset } from '@/lib/roi/timeframe'

type Source = { account: string; datasets: Partial<Record<'activity' | 'usage' | 'engagement' | 'stages', { documentId: string; filename: string; rows: number | null; loadedAt: string }>> }

const KIND_LABEL: Record<string, string> = { activity: 'Activity', usage: 'Usage', engagement: 'Deal engagement', stages: 'Stage & persona' }

/**
 * The static form: account, plain-English time frame, optional context.
 * The account's extracts already live in the repository (loaded by an
 * operator, or by the warehouse flow); nobody picks files here. Submitting
 * starts the run and lands on the analysis page, which follows it live.
 */
export function RoiForm({ onStarted }: { onStarted?: () => void } = {}) {
  const router = useRouter()
  const [sources, setSources] = useState<Source[] | null>(null)
  const [account, setAccount] = useState('')
  const [timeframe, setTimeframe] = useState<RoiTimeframePreset>('last6_vs_prior6')
  const [context, setContext] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/roi/sources', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { sources?: Source[] }) => {
        if (cancelled) return
        const list = data.sources ?? []
        setSources(list)
        if (list.length && !account) setAccount(list[0].account)
      })
      .catch(() => { if (!cancelled) setSources([]) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = sources?.find((source) => source.account === account) ?? null
  const kinds = selected ? (Object.keys(selected.datasets) as Array<keyof Source['datasets']>) : []
  const canSubmit = Boolean(selected) && kinds.length > 0 && !submitting

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const response = await fetch('/api/roi/analyses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, timeframe, context }),
      })
      const data = await response.json().catch(() => ({})) as { analysis?: { id: string; artifactId: string | null }; error?: string }
      if (!response.ok || !data.analysis) throw new Error(data.error || 'The analysis could not be started.')
      toast.success('Analysis started — you will be notified when the dashboard is ready.')
      onStarted?.()
      router.push(data.analysis.artifactId ? `/artifacts/${data.analysis.artifactId}` : '/artifacts')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="roi-account" className="text-sm font-medium">Account</label>
          {sources === null ? (
            <div className="mt-1.5 flex h-10 items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading accounts…</div>
          ) : sources.length === 0 ? (
            <div className="mt-1.5 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
              No accounts have extracts loaded yet. An operator loads an account's extracts into the Repository; it then appears here.
            </div>
          ) : (
            <select id="roi-account" value={account} onChange={(event) => setAccount(event.target.value)} className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {sources.map((source) => <option key={source.account} value={source.account}>{source.account}</option>)}
            </select>
          )}
          {selected && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Database className="h-3.5 w-3.5" aria-hidden />
              {(['activity', 'usage', 'engagement', 'stages'] as const).map((kind) => (
                <span key={kind} className={cn('rounded-full border px-2 py-0.5', selected.datasets[kind] ? 'border-horizon-300 bg-horizon-50 text-horizon-800' : 'border-border text-muted-foreground line-through')} title={selected.datasets[kind] ? `${selected.datasets[kind]!.filename} · ${selected.datasets[kind]!.rows?.toLocaleString() ?? '?'} rows` : 'Not loaded'}>
                  {KIND_LABEL[kind]}
                </span>
              ))}
            </p>
          )}
        </div>
        <div>
          <p className="text-sm font-medium" id="roi-timeframe-label">Time frame</p>
          <div role="radiogroup" aria-labelledby="roi-timeframe-label" className="mt-1.5 flex flex-wrap gap-1.5">
            {ROI_TIMEFRAMES.map((option) => (
              <button
                key={option.preset}
                type="button"
                role="radio"
                aria-checked={timeframe === option.preset}
                onClick={() => setTimeframe(option.preset)}
                title={option.description}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  timeframe === option.preset ? 'border-horizon-600 bg-horizon-600 text-white' : 'border-border bg-background text-foreground hover:bg-muted',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{ROI_TIMEFRAMES.find((option) => option.preset === timeframe)?.description}</p>
        </div>
      </div>

      <div>
        <label htmlFor="roi-context" className="text-sm font-medium">Additional context <span className="font-normal text-muted-foreground">(optional)</span></label>
        <textarea
          id="roi-context"
          value={context}
          onChange={(event) => setContext(event.target.value)}
          onKeyDown={indentOnTab}
          rows={3}
          maxLength={4000}
          placeholder="Anything the analyst should know: the customer's goals, a region to focus on, what leadership has asked for…"
          className="mt-1.5 flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Runs in the background — usually 5–15 minutes. You can leave this page.</p>
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />}
          Build ROI analysis
        </Button>
      </div>
    </form>
  )
}
