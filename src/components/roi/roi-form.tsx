'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { indentOnTab } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ROI_TIMEFRAMES, type RoiTimeframePreset } from '@/lib/roi/timeframe'
import { DatasetPicker } from './dataset-picker'

/**
 * The static form: account, time frame, optional context, the extracts to
 * use. Submitting starts the run and lands on the analysis page, which
 * follows the run live — nobody has to prompt an agent.
 */
export function RoiForm() {
  const router = useRouter()
  const [account, setAccount] = useState('')
  const [timeframe, setTimeframe] = useState<RoiTimeframePreset>('last6_vs_prior6')
  const [context, setContext] = useState('')
  const [datasets, setDatasets] = useState<Record<string, string | null>>({})
  const [submitting, setSubmitting] = useState(false)

  const datasetIds = [...new Set(Object.values(datasets).filter((id): id is string => Boolean(id)))]
  const canSubmit = account.trim().length > 0 && datasetIds.length > 0 && !submitting

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const response = await fetch('/api/roi/analyses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: account.trim(), timeframe, context, datasetIds }),
      })
      const data = await response.json().catch(() => ({})) as { analysis?: { id: string }; error?: string }
      if (!response.ok || !data.analysis) throw new Error(data.error || 'The analysis could not be started.')
      toast.success('Analysis started — you will be notified when the dashboard is ready.')
      router.push(`/roi/${data.analysis.id}`)
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
          <Input id="roi-account" value={account} onChange={(event) => setAccount(event.target.value)} placeholder="e.g. Iron Mountain" className="mt-1.5" required maxLength={200} />
          <p className="mt-1 text-xs text-muted-foreground">The customer the extracts belong to.</p>
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
        <p className="text-sm font-medium">Data</p>
        <p className="mb-2 mt-0.5 text-xs text-muted-foreground">Pick the extracts from the repository, or upload fresh ones. Sections without data are left out of the dashboard, not made up.</p>
        <DatasetPicker value={datasets} onChange={setDatasets} />
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
