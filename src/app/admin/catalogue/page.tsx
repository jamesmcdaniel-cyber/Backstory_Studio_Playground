'use client'

import { useCallback, useEffect, useState } from 'react'
import { SubmissionQueue, type QueuedSubmission } from '@/components/admin/submission-queue'
import { SubmissionDetail, type DetailSubmission } from '@/components/admin/submission-detail'

type Tab = 'queue' | 'published' | 'legacy' | 'staff'

const TABS: { id: Tab; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'published', label: 'Published' },
  { id: 'legacy', label: 'Legacy' },
  { id: 'staff', label: 'Staff' },
]

const KIND_LABELS: Record<string, string> = {
  flow_template: 'Flow template',
  agent_template: 'Agent template',
  shared_skill: 'Skill',
}

type Entry = { id: string; name: string; kind: string; organizationId: string; updatedAt: string }
type StaffOrg = { id: string; name: string; slug: string; kind: string }
type StaffUser = { id: string; email: string | null; name: string | null; platformRole: string | null; organizationId: string }

export default function CatalogueAdminPage() {
  const [tab, setTab] = useState<Tab>('queue')

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Catalogue</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Review what workspaces propose, and manage what the shared catalogue serves.
        </p>
      </header>

      <nav className="flex gap-4 border-b border-neutral-200 dark:border-neutral-800">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id}
            className="-mb-px border-b-2 border-transparent px-1 pb-2 text-sm aria-[current=true]:border-neutral-900 aria-[current=true]:font-medium dark:aria-[current=true]:border-neutral-100"
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'queue' && <QueueTab />}
      {tab === 'published' && <EntriesTab status="published" />}
      {tab === 'legacy' && <EntriesTab status="legacy_published" />}
      {tab === 'staff' && <StaffTab />}
    </div>
  )
}

function QueueTab() {
  const [submissions, setSubmissions] = useState<DetailSubmission[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const response = await fetch('/api/catalogue/review?status=pending', { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    const rows: DetailSubmission[] = body.success ? body.submissions : []
    setSubmissions(rows)
    setSelectedId((current) => (rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null))
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const selected = submissions.find((row) => row.id === selectedId) ?? null

  if (loading) return <p className="p-6 text-sm text-neutral-500">Loading the queue…</p>

  return (
    <div className="grid gap-6 md:grid-cols-[18rem_1fr]">
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
        <SubmissionQueue
          submissions={submissions as unknown as QueuedSubmission[]}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
        {selected
          ? <SubmissionDetail submission={selected} onDecided={load} />
          : <p className="p-6 text-sm text-neutral-500">Pick a submission to review it.</p>}
      </div>
    </div>
  )
}

function EntriesTab({ status }: { status: 'published' | 'legacy_published' }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const response = await fetch(`/api/catalogue/entries?status=${status}`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    setEntries(body.success ? body.entries : [])
    setLoading(false)
  }, [status])

  useEffect(() => { void load() }, [load])

  async function takedown(id: string) {
    setError(null)
    const response = await fetch(`/api/catalogue/entries/${id}`, { method: 'DELETE' })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.error ?? 'That entry could not be retired. Try again.')
      return
    }
    void load()
  }

  if (loading) return <p className="p-6 text-sm text-neutral-500">Loading entries…</p>

  if (entries.length === 0) {
    return (
      <p className="p-6 text-sm text-neutral-500">
        {status === 'published'
          ? 'Nothing has been published through review yet.'
          : 'No entries predate the review gate.'}
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {status === 'legacy_published' && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          These reached the catalogue before review existed. They are still being served — retire anything that
          should not be.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {entries.map((entry) => (
          <li key={`${entry.kind}:${entry.id}`} className="flex items-center justify-between px-4 py-3">
            <div>
              <span className="block text-sm font-medium">{entry.name}</span>
              <span className="text-xs text-neutral-500">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
            </div>
            <button type="button" onClick={() => takedown(entry.id)} className="text-xs text-neutral-500 underline">
              Retire
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StaffTab() {
  const [organizations, setOrganizations] = useState<StaffOrg[]>([])
  const [users, setUsers] = useState<StaffUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const response = await fetch('/api/catalogue/staff', { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    setOrganizations(body.success ? body.organizations : [])
    setUsers(body.success ? body.users : [])
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  async function patch(payload: Record<string, unknown>) {
    setError(null)
    const response = await fetch('/api/catalogue/staff', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.error ?? 'That change could not be saved. Try again.')
      return
    }
    void load()
  }

  if (loading) return <p className="p-6 text-sm text-neutral-500">Loading staff…</p>

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Workspaces</h2>
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {organizations.map((org) => (
            <li key={org.id} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm">{org.name}</span>
              <select
                value={org.kind}
                onChange={(event) => patch({ organizationId: org.id, orgKind: event.target.value })}
                className="rounded-md border px-2 py-1 text-xs"
              >
                <option value="internal">Backstory (internal)</option>
                <option value="partner">People.ai (partner)</option>
                <option value="customer">Customer</option>
              </select>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">People</h2>
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {users.map((user) => (
            <li key={user.id} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm">{user.name || user.email || user.id}</span>
              <select
                value={user.platformRole ?? ''}
                onChange={(event) => patch({ userId: user.id, platformRole: event.target.value || null })}
                className="rounded-md border px-2 py-1 text-xs"
              >
                <option value="">No platform role</option>
                <option value="staff">Staff</option>
                <option value="reviewer">Reviewer</option>
              </select>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
