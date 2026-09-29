'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Bot, ChevronRight, FileOutput, Loader2, Search, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { relativeTime } from '@/lib/relative-time'
import { ARTIFACT_KIND_LABEL, type ArtifactKind, type ArtifactListItem } from '@/lib/artifacts/types'

/**
 * Everything the workspace's agents have produced. Filter by kind or agent,
 * open one to read it, ask about it, or ask for a change.
 */
export default function ArtifactsPage() {
  const [items, setItems] = useState<ArtifactListItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<ArtifactKind | 'all'>('all')
  const [archived, setArchived] = useState(false)

  useEffect(() => {
    let cancelled = false
    setItems(null)
    fetch(`/api/artifacts${archived ? '?archived=true' : ''}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { artifacts?: ArtifactListItem[] }) => { if (!cancelled) setItems(data.artifacts ?? []) })
      .catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [archived])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter((item) => (kind === 'all' || item.kind === kind) && (!q || item.title.toLowerCase().includes(q) || item.agent?.title.toLowerCase().includes(q) || item.flow?.name.toLowerCase().includes(q)))
  }, [items, query, kind])

  const kinds = useMemo(() => [...new Set((items ?? []).map((item) => item.kind))], [items])

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-horizon-700"><FileOutput className="h-3.5 w-3.5" aria-hidden /> Artifacts</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">What your agents have produced</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Every report, dashboard and document, with its versions. Open one to ask the agent about it or ask for a change — a change makes a new version and keeps the old one.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <label htmlFor="artifact-search" className="sr-only">Search artifacts</label>
          <Input id="artifact-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title, agent or flow" className="w-72 pl-8" />
        </div>
        <div role="radiogroup" aria-label="Kind" className="flex flex-wrap gap-1.5">
          {(['all', ...kinds] as Array<ArtifactKind | 'all'>).map((option) => (
            <button key={option} type="button" role="radio" aria-checked={kind === option} onClick={() => setKind(option)} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${kind === option ? 'border-horizon-600 bg-horizon-600 text-white' : 'border-border hover:bg-muted'}`}>
              {option === 'all' ? 'All' : ARTIFACT_KIND_LABEL[option]}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} /> Show archived
        </label>
      </div>

      {items === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={FileOutput}
          title={items.length ? 'Nothing matches' : 'No artifacts yet'}
          description={items.length ? 'Try another search or kind.' : 'When an agent finishes a run with a report, it appears here automatically.'}
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {visible.map((item) => (
            <li key={item.id}>
              <Link href={`/artifacts/${item.id}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/50">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{item.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {item.agent && <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" aria-hidden />{item.agent.title}</span>}
                    {item.flow && <span className="inline-flex items-center gap-1"><Workflow className="h-3 w-3" aria-hidden />{item.flow.name}</span>}
                    <span>{item.versionCount} version{item.versionCount === 1 ? '' : 's'}</span>
                    <span>updated {relativeTime(item.updatedAt)}</span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant="secondary">{ARTIFACT_KIND_LABEL[item.kind]}</Badge>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
