'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Download,
  FileText,
  FolderPlus,
  Github,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { humanizeToolName } from '@/lib/flows/humanize-tool-name'
import { relativeTime } from '@/lib/relative-time'

type AgentOption = { id: string; title: string }

type RepositoryAsset = {
  id: string
  agentId: string | null
  agentName: string | null
  filename: string
  description: string
  mimeType: string
  sizeBytes: number
  charCount: number
  chunkCount: number
  hasOriginal: boolean
  assetType: string
  sourceType: string
  sourceProvider: string | null
  sourceTool: string | null
  isEnabled: boolean
  version: number
  status: string
  error: string | null
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
  downloadUrl: string
}

type PullSource = {
  connectionId: string
  connectionName: string
  toolName: string
  description: string
  inputSchema: unknown
}

type GitHubRepository = {
  id: number
  fullName: string
  owner: string
  name: string
  private: boolean
  defaultBranch: string
  updatedAt: string | null
  htmlUrl: string | null
}

type EditDraft = {
  asset: RepositoryAsset
  filename: string
  description: string
  content: string
}

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function sourceLabel(asset: RepositoryAsset): string {
  if (asset.assetType === 'project') return 'Project'
  if (asset.sourceTool === 'github_repository_sync') return 'GitHub sync'
  if (asset.sourceType === 'integration') {
    return asset.sourceProvider?.replace(/^nango:/, '').replace(/[-_]/g, ' ') || 'Integration pull'
  }
  if (asset.sourceType === 'manual') return 'Created here'
  return 'File upload'
}

function statusVariant(status: string): 'good' | 'warn' | 'risk' | 'secondary' {
  if (status === 'ready') return 'good'
  if (status === 'processing') return 'warn'
  if (status === 'failed') return 'risk'
  return 'secondary'
}

export function ContentRepository({ writable }: { writable: boolean }) {
  const [assets, setAssets] = useState<RepositoryAsset[]>([])
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [stats, setStats] = useState({ total: 0, available: 0, pulls: 0 })
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [availability, setAvailability] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'upload' | 'integration' | 'manual'>('all')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadAgentId, setUploadAgentId] = useState('')
  const [uploadDescription, setUploadDescription] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)
  const [projectOpen, setProjectOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectSummary, setProjectSummary] = useState('')
  const [projectContent, setProjectContent] = useState('')
  const [projectScope, setProjectScope] = useState('')
  const [githubOpen, setGithubOpen] = useState(false)
  const [githubRepositories, setGithubRepositories] = useState<GitHubRepository[]>([])
  const [githubLoading, setGithubLoading] = useState(false)
  const [githubError, setGithubError] = useState('')
  const [githubRepositoryId, setGithubRepositoryId] = useState('')
  const [githubRef, setGithubRef] = useState('')
  const [githubPath, setGithubPath] = useState('')
  const [githubScope, setGithubScope] = useState('')
  const [pullOpen, setPullOpen] = useState(false)
  const [pullSources, setPullSources] = useState<PullSource[]>([])
  const [pullSourcesLoading, setPullSourcesLoading] = useState(false)
  const [pullIndex, setPullIndex] = useState('')
  const [pullArgs, setPullArgs] = useState('{}')
  const [pullFilename, setPullFilename] = useState('')
  const [pullDescription, setPullDescription] = useState('')
  const [pullAgentId, setPullAgentId] = useState('')
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RepositoryAsset | null>(null)
  const requestSequence = useRef(0)

  const loadAssets = useCallback(async (cursor?: string) => {
    const requestId = ++requestSequence.current
    if (cursor) setLoadingMore(true)
    const query = new URLSearchParams({ limit: '100' })
    if (search.trim()) query.set('q', search.trim())
    if (availability !== 'all') query.set('enabled', availability === 'enabled' ? 'true' : 'false')
    if (sourceFilter !== 'all') query.set('sourceType', sourceFilter)
    if (cursor) query.set('cursor', cursor)

    try {
      const response = await fetch(`/api/repository?${query}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not load the repository.')
      if (requestId !== requestSequence.current) return
      const incoming: RepositoryAsset[] = data.assets ?? []
      setAssets((current) => cursor
        ? Array.from(new Map([...current, ...incoming].map((asset) => [asset.id, asset])).values())
        : incoming)
      setAgents(data.agents ?? [])
      setNextCursor(data.nextCursor ?? null)
      if (data.stats) {
        setStats(data.stats)
      } else if (!cursor) {
        // Tolerate a rolling deploy where the UI reaches an older API instance.
        setStats({
          total: incoming.length,
          available: incoming.filter((asset) => asset.isEnabled && asset.status === 'ready').length,
          pulls: incoming.filter((asset) => asset.sourceType === 'integration').length,
        })
      }
    } finally {
      if (requestId === requestSequence.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [availability, search, sourceFilter])

  useEffect(() => {
    // Invalidate an older request as soon as filters change, including during
    // the search debounce, so stale results cannot replace the new catalogue.
    requestSequence.current += 1
    const timeout = window.setTimeout(() => {
      loadAssets().catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
    }, search.trim() ? 250 : 0)
    return () => window.clearTimeout(timeout)
  }, [loadAssets, search])

  const submitUpload = async () => {
    if (!uploadFiles.length) return
    setBusy(true)
    let completed = 0
    try {
      for (const file of uploadFiles) {
        const form = new FormData()
        form.append('file', file)
        if (uploadAgentId) form.append('agentId', uploadAgentId)
        if (uploadDescription.trim()) form.append('description', uploadDescription.trim())
        const response = await fetch('/api/repository', { method: 'POST', body: form })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `Could not upload ${file.name}.`)
        completed += 1
      }
      await loadAssets()
      toast.success(`Added ${completed} file${completed === 1 ? '' : 's'} to the repository.`)
      setUploadOpen(false)
      setUploadFiles([])
      setUploadDescription('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      if (completed) await loadAssets()
    } finally {
      setBusy(false)
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  const submitProject = async () => {
    if (!projectName.trim() || !projectContent.trim() || !projectScope) return
    setBusy(true)
    try {
      const response = await fetch('/api/repository/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: projectName.trim(),
          summary: projectSummary.trim(),
          content: projectContent.trim(),
          workspaceScope: projectScope === 'workspace',
          ...(projectScope !== 'workspace' ? { agentId: projectScope } : {}),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save the project.')
      await loadAssets()
      toast.success('Project saved and indexed for reference.')
      setProjectOpen(false)
      setProjectName('')
      setProjectSummary('')
      setProjectContent('')
      setProjectScope('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const openGitHub = async () => {
    setGithubOpen(true)
    if (githubRepositories.length || githubLoading) return
    setGithubLoading(true)
    setGithubError('')
    try {
      const response = await fetch('/api/repository/github/repositories', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not load GitHub repositories.')
      setGithubRepositories(data.repositories ?? [])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setGithubError(message)
      toast.error(message)
    } finally {
      setGithubLoading(false)
    }
  }

  const selectedGitHubRepository = githubRepositories.find((repository) => String(repository.id) === githubRepositoryId) ?? null

  const submitGitHubSync = async () => {
    if (!selectedGitHubRepository || !githubScope) return
    setBusy(true)
    try {
      const response = await fetch('/api/repository/github/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner: selectedGitHubRepository.owner,
          repo: selectedGitHubRepository.name,
          ref: githubRef.trim() || selectedGitHubRepository.defaultBranch,
          pathPrefix: githubPath.trim(),
          workspaceScope: githubScope === 'workspace',
          ...(githubScope !== 'workspace' ? { agentId: githubScope } : {}),
          maxFiles: 50,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not synchronize the GitHub repository.')
      const result = data.result ?? {}
      const skipped = Object.values(result.skipped ?? {}).reduce((sum: number, value) => sum + Number(value || 0), 0)
      await loadAssets()
      toast.success(`GitHub sync complete: ${result.created ?? 0} added, ${result.updated ?? 0} updated, ${result.unchanged ?? 0} unchanged${skipped ? `, ${skipped} skipped` : ''}${result.failed ? `, ${result.failed} failed` : ''}.`)
      setGithubOpen(false)
      setGithubRepositoryId('')
      setGithubRef('')
      setGithubPath('')
      setGithubScope('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const openPull = async () => {
    setPullOpen(true)
    if (pullSources.length) return
    setPullSourcesLoading(true)
    try {
      const response = await fetch('/api/repository/sources', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not load connected sources.')
      setPullSources(data.sources ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPullSourcesLoading(false)
    }
  }

  const selectedPull = pullIndex === '' ? null : pullSources[Number(pullIndex)] ?? null

  const submitPull = async () => {
    if (!selectedPull) return
    let args: Record<string, unknown>
    try {
      const parsed = JSON.parse(pullArgs || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      args = parsed
    } catch {
      toast.error('Pull arguments must be a JSON object.')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/repository/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connectionId: selectedPull.connectionId,
          toolName: selectedPull.toolName,
          args,
          ...(pullFilename.trim() ? { filename: pullFilename.trim() } : {}),
          ...(pullDescription.trim() ? { description: pullDescription.trim() } : {}),
          ...(pullAgentId ? { agentId: pullAgentId } : {}),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'The integration pull failed.')
      await loadAssets()
      toast.success('Integration pull saved as a repository artifact.')
      setPullOpen(false)
      setPullIndex('')
      setPullArgs('{}')
      setPullFilename('')
      setPullDescription('')
    } catch (error) {
      await loadAssets().catch(() => undefined)
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const openEditor = async (asset: RepositoryAsset) => {
    setEditLoading(true)
    try {
      const response = await fetch(`/api/repository/${asset.id}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not load the file.')
      setEditDraft({
        asset,
        filename: data.asset.filename,
        description: data.asset.description || '',
        content: data.asset.content || '',
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setEditLoading(false)
    }
  }

  const saveEdit = async () => {
    if (!editDraft) return
    setBusy(true)
    try {
      const response = await fetch(`/api/repository/${editDraft.asset.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: editDraft.filename,
          description: editDraft.description,
          content: editDraft.content,
          expectedVersion: editDraft.asset.version,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save the file.')
      await loadAssets()
      setEditDraft(null)
      toast.success('Indexed content updated and re-indexed for agents.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const toggleAsset = async (asset: RepositoryAsset, enabled: boolean) => {
    setAssets((current) => current.map((entry) => entry.id === asset.id ? { ...entry, isEnabled: enabled } : entry))
    try {
      const response = await fetch(`/api/repository/${asset.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isEnabled: enabled, expectedVersion: asset.version }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not change agent availability.')
      await loadAssets()
      toast.success(enabled ? 'Agents can use this file.' : 'File disabled for every agent.')
    } catch (error) {
      await loadAssets().catch(() => undefined)
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  if (loading) {
    return <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Files and content</h2>
          <p className="mt-1 text-sm text-muted-foreground">The reference catalogue shared by people, flows, and agents.</p>
        </div>
        {writable && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setProjectOpen(true)}><FolderPlus className="mr-1.5 h-4 w-4" />New project</Button>
            <Button variant="outline" onClick={() => void openGitHub()}><Github className="mr-1.5 h-4 w-4" />Sync GitHub</Button>
            <Button variant="outline" onClick={() => void openPull()}><Plug className="mr-1.5 h-4 w-4" />Pull from integration</Button>
            <Button onClick={() => setUploadOpen(true)}><Upload className="mr-1.5 h-4 w-4" />Upload files</Button>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Repository</p><p className="mt-1 text-2xl font-semibold">{stats.total}</p><p className="text-xs text-muted-foreground">files, projects, and synced content</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Available to agents</p><p className="mt-1 text-2xl font-semibold">{stats.available}</p><p className="text-xs text-muted-foreground">ready and enabled</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Integration files</p><p className="mt-1 text-2xl font-semibold">{stats.pulls}</p><p className="text-xs text-muted-foreground">synced and pulled content</p></CardContent></Card>
      </div>

      <div className="flex flex-wrap gap-2">
        <label htmlFor="repository-search" className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input id="repository-search" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search files, descriptions, sources, or agents…" />
        </label>
        <select value={availability} onChange={(event) => setAvailability(event.target.value as typeof availability)} className="h-10 rounded-md border bg-background px-3 text-sm" aria-label="Availability filter">
          <option value="all">All availability</option><option value="enabled">Available to agents</option><option value="disabled">Disabled</option>
        </select>
        <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)} className="h-10 rounded-md border bg-background px-3 text-sm" aria-label="Source filter">
          <option value="all">All sources</option><option value="upload">Uploads</option><option value="integration">Integration pulls</option><option value="manual">Created here</option>
        </select>
        <Button variant="ghost" size="icon" aria-label="Refresh repository" onClick={() => void loadAssets()}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {stats.total === 0 ? (
        <EmptyState
          icon={FileText}
          title="No files in the repository yet"
          description="Upload reference files or pull content from a connected source. Enabled content is automatically indexed for agents."
          action={writable ? <div className="flex flex-wrap justify-center gap-2"><Button variant="outline" onClick={() => setProjectOpen(true)}><FolderPlus className="mr-1.5 h-4 w-4" />New project</Button><Button variant="outline" onClick={() => void openGitHub()}><Github className="mr-1.5 h-4 w-4" />Sync GitHub</Button><Button onClick={() => setUploadOpen(true)}><Upload className="mr-1.5 h-4 w-4" />Upload files</Button></div> : undefined}
        />
      ) : assets.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No repository items match these filters.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          <Table>
            <TableHeader><TableRow><TableHead>File</TableHead><TableHead>Source</TableHead><TableHead>Scope</TableHead><TableHead>Updated</TableHead><TableHead>Status</TableHead><TableHead>Agents can use</TableHead><TableHead className="w-12"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {assets.map((asset) => (
                <TableRow key={asset.id}>
                  <TableCell className="max-w-sm"><div className="flex items-start gap-2.5"><span className="mt-0.5 rounded-md bg-horizon-50 p-1.5 text-horizon-700"><FileText className="h-4 w-4" /></span><span className="min-w-0"><span className="block truncate font-medium" title={asset.filename}>{asset.filename}</span><span className="block truncate text-xs text-muted-foreground">{asset.description || `${formatSize(asset.sizeBytes)} · ${asset.chunkCount} passages`}</span></span></div></TableCell>
                  <TableCell className="capitalize"><span className="block text-sm">{sourceLabel(asset)}</span>{asset.sourceTool && <span className="block text-[11px] text-muted-foreground">{humanizeToolName(asset.sourceTool)}</span>}</TableCell>
                  <TableCell>{asset.agentName ? <Badge variant="info">{asset.agentName}</Badge> : <Badge variant="secondary">All agents</Badge>}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(asset.updatedAt)}</TableCell>
                  <TableCell><Badge variant={statusVariant(asset.status)} className="capitalize">{asset.status}</Badge>{asset.error && <p className="mt-1 max-w-48 truncate text-[11px] text-red-600" title={asset.error}>{asset.error}</p>}</TableCell>
                  <TableCell><div className="flex items-center gap-2"><Switch checked={asset.isEnabled} disabled={!writable || asset.status !== 'ready'} onCheckedChange={(checked) => void toggleAsset(asset, checked)} aria-label={`${asset.isEnabled ? 'Disable' : 'Enable'} ${asset.filename} for agents`} /><span className="text-xs text-muted-foreground">{asset.isEnabled ? 'Enabled' : 'Disabled'}</span></div></TableCell>
                  <TableCell>
                    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${asset.filename}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                      {writable && <DropdownMenuItem onSelect={() => void openEditor(asset)}><Pencil className="mr-2 h-4 w-4" />Edit indexed content</DropdownMenuItem>}
                      <DropdownMenuItem asChild><a href={asset.downloadUrl}><Download className="mr-2 h-4 w-4" />{asset.hasOriginal ? 'Download original' : 'Download artifact'}</a></DropdownMenuItem>
                      {writable && <DropdownMenuItem onSelect={() => setDeleteTarget(asset)} className="text-red-600 focus:text-red-600"><Trash2 className="mr-2 h-4 w-4" />Delete</DropdownMenuItem>}
                    </DropdownMenuContent></DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {nextCursor && <div className="flex justify-center"><Button variant="outline" disabled={loadingMore} onClick={() => void loadAssets(nextCursor)}>{loadingMore && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Load more files</Button></div>}
        </div>
      )}

      <Dialog open={uploadOpen} onOpenChange={(open) => { if (!busy) setUploadOpen(open) }}>
        <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>Upload files</DialogTitle><DialogDescription>Originals are scanned and retained. Readable text is extracted and indexed for the selected agent scope.</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-dashed p-5 text-center"><Upload className="mx-auto h-6 w-6 text-muted-foreground" /><p className="mt-2 text-sm font-medium">PDF, DOCX, text, Markdown, CSV, JSON, HTML, and source files</p><p className="mt-1 text-xs text-muted-foreground">Up to 10 MB per file</p><input ref={uploadRef} type="file" multiple className="mt-3 block w-full text-sm" accept=".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.log,.pdf,.docx,text/*,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setUploadFiles(Array.from(event.target.files ?? []))} /></div>
            <div className="space-y-1.5"><Label>Agent scope</Label><select value={uploadAgentId} onChange={(event) => setUploadAgentId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">All agents in this workspace</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}</select><p className="text-xs text-muted-foreground">Agent-specific files are only retrieved by that agent.</p></div>
            <div className="space-y-1.5"><Label>Description</Label><Input value={uploadDescription} onChange={(event) => setUploadDescription(event.target.value)} placeholder="What this content is for (optional)" /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setUploadOpen(false)} disabled={busy}>Cancel</Button><Button onClick={() => void submitUpload()} disabled={busy || !uploadFiles.length}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Upload {uploadFiles.length || ''}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={projectOpen} onOpenChange={(open) => { if (!busy) setProjectOpen(open) }}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Save a project</DialogTitle><DialogDescription>Create an editable Markdown project reference. It is indexed immediately and follows the agent scope you choose.</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><Label>Project name</Label><Input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Customer onboarding redesign" /></div>
            <div className="space-y-1.5"><Label>Summary</Label><Input aria-label="Project summary" value={projectSummary} onChange={(event) => setProjectSummary(event.target.value)} placeholder="Purpose, owner, and current status (optional)" /></div>
            <div className="space-y-1.5"><Label>Project reference</Label><Textarea aria-label="Project reference" value={projectContent} onChange={(event) => setProjectContent(event.target.value)} rows={12} placeholder={'Goals\n- …\n\nDecisions\n- …\n\nNext steps\n- …'} /><p className="text-xs text-muted-foreground">You can edit and re-index this project later from the repository table.</p></div>
            <div className="space-y-1.5"><Label>Reference scope</Label><select aria-label="Project reference scope" value={projectScope} onChange={(event) => setProjectScope(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Choose who can reference this project…</option><option value="workspace">All agents in this workspace</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title} only</option>)}</select><p className="text-xs text-muted-foreground">A scope is required so project context is never shared implicitly.</p></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setProjectOpen(false)} disabled={busy}>Cancel</Button><Button onClick={() => void submitProject()} disabled={busy || !projectName.trim() || !projectContent.trim() || !projectScope}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save project</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={githubOpen} onOpenChange={(open) => { if (!busy) setGithubOpen(open) }}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Sync a GitHub repository</DialogTitle><DialogDescription>Index readable project files through your connected GitHub account. The sync is read-only and GitHub credentials remain with the connection provider.</DialogDescription></DialogHeader>
          {githubLoading ? <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : githubError ? <EmptyState icon={Github} title="GitHub is not ready" description={githubError} /> : githubRepositories.length === 0 ? <EmptyState icon={Github} title="No repositories available" description="The connected GitHub account did not return any repositories." /> : <div className="space-y-4">
            <div className="space-y-1.5"><Label>Repository</Label><select aria-label="GitHub repository" value={githubRepositoryId} onChange={(event) => { const id = event.target.value; setGithubRepositoryId(id); const repository = githubRepositories.find((entry) => String(entry.id) === id); setGithubRef(repository?.defaultBranch ?? '') }} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Choose a repository…</option>{githubRepositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}{repository.private ? ' (private)' : ''}</option>)}</select></div>
            {selectedGitHubRepository && <>
              <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Branch or ref</Label><Input aria-label="GitHub branch or ref" value={githubRef} onChange={(event) => setGithubRef(event.target.value)} placeholder={selectedGitHubRepository.defaultBranch} /></div><div className="space-y-1.5"><Label>Directory</Label><Input aria-label="GitHub directory" value={githubPath} onChange={(event) => setGithubPath(event.target.value)} placeholder="Entire repository" /></div></div>
              <div className="space-y-1.5"><Label>Reference scope</Label><select aria-label="GitHub reference scope" value={githubScope} onChange={(event) => setGithubScope(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Choose who can reference these files…</option><option value="workspace">All agents in this workspace</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title} only</option>)}</select><p className="text-xs text-muted-foreground">A scope is required. Workspace scope makes content visible to every agent and repository reader in this workspace.</p></div>
              {selectedGitHubRepository.private && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">This is a private repository. Its indexed text will be visible to the scope selected above.</div>}
              <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">Each sync indexes up to 50 readable files (5 MB total). Secret-bearing paths/content, binaries, generated dependencies, lockfiles, and files over 200 KB are skipped. Removed or newly unsafe files are disabled for agents.</div>
            </>}
          </div>}
          <DialogFooter><Button variant="outline" onClick={() => setGithubOpen(false)} disabled={busy}>Cancel</Button><Button onClick={() => void submitGitHubSync()} disabled={busy || !selectedGitHubRepository || !githubScope || !githubRef.trim()}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Sync repository</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pullOpen} onOpenChange={(open) => { if (!busy) setPullOpen(open) }}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Pull from an integration</DialogTitle><DialogDescription>Run a read-only action on a connected source and store its result as a dated, editable repository artifact.</DialogDescription></DialogHeader>
          {pullSourcesLoading ? <div className="flex min-h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : pullSources.length === 0 ? <EmptyState icon={Plug} title="No readable sources available" description="Connect a supported source in Integrations, then return here to pull content." /> : <div className="space-y-4">
            <div className="space-y-1.5"><Label>Source and read action</Label><select value={pullIndex} onChange={(event) => { setPullIndex(event.target.value); setPullArgs('{}') }} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Choose a connected source…</option>{pullSources.map((source, index) => <option key={`${source.connectionId}-${source.toolName}`} value={index}>{source.connectionName} — {humanizeToolName(source.toolName)}</option>)}</select>{selectedPull && <p className="text-xs text-muted-foreground">{selectedPull.description}</p>}</div>
            {selectedPull && <><div className="space-y-1.5"><Label>Arguments (JSON)</Label><Textarea value={pullArgs} onChange={(event) => setPullArgs(event.target.value)} rows={7} className="font-mono text-xs" /><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">View expected input schema</summary><pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-3">{JSON.stringify(selectedPull.inputSchema ?? {}, null, 2)}</pre></details></div>
            <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Artifact name</Label><Input value={pullFilename} onChange={(event) => setPullFilename(event.target.value)} placeholder="Generated from source and date" /></div><div className="space-y-1.5"><Label>Agent scope</Label><select value={pullAgentId} onChange={(event) => setPullAgentId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}</select></div></div>
            <div className="space-y-1.5"><Label>Description</Label><Input value={pullDescription} onChange={(event) => setPullDescription(event.target.value)} placeholder="Why this snapshot belongs in the repository" /></div></>}
          </div>}
          <DialogFooter><Button variant="outline" onClick={() => setPullOpen(false)} disabled={busy}>Cancel</Button><Button onClick={() => void submitPull()} disabled={busy || !selectedPull}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Pull and store</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editDraft) || editLoading} onOpenChange={(open) => { if (!open && !busy) setEditDraft(null) }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>Edit repository file</DialogTitle><DialogDescription>Edit the indexed representation agents retrieve. A retained original upload is never overwritten.</DialogDescription></DialogHeader>
          {editLoading || !editDraft ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>File name</Label><Input value={editDraft.filename} onChange={(event) => setEditDraft({ ...editDraft, filename: event.target.value })} /></div><div className="space-y-1.5"><Label>Description</Label><Input value={editDraft.description} onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })} /></div></div><div className="space-y-1.5"><Label>Indexed text</Label><Textarea value={editDraft.content} onChange={(event) => setEditDraft({ ...editDraft, content: event.target.value })} rows={18} className="font-mono text-xs leading-5" /><p className="text-xs text-muted-foreground">Saving creates version {editDraft.asset.version + 1} and replaces the searchable chunks and embeddings.</p></div></div>}
          <DialogFooter><Button variant="outline" onClick={() => setEditDraft(null)} disabled={busy}>Cancel</Button><Button onClick={() => void saveEdit()} disabled={busy || !editDraft?.filename.trim() || !editDraft?.content.trim()}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save and re-index</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }} title="Delete repository file?" description="This permanently deletes the indexed content and retained original. Agents stop using it immediately." confirmLabel="Delete file" destructive requireText={deleteTarget?.filename} busy={busy} onConfirm={async () => { if (!deleteTarget) return; setBusy(true); try { const response = await fetch(`/api/repository/${deleteTarget.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: deleteTarget.filename }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not delete the file.'); setDeleteTarget(null); await loadAssets(); toast.success('Repository file deleted.') } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }} />
    </div>
  )
}
