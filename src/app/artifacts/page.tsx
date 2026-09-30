'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Bot, ChevronRight, FileOutput, Loader2, Search, TrendingUp, Upload, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RoiForm } from '@/components/roi/roi-form'
import { useAuth } from '@/hooks/use-auth'
import { isCustomerEdition } from '@/lib/edition'
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
  const searchParams = useSearchParams()
  const initialKind = searchParams?.get('kind')
  const [kind, setKind] = useState<ArtifactKind | 'all'>(initialKind === 'report' || initialKind === 'roi_dashboard' || initialKind === 'document' ? initialKind : 'all')
  const [roiOpen, setRoiOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const { can } = useAuth()
  // Building an ROI analysis is an operator action (warehouse extracts about
  // a customer): internal edition, and only for people who can run agents.
  const canBuildRoi = !isCustomerEdition() && can('agent.run')
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
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">What your agents have produced</h1>
          <div className="flex flex-wrap gap-2">
            {can('agent.write') && <Button variant="outline" onClick={() => setUploadOpen(true)}><Upload className="mr-1.5 h-4 w-4" aria-hidden />Upload HTML</Button>}
            {canBuildRoi && <Button onClick={() => setRoiOpen(true)}><TrendingUp className="mr-1.5 h-4 w-4" aria-hidden />New ROI analysis</Button>}
          </div>
        </div>
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
                    <span>{item.versionCount ? `${item.versionCount} version${item.versionCount === 1 ? '' : 's'}` : 'Building…'}</span>
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
      <UploadHtmlDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <Dialog open={roiOpen} onOpenChange={setRoiOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>New ROI analysis</DialogTitle>
            <DialogDescription>Pick the account and the time frame. The dashboard is built in the background from the account's extracts and opens here as an artifact you can question and change.</DialogDescription>
          </DialogHeader>
          <RoiForm onStarted={() => setRoiOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

type AgentOption = { id: string; title: string }

/**
 * Upload an HTML page as an artifact and pick the agent that works on it.
 * Version 1 is the file as uploaded; asking the agent for changes makes new
 * versions (or new artifacts, when asked for a copy).
 */
function UploadHtmlDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [agentId, setAgentId] = useState('')
  const [agents, setAgents] = useState<AgentOption[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || agents) return
    fetch('/api/agents', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { agents?: Array<{ id: string; title?: string; description?: string }> }) => {
        const list = (data.agents ?? []).map((agent) => ({ id: agent.id, title: agent.title || agent.description?.split('\n')[0] || 'Untitled agent' }))
        setAgents(list)
        if (list.length && !agentId) setAgentId(list[0].id)
      })
      .catch(() => setAgents([]))
  }, [open, agents, agentId])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file || !agentId || busy) return
    if (file.size > 2_000_000) { toast.error('Pages can be at most 2 MB.'); return }
    setBusy(true)
    try {
      const content = await file.text()
      const response = await fetch('/api/artifacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, filename: file.name, agentId, ...(title.trim() ? { title: title.trim() } : {}) }),
      })
      const data = await response.json().catch(() => ({})) as { artifactId?: string; unsupportedScripts?: string[]; error?: string }
      if (!response.ok || !data.artifactId) throw new Error(data.error || 'The page could not be uploaded.')
      if (data.unsupportedScripts?.length) {
        toast.warning(`Uploaded. ${data.unsupportedScripts.length} external script${data.unsupportedScripts.length === 1 ? '' : 's'} can't load in the sandbox: ${data.unsupportedScripts.join(', ')}`)
      } else {
        toast.success('Uploaded — ask the agent for changes from the artifact page.')
      }
      onOpenChange(false)
      setFile(null)
      setTitle('')
      router.push(`/artifacts/${data.artifactId}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload an HTML page</DialogTitle>
          <DialogDescription>It becomes an artifact the agent you pick can work on. Every change is a new version; ask for a copy and it makes a new artifact.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="upload-html-file" className="text-sm font-medium">Page</label>
            <input id="upload-html-file" type="file" accept=".html,.htm,text/html" className="mt-1.5 block w-full text-sm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            <p className="mt-1 text-xs text-muted-foreground">Up to 2 MB. Charts from Chart.js or Plotly keep working; the page can't reach the internet.</p>
          </div>
          <div>
            <label htmlFor="upload-html-agent" className="text-sm font-medium">Agent</label>
            <select id="upload-html-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} disabled={!agents} className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {agents === null && <option value="">Loading agents…</option>}
              {agents?.length === 0 && <option value="">No agents yet — create one first</option>}
              {agents?.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">It edits the page with its own tools, MCPs and integrations.</p>
          </div>
          <div>
            <label htmlFor="upload-html-title" className="text-sm font-medium">Title <span className="font-normal text-muted-foreground">(optional)</span></label>
            <Input id="upload-html-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Taken from the page when left empty" className="mt-1.5" maxLength={200} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!file || !agentId || busy}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Upload className="mr-1.5 h-4 w-4" aria-hidden />}Upload</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
