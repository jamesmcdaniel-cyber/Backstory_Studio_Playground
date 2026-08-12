'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { Workflow, Plus, Upload, MoreHorizontal, Copy, Download, Trash2, Rocket, CircleOff, Pencil, Search, KeyRound, ScrollText } from 'lucide-react'
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useFlowImport } from '@/components/flows/use-flow-import'
import { FlowIconInput } from '@/components/flows/flow-icon-input'
import { FlowTemplateGallery } from '@/components/flows/flow-template-gallery'
import { FlowExecutionLog } from '@/components/flows/execution-log'
import type { FlowGraph } from '@/lib/flows/graph'
import { Pagination, paginate } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { StaggerItem, StaggerReveal, TiltCard } from '@/components/ui/motion-primitives'
import { cn } from '@/lib/utils'
import { cardAccent } from '@/lib/flows/card-accent'

/** Cards per page on the Flows grid. */
const PAGE_SIZE = 9

type FlowItem = {
  id: string
  name: string
  description: string
  /** Emoji card icon ('' = the generic Workflow glyph). */
  icon?: string
  status: string
  /** True once the flow has a published graph — what actually arms triggers. */
  published?: boolean
  stepCount: number
  folder?: string
  updatedAt: string
}

// Status → the tokenized Badge variants, same vocabulary as every other status
// chip instead of a page-local emerald/amber recipe.
const STATUS_VARIANT: Record<string, 'good' | 'warn' | 'secondary'> = {
  active: 'good',
  draft: 'warn',
  disabled: 'secondary',
}

export default function FlowsPage() {
  const router = useRouter()
  const [flows, setFlows] = useState<FlowItem[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // Run history is a sibling view, not a slab under the grid — it used to push
  // the template gallery below the fold on any workspace with real run volume.
  const [view, setView] = useState<'flows' | 'log'>('flows')
  const flowImport = useFlowImport()

  const folders = Array.from(new Set(flows.map((flow) => flow.folder?.trim() || ''))).filter(Boolean).sort()
  const query = search.trim().toLowerCase()
  const visibleFlows = flows.filter(
    (flow) =>
      (folderFilter === null || (flow.folder?.trim() || '') === folderFilter) &&
      (!query || flow.name.toLowerCase().includes(query) || (flow.description || '').toLowerCase().includes(query)),
  )

  // Folder move + delete run through real dialogs, not window.prompt/confirm —
  // the only two browser-chrome interruptions left in the app.
  const [folderDialog, setFolderDialog] = useState<{ flow: FlowItem; value: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FlowItem | null>(null)
  const [mutating, setMutating] = useState(false)

  // Edit name/description/icon straight from the card — no editor round-trip.
  const [editDialog, setEditDialog] = useState<{ flow: FlowItem; name: string; description: string; icon: string } | null>(null)

  const editDetails = (flow: FlowItem) =>
    setEditDialog({ flow, name: flow.name, description: flow.description || '', icon: flow.icon ?? '' })

  const commitDetails = async () => {
    if (!editDialog || mutating) return
    const name = editDialog.name.trim()
    if (!name) {
      toast.error('Flow name is required.')
      return
    }
    setMutating(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editDialog.flow.id, name, description: editDialog.description, icon: editDialog.icon }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not save the flow details.')
        return
      }
      setFlows((prev) =>
        prev.map((entry) =>
          entry.id === editDialog.flow.id ? { ...entry, name, description: editDialog.description, icon: editDialog.icon } : entry,
        ),
      )
      toast.success('Flow details saved.')
      setEditDialog(null)
    } finally {
      setMutating(false)
    }
  }

  const moveToFolder = (flow: FlowItem) => setFolderDialog({ flow, value: flow.folder?.trim() ?? '' })

  const commitFolder = async () => {
    if (!folderDialog || mutating) return
    const { flow } = folderDialog
    const folder = folderDialog.value.trim().slice(0, 60)
    setMutating(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: flow.id, folder }),
      })
      if (!response.ok) {
        toast.error('Could not move the flow.')
        return
      }
      setFlows((prev) => prev.map((entry) => (entry.id === flow.id ? { ...entry, folder } : entry)))
      toast.success(folder ? `Moved to "${folder}".` : 'Removed from its folder.')
      setFolderDialog(null)
    } finally {
      setMutating(false)
    }
  }

  // Card-menu actions. Duplicate round-trips through the single-flow endpoint
  // because the list payload's graph may be stale relative to a jam autosave.
  const duplicateFlow = async (flow: FlowItem) => {
    const detail = await fetch(`/api/flows/${flow.id}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    if (!detail?.success) {
      toast.error('Could not load the flow to duplicate.')
      return
    }
    const source = detail.flow
    const response = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${source.name} (copy)`,
        description: source.description || '',
        icon: source.icon || undefined,
        graph: source.graph,
        trigger: source.trigger,
        folder: source.folder || undefined,
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.flow) {
      toast.error(data.error || 'Could not duplicate the flow.')
      return
    }
    setFlows((prev) => [data.flow, ...prev])
    toast.success(`Duplicated as "${data.flow.name}".`)
  }

  const downloadFlow = (flow: FlowItem) => {
    // The export route sets content-disposition, so a plain navigation downloads.
    const anchor = document.createElement('a')
    anchor.href = `/api/flows/${flow.id}/export`
    anchor.download = ''
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  // Publish/unpublish from the card menu hits the same endpoint as the editor's
  // Publish button, so server-side validation (missing agents, revoked
  // connections) surfaces here too — its message is the toast.
  const togglePublish = async (flow: FlowItem) => {
    const unpublish = Boolean(flow.published)
    const response = await fetch(`/api/flows/${flow.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unpublish }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.flow) {
      toast.error(data.error || (unpublish ? 'Could not unpublish the flow.' : 'Could not publish the flow.'))
      return
    }
    setFlows((prev) => prev.map((entry) => (
      entry.id === flow.id
        ? { ...entry, published: Boolean(data.flow.published), status: data.flow.status || entry.status }
        : entry
    )))
    toast.success(unpublish ? 'Unpublished — the flow will no longer run.' : `Published v${data.flow.version}.`)
  }

  const deleteFlow = (flow: FlowItem) => setDeleteTarget(flow)

  const confirmDelete = async () => {
    if (!deleteTarget || mutating) return
    setMutating(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not delete the flow.')
        return
      }
      setFlows((prev) => prev.filter((entry) => entry.id !== deleteTarget.id))
      toast.success('Flow deleted.')
      setDeleteTarget(null)
    } finally {
      setMutating(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetch('/api/flows', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setFlows(data.success ? data.flows : [])
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const createFlow = async (template?: { name: string; graph: FlowGraph }) => {
    setCreating(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(template ? { name: template.name, graph: template.graph } : { name: 'Untitled flow' }),
      })
      const data = await response.json()
      if (response.ok && data.flow) router.push(`/flows/${data.flow.id}`)
      else toast.error(data.error || 'Could not create the flow.')
    } finally {
      setCreating(false)
    }
  }

  // New flow goes straight to a blank draft — templates live in the
  // full "Start from a template" gallery below, not behind this button.
  const newFlowButton = (
    <Button onClick={() => createFlow()} loading={creating}>
      <Plus className="mr-1.5 h-4 w-4" /> New flow
    </Button>
  )

  const { pageItems, pageCount, page: current } = paginate(visibleFlows, page, PAGE_SIZE)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader eyebrow="Pipelines" title="Flows" description="Wire your agents into deterministic multi-step pipelines." />
        <div className="flex items-center gap-2">
          <Button
            variant={view === 'log' ? 'default' : 'outline'}
            aria-pressed={view === 'log'}
            onClick={() => setView((current) => (current === 'log' ? 'flows' : 'log'))}
          >
            <ScrollText className="mr-1.5 h-4 w-4" /> Execution log
          </Button>
          {/* The credentials bank grew into its own page — connect once there,
              every flow reuses it; expired or leaked credentials rotate there too. */}
          <Button asChild variant="outline">
            <Link href="/credentials"><KeyRound className="mr-1.5 h-4 w-4" /> Credentials</Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline"><Upload className="mr-1.5 h-4 w-4" /> Import</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => flowImport.pickFile()}>From a JSON file</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void flowImport.importFromUrl()}>From a URL</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {flowImport.fileInput}
          {newFlowButton}
        </div>
      </div>

      {view === 'log' ? (
        <FlowExecutionLog />
      ) : (
      <>
      {loading ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No flows yet"
          description="Build your first agent pipeline — chain agents, branch on results, and fan out over accounts."
          action={newFlowButton}
        />
      ) : (
        <>
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1) }}
              placeholder="Search flows…"
              className="pl-9"
              aria-label="Search flows by name or description"
            />
          </div>
          {folders.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => { setFolderFilter(null); setPage(1) }}
                className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', folderFilter === null ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300' : 'border-border text-muted-foreground hover:bg-muted')}
              >
                All flows
              </button>
              {folders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  onClick={() => { setFolderFilter(folder); setPage(1) }}
                  className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', folderFilter === folder ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300' : 'border-border text-muted-foreground hover:bg-muted')}
                >
                  {folder}
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setFolderFilter(''); setPage(1) }}
                className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', folderFilter === '' ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300' : 'border-border text-muted-foreground hover:bg-muted')}
              >
                No folder
              </button>
            </div>
          )}
          {visibleFlows.length === 0 && query ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No flows match “{search.trim()}”.</p>
          ) : (
          <>
          {/* StaggerReveal over the CSS ladder: viewport-triggered, spring-eased,
              reduced-motion aware, and not capped at 12 children. */}
          <StaggerReveal className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {pageItems.map((flow) => {
              const accent = cardAccent(flow.id)
              return (
              <StaggerItem key={flow.id}>
              <Link href={`/flows/${flow.id}`} className="block h-full">
                <TiltCard className={cn('group h-full overflow-hidden border-border/60 transition-[box-shadow,border-color]', accent.border)}>
                  <div className={cn('absolute inset-x-0 top-0 z-10 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
                  <div aria-hidden="true" className={cn('pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-60 blur-2xl transition-opacity duration-base group-hover:opacity-100', accent.glow)} />
                  <CardHeader className="space-y-2.5 pt-5">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
                              className="flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              title="Flow actions"
                              aria-label={`Actions for ${flow.name}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          {/* The whole card is an <a>. Radix portals the menu to <body>,
                              but React synthetic clicks still bubble through the REACT tree
                              into the Link — which navigated mid-dialog-open and left the
                              modal's pointer-events lock stuck on <body>. Stop them here. */}
                          <DropdownMenuContent
                            align="start"
                            onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
                          >
                            <DropdownMenuItem onSelect={() => editDetails(flow)}>
                              <Pencil className="mr-2 h-4 w-4" /> Edit details
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void togglePublish(flow)}>
                              {flow.published
                                ? <><CircleOff className="mr-2 h-4 w-4" /> Unpublish</>
                                : <><Rocket className="mr-2 h-4 w-4" /> Publish</>}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void duplicateFlow(flow)}>
                              <Copy className="mr-2 h-4 w-4" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => downloadFlow(flow)}>
                              <Download className="mr-2 h-4 w-4" /> Download JSON
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => void deleteFlow(flow)}
                              className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {/* Published is the state that matters — it is what arms
                            triggers and what a run executes. A flow can be ACTIVE
                            and unpublished (never armed), so show both rather than
                            collapsing them into one word. */}
                        <Badge variant={flow.published ? 'good' : STATUS_VARIANT[flow.status] || 'warn'} className="text-[11px] font-medium capitalize">
                          {flow.published ? 'Published' : flow.status}
                        </Badge>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {flow.stepCount} step{flow.stepCount === 1 ? '' : 's'}
                        <button
                          type="button"
                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); void moveToFolder(flow) }}
                          className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                          title="Move to a folder"
                        >
                          {flow.folder?.trim() || 'Folder…'}
                        </button>
                      </span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg transition-transform group-hover:scale-105', accent.chip)}>
                        {flow.icon ? <span aria-hidden>{flow.icon}</span> : <Workflow className="h-[18px] w-[18px]" />}
                      </span>
                      <CardTitle className="min-w-0 text-base leading-snug">{flow.name}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{flow.description || 'No description yet.'}</p>
                  </CardContent>
                </TiltCard>
              </Link>
              </StaggerItem>
              )
            })}
          </StaggerReveal>
          <Pagination page={current} pageCount={pageCount} onPageChange={setPage} />
          </>
          )}
        </>
      )}

      {/* The full template catalogue lives on this page — every flow template,
          category-filterable and paged, so nobody has to detour through the
          Agents → Templates library to find one. */}
      <FlowTemplateGallery />
      </>
      )}

      <Dialog open={editDialog !== null} onOpenChange={(open) => { if (!open) setEditDialog(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit flow details</DialogTitle>
            <DialogDescription>The name, description, and icon shown on this flow’s card.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Name</span>
              <Input
                value={editDialog?.name ?? ''}
                onChange={(event) => setEditDialog((current) => (current ? { ...current, name: event.target.value } : current))}
                autoFocus
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Description</span>
              <Textarea
                rows={3}
                value={editDialog?.description ?? ''}
                onChange={(event) => setEditDialog((current) => (current ? { ...current, description: event.target.value } : current))}
                placeholder="What this flow does and when to use it."
              />
            </label>
            <div className="space-y-1.5 text-sm">
              <span className="font-medium">Icon</span>
              <FlowIconInput
                value={editDialog?.icon ?? ''}
                onChange={(icon) => setEditDialog((current) => (current ? { ...current, icon } : current))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialog(null)}>Cancel</Button>
            <Button onClick={() => void commitDetails()} loading={mutating}>Save details</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={folderDialog !== null} onOpenChange={(open) => { if (!open) setFolderDialog(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Move to a folder</DialogTitle>
            <DialogDescription>
              Folders group flows on this page. Leave the name empty to take “{folderDialog?.flow.name}” out of its folder.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={folderDialog?.value ?? ''}
            onChange={(event) => setFolderDialog((current) => (current ? { ...current, value: event.target.value } : current))}
            onKeyDown={(event) => { if (event.key === 'Enter') void commitFolder() }}
            placeholder="Folder name"
            maxLength={60}
            autoFocus
          />
          {folders.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {folders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  onClick={() => setFolderDialog((current) => (current ? { ...current, value: folder } : current))}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {folder}
                </button>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialog(null)}>Cancel</Button>
            <Button onClick={() => void commitFolder()} loading={mutating}>Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this flow?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.name}” and its run history will be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} loading={mutating}>Delete flow</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
