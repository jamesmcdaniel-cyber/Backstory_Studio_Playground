'use client'

import { useMemo, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isDatasetFile, uploadDirect } from '@/lib/client/upload'
import { cn } from '@/lib/utils'
import { ROI_EXTRACT_KINDS, apiErrorMessage, canonicalAccountName, extractDescription, uniqueAccountNames } from '@/lib/roi/history'
import type { RoiSourceKind } from '@/lib/roi/source-kinds'
import type { RoiPageSetup } from '@/lib/roi/types'

type Step = 'idle' | 'uploading' | 'adding' | 'tagging' | 'done' | 'error'
type FileRowState = { file: File | null; step: Step; error: string | null }

const ACCEPT = '.csv,.tsv,text/csv,text/tab-separated-values'
const ACCOUNT_MAX_CHARS = 200
const NETWORK_ERROR = 'The upload could not reach the server. Check your connection and try again.'
const WORKING: Partial<Record<Step, string>> = {
  uploading: 'Uploading…',
  adding: 'Adding to the Repository…',
  tagging: 'Tagging it for the account…',
}

function emptyRows(): Record<RoiSourceKind, FileRowState> {
  return Object.fromEntries(ROI_EXTRACT_KINDS.map(({ kind }) => [kind, { file: null, step: 'idle', error: null }])) as Record<RoiSourceKind, FileRowState>
}

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return NETWORK_ERROR
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

/**
 * One extract into the Repository, tagged for the account: straight to
 * storage when the deployment can (then registered as a dataset by its
 * stored file), else as a multipart upload; then tagged with the account and
 * the extract kind, which is what the ROI page reads.
 */
async function loadExtract(params: { file: File; kind: RoiSourceKind; account: string; onStep: (step: Step) => void }): Promise<void> {
  const { file, kind, account, onStep } = params
  const description = extractDescription(kind, account)
  onStep('uploading')
  const direct = await uploadDirect(file)
  onStep('adding')
  let response: Response
  if (direct) {
    response = await fetch('/api/repository', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storedFileId: direct.id, description }),
    })
  } else {
    const form = new FormData()
    form.append('file', file)
    form.append('description', description)
    response = await fetch('/api/repository', { method: 'POST', body: form })
  }
  const added = await response.json().catch(() => ({})) as { document?: { id?: string } }
  const documentId = added.document?.id
  if (!response.ok || !documentId) throw new Error(apiErrorMessage(added, `${file.name} could not be added to the Repository.`))
  onStep('tagging')
  const tagged = await fetch('/api/roi/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId, account, kind }),
  })
  if (!tagged.ok) {
    const data = await tagged.json().catch(() => ({}))
    throw new Error(apiErrorMessage(data, `${file.name} is in the Repository but could not be tagged for ${account}.`))
  }
}

/**
 * Loading an account's extracts from the ROI page (platform operators): name
 * the account, choose a file for each extract there is, and load them. Each
 * goes into the Repository tagged with the account and its kind — the tag the
 * page builds the account's report from. Files load one after another, each
 * with its own progress; a failed one can be retried on its own.
 */
export function ExtractLoader({ setup, onLoaded }: { setup: RoiPageSetup; onLoaded: () => void }) {
  const [account, setAccount] = useState('')
  const [rows, setRows] = useState<Record<RoiSourceKind, FileRowState>>(emptyRows)
  const [loading, setLoading] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const accountRef = useRef<HTMLInputElement>(null)
  // Backstory's own readout first: its extracts make everyone's starting page.
  const suggestions = useMemo(() => uniqueAccountNames([setup.defaultAccount ?? 'Backstory', ...setup.accounts.map((entry) => entry.account)]), [setup.defaultAccount, setup.accounts])
  const pending = ROI_EXTRACT_KINDS.filter(({ kind }) => rows[kind].file && rows[kind].step !== 'done')

  const setRow = (kind: RoiSourceKind, patch: Partial<FileRowState>) => setRows((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }))

  const choose = (kind: RoiSourceKind, file: File | null) => {
    setFormError(null)
    setStatus(null)
    if (file && !isDatasetFile(file)) {
      setRow(kind, { file: null, step: 'error', error: `${file.name} is not a CSV or TSV file. Export the extract as .csv or .tsv.` })
      return
    }
    setRow(kind, { file, step: 'idle', error: null })
  }

  const load = async (event: React.FormEvent) => {
    event.preventDefault()
    if (loading) return
    const name = canonicalAccountName(account, suggestions)
    if (!name) {
      setAccountError('Name the account these extracts belong to.')
      accountRef.current?.focus()
      return
    }
    if (name.length > ACCOUNT_MAX_CHARS) {
      setAccountError(`Account names can be at most ${ACCOUNT_MAX_CHARS} characters.`)
      accountRef.current?.focus()
      return
    }
    setAccountError(null)
    if (!pending.length) {
      setFormError('Choose at least one extract file to load.')
      return
    }
    setAccount(name)
    setFormError(null)
    setLoading(true)
    const failed: string[] = []
    let loaded = 0
    for (const [index, { kind, label }] of pending.entries()) {
      const file = rows[kind].file
      if (!file) continue
      setStatus(`Loading ${index + 1} of ${pending.length}: ${label}`)
      try {
        await loadExtract({ file, kind, account: name, onStep: (step) => setRow(kind, { step, error: null }) })
        setRow(kind, { step: 'done', error: null })
        loaded += 1
      } catch (error) {
        setRow(kind, { step: 'error', error: messageOf(error, `${file.name} did not load. Try again in a moment.`) })
        failed.push(label)
      }
    }
    setLoading(false)
    onLoaded()
    const noun = (count: number) => (count === 1 ? 'extract' : 'extracts')
    const summary = failed.length
      ? `Loaded ${loaded} of ${pending.length} ${noun(pending.length)} for ${name}. ${failed.join(', ')} did not load; the reason is beside ${failed.length === 1 ? 'it' : 'each'}.`
      : `Loaded ${loaded} ${noun(loaded)} for ${name}.`
    setStatus(summary)
    // The panel may have been closed while the files loaded: say how it went either way.
    if (failed.length) toast.error(summary)
    else toast.success(summary)
  }

  return (
    <form onSubmit={load} noValidate aria-labelledby="roi-extracts-heading" className="space-y-3">
      <div>
        <h4 id="roi-extracts-heading" className="text-sm font-semibold">Load extracts</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Each extract is tagged with the account so the ROI page can build its report. Backstory's own extracts make it everyone's starting page.
        </p>
      </div>

      <div>
        <label htmlFor="roi-extract-account" className="text-xs font-medium">Account<span className="sr-only"> for these extracts</span></label>
        <Input
          ref={accountRef}
          id="roi-extract-account"
          list="roi-extract-accounts"
          value={account}
          onChange={(event) => { setAccount(event.target.value); setAccountError(null) }}
          maxLength={ACCOUNT_MAX_CHARS}
          autoComplete="off"
          disabled={loading}
          placeholder="Backstory, or a customer account"
          aria-invalid={Boolean(accountError)}
          aria-describedby={accountError ? 'roi-extract-account-error' : undefined}
          className="mt-1 h-8 px-2.5 text-sm"
        />
        <datalist id="roi-extract-accounts">
          {suggestions.map((name) => <option key={name} value={name} />)}
        </datalist>
        {accountError && <p id="roi-extract-account-error" className="mt-1 text-xs text-red-700">{accountError}</p>}
      </div>

      <ul aria-label="Extract files" className="divide-y divide-border overflow-hidden rounded-lg border">
        {ROI_EXTRACT_KINDS.map(({ kind, label }) => (
          <ExtractFileRow key={kind} kind={kind} label={label} row={rows[kind]} disabled={loading} onChoose={(file) => choose(kind, file)} />
        ))}
      </ul>

      {formError && <p role="alert" className="text-xs text-red-700">{formError}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={loading} className="shrink-0">
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
          {loading ? 'Loading…' : pending.length > 1 ? `Load ${pending.length} extracts` : pending.length === 1 ? 'Load 1 extract' : 'Load extracts'}
        </Button>
        <p aria-live="polite" className="min-w-0 flex-1 text-xs text-muted-foreground">{status}</p>
      </div>
    </form>
  )
}

function ExtractFileRow({ kind, label, row, disabled, onChoose }: {
  kind: RoiSourceKind
  label: string
  row: FileRowState
  disabled: boolean
  onChoose: (file: File | null) => void
}) {
  const inputId = `roi-extract-${kind}`
  const working = WORKING[row.step]
  const detail = working
    ? working
    : row.step === 'error'
      ? row.error
      : row.file
        ? `${row.file.name} · ${formatSize(row.file.size)}${row.step === 'done' ? ' · loaded' : ''}`
        : 'No file chosen'
  return (
    <li className="flex items-center gap-2.5 px-3 py-2">
      {row.step === 'done' ? (
        <CircleCheck className="h-4 w-4 shrink-0 text-green-600" aria-hidden />
      ) : row.step === 'error' ? (
        <CircleAlert className="h-4 w-4 shrink-0 text-red-600" aria-hidden />
      ) : working ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-horizon-600" aria-hidden />
      ) : (
        <FileSpreadsheet className={cn('h-4 w-4 shrink-0', row.file ? 'text-horizon-600' : 'text-muted-foreground')} aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{label}</p>
        <p
          // An error wraps (it says what to do); a file name stays on one line.
          className={cn('text-[11px]', row.step === 'error' ? 'break-words text-red-700' : row.step === 'done' ? 'truncate text-[var(--status-good-fg)]' : 'truncate text-muted-foreground')}
          title={detail ?? undefined}
        >
          {detail}
        </p>
      </div>
      {row.file && row.step !== 'done' && !working && (
        <button
          type="button"
          onClick={() => onChoose(null)}
          disabled={disabled}
          aria-label={`Remove the ${label} file`}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      <input
        id={inputId}
        type="file"
        accept={ACCEPT}
        disabled={disabled}
        onChange={(event) => {
          onChoose(event.target.files?.[0] ?? null)
          // Choosing the same file again still counts as a choice.
          event.target.value = ''
        }}
        className="peer sr-only"
      />
      <label
        htmlFor={inputId}
        className={cn(
          'shrink-0 cursor-pointer rounded-md border border-input bg-background px-2 py-1 text-xs font-medium transition-colors duration-fast hover:bg-muted peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {row.file ? 'Replace' : 'Choose'}<span className="sr-only"> the {label} file</span>
      </label>
    </li>
  )
}
