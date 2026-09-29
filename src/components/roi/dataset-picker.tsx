'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Database, Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { uploadDirect } from '@/lib/client/upload'

export type DatasetOption = { id: string; filename: string; rows: number | null; updatedAt: string }

export type DatasetSlot = {
  key: 'activity' | 'usage' | 'engagement' | 'stages'
  label: string
  hint: string
  match: RegExp
}

/** The four extracts the analysis knows how to use. Each slot suggests the
 *  repository dataset whose name looks right, and takes a fresh upload. */
export const DATASET_SLOTS: DatasetSlot[] = [
  { key: 'activity', label: 'Activity extract', hint: 'Per-user monthly activity (Raw Data Extract). Needed for leading indicators and adoption.', match: /raw|activity|extract/i },
  { key: 'usage', label: 'Usage cohort', hint: 'Last 6 months of Backstory usage per user. Enables adopter cohorts.', match: /usage|cohort/i },
  { key: 'engagement', label: 'Opportunity engagement', hint: 'Closed opportunities with engagement scores. Enables win-rate and velocity correlations.', match: /opp.?engagement|engagement/i },
  { key: 'stages', label: 'Closed deals by stage', hint: 'Closed won/lost deals with persona activity per stage. Enables the persona and timing analysis.', match: /closed|stage/i },
]

type RepositoryAsset = { id: string; filename: string; assetType: string; updatedAt: string; sourceMetadata?: { dataset?: { rowCount?: number } } }

async function listDatasets(): Promise<DatasetOption[]> {
  const response = await fetch('/api/repository?limit=100', { cache: 'no-store' })
  const data = await response.json().catch(() => ({})) as { assets?: RepositoryAsset[]; items?: RepositoryAsset[] }
  const assets = data.assets ?? data.items ?? []
  return assets
    .filter((asset) => asset.assetType === 'dataset')
    .map((asset) => ({ id: asset.id, filename: asset.filename, rows: asset.sourceMetadata?.dataset?.rowCount ?? null, updatedAt: asset.updatedAt }))
}

export function DatasetPicker({ value, onChange }: { value: Record<string, string | null>; onChange: (next: Record<string, string | null>) => void }) {
  const [options, setOptions] = useState<DatasetOption[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState<string | null>(null)
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})

  const load = useCallback(async () => {
    try {
      const next = await listDatasets()
      setOptions(next)
      return next
    } catch {
      toast.error('Could not load the repository datasets.')
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load().then((loaded) => {
      // Suggest a dataset per slot from the names, once, without overriding a choice.
      const suggested = { ...value }
      let changed = false
      for (const slot of DATASET_SLOTS) {
        if (suggested[slot.key]) continue
        const taken = new Set(Object.values(suggested).filter(Boolean))
        const match = loaded.find((option) => slot.match.test(option.filename) && !taken.has(option.id))
        if (match) { suggested[slot.key] = match.id; changed = true }
      }
      if (changed) onChange(suggested)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const upload = async (slot: DatasetSlot, file: File | undefined) => {
    if (!file) return
    if (!/\.(csv|tsv)$/i.test(file.name)) { toast.error('Datasets are CSV or TSV files.'); return }
    setUploading(slot.key)
    try {
      const stored = await uploadDirect(file)
      if (!stored) throw new Error('Direct uploads are not available in this deployment.')
      const response = await fetch('/api/repository', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storedFileId: stored.id }) })
      const data = await response.json().catch(() => ({})) as { document?: { id: string }; error?: string }
      if (!response.ok || !data.document) throw new Error(data.error || `Could not add ${file.name}.`)
      await load()
      onChange({ ...value, [slot.key]: data.document.id })
      toast.success(`Added "${file.name}" to the repository.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(null)
      const input = inputs.current[slot.key]
      if (input) input.value = ''
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {DATASET_SLOTS.map((slot) => {
        const selected = value[slot.key] ?? ''
        const chosen = options.find((option) => option.id === selected)
        return (
          <div key={slot.key} className={cn('rounded-xl border p-3', selected ? 'border-horizon-300 bg-horizon-50/40' : 'border-border')}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{slot.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{slot.hint}</p>
              </div>
              {selected ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-horizon-600" aria-hidden /> : <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="sr-only" htmlFor={`dataset-${slot.key}`}>{slot.label}</label>
              <select
                id={`dataset-${slot.key}`}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                value={selected}
                disabled={loading}
                onChange={(event) => onChange({ ...value, [slot.key]: event.target.value || null })}
              >
                <option value="">{loading ? 'Loading datasets…' : 'Not used'}</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>{option.filename}{option.rows ? ` · ${option.rows.toLocaleString()} rows` : ''}</option>
                ))}
              </select>
              <input
                ref={(el) => { inputs.current[slot.key] = el }}
                type="file"
                accept=".csv,.tsv,text/csv,text/tab-separated-values"
                className="sr-only"
                id={`upload-${slot.key}`}
                onChange={(event) => void upload(slot, event.target.files?.[0])}
              />
              <label
                htmlFor={`upload-${slot.key}`}
                className={cn('inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-muted', uploading === slot.key && 'pointer-events-none opacity-60')}
                title="Upload a CSV or TSV (up to 200 MB)"
              >
                {uploading === slot.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Upload className="h-3.5 w-3.5" aria-hidden />}
                Upload
              </label>
            </div>
            {chosen && <p className="mt-1.5 truncate text-[11px] text-muted-foreground">Using {chosen.filename}</p>}
          </div>
        )
      })}
    </div>
  )
}
