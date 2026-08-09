'use client'

export interface QueuedSubmission {
  id: string
  kind: string
  title: string
  summary: string
  status: string
  organizationId: string
  createdAt: string
  organization?: { name: string; kind: string } | null
  warnings?: SubmissionWarning[] | null
}

export interface SubmissionWarning {
  path: string
  reason: string
  preview: string
}

/** True for a workspace that is not staff — its submissions come from outside. */
export function isExternalOrg(kind: string | null | undefined): boolean {
  return kind !== 'internal' && kind !== 'partner'
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
              {submission.organization ? ` · ${submission.organization.name}` : ''}
            </span>
            <span className="mt-1 flex gap-1.5">
              {isExternalOrg(submission.organization?.kind) && (
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                  External
                </span>
              )}
              {(submission.warnings?.length ?? 0) > 0 && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  {submission.warnings!.length} to check
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
