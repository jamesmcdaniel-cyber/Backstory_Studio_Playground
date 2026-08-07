'use client'

import { useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'

export interface SubmissionStatus {
  id: string
  status: string
  reviewNote: string | null
}

export interface CatalogueItem {
  id: string
  kind: 'flow_template' | 'agent_template' | 'shared_skill'
  name: string
}

// Status copy is plain English: the author should never see a raw enum.
const STATUS_COPY: Record<string, string> = {
  pending: 'Waiting for review',
  approved: 'Published to the catalogue',
  rejected: 'Not accepted for the catalogue',
}

export function SubmitToCatalogue({
  item,
  canSubmit,
  submission,
  onSubmitted,
}: {
  item: CatalogueItem
  canSubmit: boolean
  submission: SubmissionStatus | null
  onSubmitted?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Only Backstory and People.ai workspaces may propose catalogue entries.
  // Everyone else shares within their own workspace and sees nothing here.
  if (!canSubmit) return null

  // A decided-but-resubmittable state (changes_requested) falls through to the
  // form so the author can act on the note without hunting for a second button.
  const settled = submission && submission.status !== 'changes_requested'
  if (settled) {
    return (
      <p className="text-xs text-neutral-500">
        {STATUS_COPY[submission.status] ?? 'Submitted'}
      </p>
    )
  }

  async function submit() {
    if (!summary.trim()) {
      setError('Describe what this does, so a reviewer knows what they are approving.')
      return
    }
    setBusy(true)
    setError(null)
    const response = await fetch('/api/catalogue/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: item.kind, sourceId: item.id, title: item.name, summary }),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.error ?? 'That could not be submitted. Try again.')
      return
    }
    setOpen(false)
    setSummary('')
    onSubmitted?.()
  }

  return (
    <div className="space-y-2">
      {submission?.status === 'changes_requested' && submission.reviewNote && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {submission.reviewNote}
        </p>
      )}

      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium underline">
          Submit to catalogue
        </button>
      ) : (
        <div className="space-y-2">
          <textarea
            onKeyDown={indentOnTab}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="What does this do, and who is it for?"
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={3}
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={busy} className="text-xs font-medium underline">
              {busy ? 'Submitting…' : 'Send for review'}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-neutral-500">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
