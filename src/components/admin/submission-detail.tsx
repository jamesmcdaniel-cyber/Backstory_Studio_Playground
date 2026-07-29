'use client'

import { useState } from 'react'
import type { QueuedSubmission } from './submission-queue'

type Decision = 'approved' | 'changes_requested' | 'rejected'

// Approve needs no note; the other two are worthless to an author without one.
const NOTE_REQUIRED: Record<Decision, boolean> = {
  approved: false,
  changes_requested: true,
  rejected: true,
}

export type DetailSubmission = QueuedSubmission & { snapshot: Record<string, unknown> }

/** The instructions a reviewer actually reads, wherever the kind stores them. */
function readInstructions(snapshot: Record<string, unknown>): string | null {
  if (typeof snapshot.instructions === 'string') return snapshot.instructions
  const configuration = snapshot.configuration as { instructions?: unknown } | undefined
  if (configuration && typeof configuration.instructions === 'string') return configuration.instructions
  return null
}

export function SubmissionDetail({
  submission,
  onDecided,
}: {
  submission: DetailSubmission
  onDecided: () => void
}) {
  const [pending, setPending] = useState<Decision | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function decide(decision: Decision) {
    if (NOTE_REQUIRED[decision] && !note.trim()) {
      setError('Explain what needs to change so the author can act on it.')
      return
    }
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/catalogue/review/${submission.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, note: note.trim() || undefined }),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(
        // 409 means another reviewer got there first — say so plainly rather
        // than showing a generic failure the reviewer would retry forever.
        response.status === 409
          ? 'Another reviewer already decided this one.'
          : body.error ?? 'That decision could not be saved. Try again.',
      )
      return
    }
    setNote('')
    setPending(null)
    onDecided()
  }

  const instructions = readInstructions(submission.snapshot)
  const graph = submission.kind === 'flow_template' ? submission.snapshot.graph : null

  return (
    <div className="space-y-4 p-6">
      <header>
        <h2 className="text-lg font-medium">{submission.title}</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{submission.summary}</p>
      </header>

      {instructions && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-4 text-xs dark:bg-neutral-900">
          {instructions}
        </pre>
      )}

      {graph != null && (
        <details className="rounded-md border border-neutral-200 dark:border-neutral-800">
          <summary className="cursor-pointer px-4 py-2 text-xs font-medium">Flow graph</summary>
          <pre className="max-h-96 overflow-auto px-4 pb-4 text-xs">{JSON.stringify(graph, null, 2)}</pre>
        </details>
      )}

      {pending && NOTE_REQUIRED[pending] && (
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What does the author need to change?"
          className="w-full rounded-md border px-3 py-2 text-sm"
          rows={3}
        />
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-3">
        <button type="button" disabled={busy} onClick={() => decide('approved')} className="text-sm font-medium underline">
          Approve &amp; publish
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => (pending === 'changes_requested' ? decide('changes_requested') : setPending('changes_requested'))}
          className="text-sm underline"
        >
          Request changes
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => (pending === 'rejected' ? decide('rejected') : setPending('rejected'))}
          className="text-sm text-neutral-500 underline"
        >
          Reject
        </button>
      </div>
    </div>
  )
}
