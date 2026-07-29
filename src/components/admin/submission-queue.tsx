'use client'

export interface QueuedSubmission {
  id: string
  kind: string
  title: string
  summary: string
  status: string
  organizationId: string
  createdAt: string
}

// Plain English everywhere a raw enum would otherwise leak into the UI.
const KIND_LABELS: Record<string, string> = {
  flow_template: 'Flow template',
  agent_template: 'Agent template',
  shared_skill: 'Skill',
}

export function SubmissionQueue({
  submissions,
  selectedId,
  onSelect,
}: {
  submissions: QueuedSubmission[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  if (submissions.length === 0) {
    return (
      <p className="p-6 text-sm text-neutral-500">
        Nothing waiting for review right now.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
      {submissions.map((submission) => (
        <li key={submission.id}>
          <button
            type="button"
            onClick={() => onSelect(submission.id)}
            aria-current={selectedId === submission.id}
            className="w-full px-4 py-3 text-left hover:bg-neutral-50 aria-[current=true]:bg-neutral-100 dark:hover:bg-neutral-900 dark:aria-[current=true]:bg-neutral-900"
          >
            <span className="block text-sm font-medium">{submission.title}</span>
            <span className="mt-0.5 block text-xs text-neutral-500">
              {KIND_LABELS[submission.kind] ?? submission.kind}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
