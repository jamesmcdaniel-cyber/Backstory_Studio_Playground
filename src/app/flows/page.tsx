'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { Workflow, Plus, ChevronDown, FileText, Layers, Upload } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { FlowGraph } from '@/lib/flows/graph'
import { Pagination, paginate } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Cards per page on the Flows grid. */
const PAGE_SIZE = 9

/**
 * Templates offered on this page — in the "Start from a template" row and the
 * New-flow menu. The rest live in the gallery.
 */
const MENU_TEMPLATE_LIMIT = 6

type FlowTemplateOption = {
  id: string
  name: string
  description: string
  icon?: string
  stepCount: number
  setupCount: number
}

type FlowItem = {
  id: string
  name: string
  description: string
  status: string
  /** True once the flow has a published graph — what actually arms triggers. */
  published?: boolean
  stepCount: number
  folder?: string
  updatedAt: string
}

const STATUS_STYLE: Record<string, string> = {
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  draft: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  disabled: 'border-border bg-muted text-muted-foreground',
}

export default function FlowsPage() {
  const router = useRouter()
  const [flows, setFlows] = useState<FlowItem[]>([])
  const [flowTemplates, setFlowTemplates] = useState<FlowTemplateOption[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  // Which template card is mid-instantiate, so only that card spins.
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null)
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const importInput = useRef<HTMLInputElement>(null)

  const folders = Array.from(new Set(flows.map((flow) => flow.folder?.trim() || ''))).filter(Boolean).sort()
  const visibleFlows = folderFilter === null ? flows : flows.filter((flow) => (flow.folder?.trim() || '') === folderFilter)

  const moveToFolder = async (flow: FlowItem) => {
    const next = window.prompt(`Folder for "${flow.name}" (leave empty for none):`, flow.folder ?? '')
    if (next === null) return
    const folder = next.trim().slice(0, 60)
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
    // The template menu reads the live catalogue, so a template the workspace
    // saved or was recommended shows up here too — not just the built-ins.
    fetch(`/api/flow-templates?limit=${MENU_TEMPLATE_LIMIT}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !data.success) return
        setFlowTemplates(
          (data.templates || []).map((entry: Record<string, any>): FlowTemplateOption => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            icon: entry.icon || '',
            stepCount: entry.stepCount ?? 0,
            setupCount: (entry.bindings?.length ?? 0) + (entry.notes?.setup?.length ?? 0),
          })),
        )
      })
      .catch(() => undefined)
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

  // Templates go through the instantiate endpoint rather than a plain POST, so
  // bindings resolve against this workspace and the unfilled ones come back as
  // a setup list instead of silently landing as empty steps.
  const createFromTemplate = async (template: FlowTemplateOption) => {
    setCreating(true)
    setPendingTemplateId(template.id)
    try {
      const response = await fetch(`/api/flow-templates/${template.id}/use`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.flow) {
        toast.error(data.error || 'Could not create the flow.')
        return
      }
      const outstanding = Array.isArray(data.setup) ? data.setup.length : 0
      toast.success(
        outstanding > 0
          ? `Created as a draft — ${outstanding} thing${outstanding === 1 ? '' : 's'} left to set up.`
          : 'Created as a draft, ready to run.',
      )
      router.push(`/flows/${data.flow.id}`)
    } finally {
      setCreating(false)
      setPendingTemplateId(null)
    }
  }
  const importFlow = async (file: File) => {
    if (file.size > 5_000_000) return toast.error('Flow packages must be under 5 MB.')
    try {
      const payload = JSON.parse(await file.text())
      const response = await fetch('/api/flows/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.flow?.id) return toast.error(data.error || 'That is not a valid Backstory flow package.')
      toast.success('Flow imported as a draft.')
      router.push(`/flows/${data.flow.id}`)
    } catch { toast.error('Could not read that JSON file.') }
  }
  const newFlowButton = (
    <div className="flex">
      <Button onClick={() => createFlow()} loading={creating} className="rounded-r-none">
        <Plus className="mr-1.5 h-4 w-4" /> New flow
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="default" className="rounded-l-none border-l border-white/20 px-2" aria-label="Start from a template" disabled={creating}>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={() => createFlow()}>
            <Plus className="h-4 w-4" /> Blank flow
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Start from a template</DropdownMenuLabel>
          {flowTemplates.map((template) => (
            <DropdownMenuItem key={template.id} onSelect={() => createFromTemplate(template)} className="flex-col items-start gap-0.5">
              <span className="flex items-center gap-1.5 font-medium"><FileText className="h-3.5 w-3.5" /> {template.name}</span>
              <span className="pl-5 text-xs text-muted-foreground">{template.description}</span>
              <span className="pl-5 text-[11px] text-muted-foreground/80">
                {template.stepCount} steps · {template.setupCount === 0 ? 'ready to run' : `${template.setupCount} to set up`}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/agents?view=templates">Browse all flow templates…</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  const { pageItems, pageCount, page: current } = paginate(visibleFlows, page, PAGE_SIZE)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader eyebrow="Pipelines" title="Flows" description="Wire your agents into deterministic multi-step pipelines." />
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => importInput.current?.click()}><Upload className="mr-1.5 h-4 w-4" /> Import JSON</Button>
          <input ref={importInput} className="hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFlow(file) }} />
          {newFlowButton}
        </div>
      </div>

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
          <div className="stagger-children grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {pageItems.map((flow) => (
              <Link key={flow.id} href={`/flows/${flow.id}`} className="block">
                <Card className="group relative h-full overflow-hidden border-border/60 transition-[transform,box-shadow,border-color] duration-300 ease-out-quart hover:-translate-y-1 hover:shadow-4 hover:ring-1 hover:ring-indigo-300/70 dark:hover:ring-indigo-500/40">
                  <div className="absolute inset-x-0 top-0 z-10 h-1 bg-gradient-to-r from-indigo-500 to-blue-400 opacity-80 transition-opacity group-hover:opacity-100" />
                  <CardHeader className="space-y-2.5 pt-5">
                    <div className="flex items-center justify-between">
                      {/* Published is the state that matters — it is what arms
                          triggers and what a run executes. A flow can be ACTIVE
                          and unpublished (never armed), so show both rather than
                          collapsing them into one word. */}
                      <Badge variant="outline" className={cn('text-[11px] font-medium capitalize', flow.published ? STATUS_STYLE.active : STATUS_STYLE[flow.status] || STATUS_STYLE.draft)}>
                        {flow.published ? 'Published' : flow.status}
                      </Badge>
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
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 transition-transform group-hover:scale-105 dark:bg-indigo-500/15 dark:text-indigo-300">
                        <Workflow className="h-[18px] w-[18px]" />
                      </span>
                      <CardTitle className="min-w-0 text-base leading-snug">{flow.name}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{flow.description || 'No description yet.'}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          <Pagination page={current} pageCount={pageCount} onPageChange={setPage} />
        </>
      )}

      {/* The template catalogue, on the page itself — it used to be reachable
          only from the New-flow dropdown, so nobody found it. The card opens the
          template's detail page; "Use" instantiates it straight into a draft. */}
      {flowTemplates.length > 0 && (
        <section className="space-y-3 border-t border-border/60 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Start from a template</p>
              <p className="text-sm text-muted-foreground">Wired pipelines you can run as they are — picking one creates a draft flow.</p>
            </div>
            <Link href="/agents?view=templates" className="shrink-0 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-300">
              Browse all templates →
            </Link>
          </div>
          <div className="stagger-children grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {flowTemplates.map((template) => (
              <Link key={template.id} href={`/flow-templates/${template.id}`} className="block">
                <Card className="group relative flex h-full flex-col overflow-hidden border-border/60 transition-[transform,box-shadow,border-color] duration-300 ease-out-quart hover:-translate-y-1 hover:shadow-4 hover:ring-1 hover:ring-indigo-300/70 dark:hover:ring-indigo-500/40">
                  <CardHeader className="space-y-2.5 pt-5">
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-base text-indigo-600 transition-transform group-hover:scale-105 dark:bg-indigo-500/15 dark:text-indigo-300">
                        {template.icon ? <span aria-hidden>{template.icon}</span> : <FileText className="h-[18px] w-[18px]" />}
                      </span>
                      <CardTitle className="min-w-0 text-base leading-snug">{template.name}</CardTitle>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Layers className="h-3.5 w-3.5" />
                        {template.stepCount} {template.stepCount === 1 ? 'step' : 'steps'}
                      </span>
                      <span className={cn('font-medium', template.setupCount === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
                        {template.setupCount === 0 ? 'Ready to run' : `${template.setupCount} to set up`}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col justify-between gap-3">
                    <p className="line-clamp-3 text-sm text-muted-foreground">{template.description}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={creating}
                      loading={pendingTemplateId === template.id}
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); void createFromTemplate(template) }}
                    >
                      Use this template
                    </Button>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
