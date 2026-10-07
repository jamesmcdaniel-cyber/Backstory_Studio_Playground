'use client'

import { useId, useRef, useState } from 'react'
import { FileUp, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiErrorMessage } from '@/lib/roi/history'
import { cn } from '@/lib/utils'
import type { RoiOpenResult } from '@/lib/roi/types'

/**
 * Load a value readout — an .html page with its data embedded, like
 * Backstory's own "Value Readout · People.ai" — as an account's report.
 * Platform operators only; the report builds in seconds, with no run.
 */
export function ReadoutLoader({ account, onLoaded, compact = false }: {
  account: string
  onLoaded: (result: RoiOpenResult, account: string) => void
  compact?: boolean
}) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    if (!file) { setError('Choose the readout\'s .html file first.'); setState('error'); return }
    setState('loading')
    setError(null)
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('account', account)
      const response = await fetch('/api/roi/readout', { method: 'POST', body })
      const data = await response.json().catch(() => ({})) as { result?: RoiOpenResult; account?: string }
      if (!response.ok || !data.result) throw new Error(apiErrorMessage(data, 'The readout could not be loaded.'))
      setState('idle')
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
      onLoaded(data.result, data.account ?? account)
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'The readout could not be loaded.')
    }
  }

  return (
    <div className={cn('w-full', !compact && 'max-w-md')}>
      <label htmlFor={inputId} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border border-dashed bg-background px-3.5 py-3 text-left transition-colors hover:border-horizon-400 hover:bg-horizon-50/40', file && 'border-solid border-horizon-300')}>
        <FileUp className="h-5 w-5 shrink-0 text-horizon-600" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{file ? file.name : `Choose ${account}'s readout (.html)`}</span>
          <span className="block text-xs text-muted-foreground">{file ? `${(file.size / 1024).toFixed(0)} KB · ready to load` : 'The value readout page, with its data embedded'}</span>
        </span>
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".html,.htm,text/html"
        className="sr-only"
        onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(null); setState('idle') }}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button type="button" size="sm" onClick={() => void load()} disabled={state === 'loading' || !file} className="gap-1.5">
          {state === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {state === 'loading' ? 'Building the report…' : `Load ${account}'s readout`}
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  )
}
