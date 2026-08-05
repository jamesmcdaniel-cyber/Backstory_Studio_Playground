'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Play, Save, Sparkles, Loader2, ListChecks, ShieldCheck, Undo2, Redo2, MoreHorizontal, Copy, Download, Trash2, FlaskConical, History, ScrollText, Users, FileText, BookmarkPlus, Mic, MicOff, Radio } from 'lucide-react'
import { JamDialog } from '@/components/flows/jam-dialog'
import { useSupabase } from '@/components/providers/supabase-provider'
import { useFlowCollab } from '@/lib/flows/use-flow-collab'
import { useFlowRunStream } from '@/components/flows/use-flow-run-stream'
import { shouldPersistGraph, shouldRecordJamAudit } from '@/lib/flows/collab-roles'
import { toContentSpace } from '@/lib/flows/cursor-space'
import { joinErrorMessage } from '@/lib/flows/join-error'
import { describeParticipantView } from '@/lib/flows/cursor-view'
import { applyDragPreview, pruneDragPreview, type DragPreview } from '@/lib/flows/drag-preview'
import { useFlowHuddle } from '@/lib/flows/use-flow-huddle'
import { detectHuddleStart } from '@/lib/flows/huddle-alerts'
import { useHuddleCapture } from '@/lib/flows/use-huddle-capture'
import { CursorLayer } from '@/components/flows/cursor-layer'
import { flowToN8n } from '@/lib/flows/export/to-n8n'
import { flowToInstructions } from '@/lib/flows/export/to-instructions'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { emptyGraph, type FlowGraph, type FlowNode, type OutputField } from '@/lib/flows/graph'
import { insertNodeAfter, appendToBranch, duplicateNode, updateNode, deleteNode, deleteNodes, changeNodeType, addContainerStep, moveNodeAfter, moveContainerStep, pasteNodeAfter, addEdge, removeEdge, setNodePositions, insertNodeFromHandle, insertNodeOnEdge, copySelection, pasteSelectionAt, type StepType } from '@/lib/flows/mutate'
import { layoutGraph, type NodePosition } from '@/lib/flows/layout'
import { stepOrder } from '@/lib/flows/step-order'
import { writeFlowClipboard, readFlowClipboard, writeFlowSelection, readFlowSelection } from '@/lib/flows/clipboard'
import { applyCopilotOps, type CopilotOp } from '@/lib/flows/copilot-ops'
import { buildDataTree } from '@/lib/flows/datatree'
import { normalizeStepAlias, type FlowContext } from '@/features/flows/context'
import { parseFlowInput } from '@/lib/flows/input'
import { httpOutputFields, outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'
import { validateFlowGraph } from '@/lib/flows/validate'
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { defaultStepLabel, stepLabelsOf } from '@/lib/flows/token-text'
import { planSubflowExtraction, replaceRangeWithSubflow } from '@/lib/flows/subflow-extract'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
import { storedRunInput, prefillTextFromRunInput } from '@/lib/flows/reuse-input'
import { FlowCanvas, type FlowInsertSeed } from '@/components/flows/flow-canvas'
import { CanvasRail } from '@/components/flows/canvas-rail'
import { GraphCanvas } from '@/components/flows/canvas/graph-canvas'
import { StepDrawer, type OrgMember, type ToolCatalog } from '@/components/flows/step-drawer'
import { CopilotPanel } from '@/components/flows/copilot-panel'
import { RunPanel, type FlowRunDetail } from '@/components/flows/run-panel'
import { CheckerPanel } from '@/components/flows/checker-panel'
import { SaveAsTemplateDialog } from '@/components/flows/save-as-template-dialog'
import { ResizablePanel } from '@/components/flows/resizable-panel'
import { useCanvasPan } from '@/components/flows/use-canvas-pan'
import { TestPanel } from '@/components/flows/test-panel'
import { VersionsPanel } from '@/components/flows/versions-panel'
import type { StepStatus } from '@/lib/flows/node-presentation'
import { cn } from '@/lib/utils'

type Agent = { id: string; title: string }

/** Ordered main-chain ids from the trigger, for upstream-token help. */
function spineIds(graph: FlowGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const nextId = (node: FlowNode): string | undefined => {
    const edges = graph.edges.filter((e) => e.source === node.id)
    return (node.type === 'condition' ? edges.find((e) => e.branch === 'true') ?? edges[0] : edges[0])?.target
  }
  const ids: string[] = []
  const seen = new Set<string>()
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    ids.push(current.id)
    const next = nextId(current)
    current = next ? byId.get(next) : undefined
  }
  return ids
}

function parentLoop(graph: FlowGraph, nodeId: string | null): { loop: Extract<FlowNode, { type: 'loop' }>; index: number } | null {
  if (!nodeId) return null
  for (const node of graph.nodes) {
    if (node.type !== 'loop') continue
    const index = node.data.body.indexOf(nodeId)
    if (index >= 0) return { loop: node, index }
  }
  return null
}

function parentParallelBranch(graph: FlowGraph, nodeId: string | null): { parallelId: string; branch: string[]; index: number } | null {
  if (!nodeId) return null
  for (const node of graph.nodes) {
    if (node.type !== 'parallel') continue
    for (const branch of node.data.branches) {
      const index = branch.indexOf(nodeId)
      if (index >= 0) return { parallelId: node.id, branch, index }
    }
  }
  return null
}

function parseFlowValue(value: unknown) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function triggerInputFields(graph: FlowGraph) {
  const triggerNode = graph.nodes.find((node): node is Extract<FlowNode, { type: 'trigger' }> => node.type === 'trigger')
  return triggerInputFieldsFromTrigger(triggerNode?.data.trigger)
}

function outputFieldsForNode(node: FlowNode | undefined, toolCatalog: ToolCatalog): OutputField[] | undefined {
  if (!node) return undefined
  if (node.type === 'agent') return node.data.outputFields
  if (node.type === 'ai') {
    if (node.data.aiOp === 'extract') return node.data.outputFields
    if (node.data.aiOp === 'categorize') return [{ name: 'category', type: 'string', description: 'The chosen category.' }]
    if (node.data.aiOp === 'score') {
      return [
        { name: 'score', type: 'number', description: 'The numeric rating.' },
        { name: 'reason', type: 'string', description: 'Why the score was given.' },
      ]
    }
    return undefined
  }
  if (node.type === 'http') return node.data.outputFields?.length ? node.data.outputFields : httpOutputFields()
  if (node.type === 'code') return node.data.outputFields
  if (node.type !== 'tool') return undefined
  if (node.data.outputFields?.length) return node.data.outputFields
  const tool = toolCatalog
    .find((connection) => connection.id === node.data.connectionId)
    ?.tools.find((entry) => entry.name === node.data.toolName)
  const fields = outputFieldsFromJsonSchema(tool?.outputSchema)
  return fields.length ? fields : undefined
}

function previewLoopItems(value: unknown): unknown[] {
  const parsed = parseFlowValue(value)
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const key of ['items', 'records', 'results', 'data']) {
      const candidate = (parsed as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) return candidate
    }
    return []
  }
  if (typeof parsed !== 'string') return []
  const trimmed = parsed.trim()
  if (!trimmed) return []
  const lines = trimmed.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const commaParts = trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  return commaParts.length > 1 ? commaParts : [trimmed]
}

function sampleLoopItem(loop: Extract<FlowNode, { type: 'loop' }>, lastOutputs: Record<string, unknown>, testInput: string): unknown {
  const token = loop.data.over.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1]
  let value: unknown = loop.data.over
  if (token === 'trigger.input') {
    value = testInput
  } else if (token?.startsWith('step.')) {
    const [, nodeId, outputKey, ...rest] = token.split('.')
    if (outputKey === 'output') {
      value = lastOutputs[nodeId]
      for (const part of rest) {
        if (value == null || typeof value !== 'object') {
          value = undefined
          break
        }
        value = (value as Record<string, unknown>)[part]
      }
    }
  }
  return previewLoopItems(value)[0]
}

function clampZoom(value: number): number {
  return Math.min(1.5, Math.max(0.5, value))
}

/** Which builder surface is showing. */
type BuilderView = 'inline' | 'canvas'
const VIEW_STORAGE_KEY = 'flows.builderView'

function filenameSlug(value: string): string {
  return (value || 'flow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'flow'
}

/** Trigger a client-side file download from an in-memory string. */
function downloadBlob(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function FlowBuilder() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [folder, setFolder] = useState('')
  const [showFlowSettings, setShowFlowSettings] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState({ name: '', description: '', folder: '' })
  const [graph, setGraph] = useState<FlowGraph>(emptyGraph())
  const [savingTemplate, setSavingTemplate] = useState(false)
  // Lifecycle status is owned by publish/unpublish (server-side); the client
  // only mirrors it for exports — there is no manual status control.
  const [, setStatus] = useState('draft')
  const [version, setVersion] = useState(1)
  // undefined = not yet loaded: webhook arming copy stays neutral instead of
  // flashing "publish to arm" on already-published flows before the fetch lands.
  const [published, setPublished] = useState<boolean | undefined>(undefined)
  // True when the saved draft differs from the published graph (server-derived).
  // Combined with `dirty` (unsaved local edits) to flip Publish ⇄ Unpublish.
  const [unpublishedChanges, setUnpublishedChanges] = useState(false)
  // Share role: 'view' flows are runnable by the org but editable only by the owner.
  const [canEdit, setCanEdit] = useState(true)
  const [visibility, setVisibility] = useState('shared')
  const [ownerId, setOwnerId] = useState<string | null>(null)
  // Cross-workspace guest? (UI hides run/publish/settings; server enforces.)
  const [external, setExternal] = useState(false)
  const [shareToken, setShareToken] = useState<string | null>(null)
  const [shareAnonymous, setShareAnonymous] = useState(false)
  const [anonymousViews, setAnonymousViews] = useState(0)
  const [shareRole, setShareRole] = useState<'view' | 'edit'>('view')
  const [publishing, setPublishing] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  // Workspace roster for the humanReview "Assign to" select — fetched once per
  // builder session and passed down like agents/toolCatalog.
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  // Set when the flow could not be loaded (transient failure OR gone). While
  // set, the builder shows an explicit error state instead of a blank canvas,
  // and every save path short-circuits so a failed load can never autosave an
  // empty graph over the stored flow. See loadedOkRef.
  // null = no failure. Otherwise the API's code (or 'UNKNOWN' for a transient
  // network failure), so the error state can say WHY a jam link didn't open.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [fixing, setFixing] = useState(false)
  // Copilot is the workflow-building assistant — closed until the user opens
  // it from the top bar; nothing (including Run) may pop it open on its own.
  const [showCopilot, setShowCopilot] = useState(false)
  const [showRuns, setShowRuns] = useState(false)
  const [showChecker, setShowChecker] = useState(false)
  const [showTest, setShowTest] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showJam, setShowJam] = useState(false)
  const [viewingVersion, setViewingVersion] = useState<{ version: number; graph: FlowGraph } | null>(null)
  // Which builder the user is in. Inline is the original vertical chain;
  // Canvas is the free-form DAG editor. Persisted per browser so a user who
  // works on canvas lands there next time.
  const [view, setView] = useState<BuilderView>('inline')
  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY)
    if (saved === 'canvas' || saved === 'inline') setView(saved)
  }, [])
  const changeView = useCallback((next: BuilderView) => {
    setView(next)
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, next) } catch { /* storage unavailable */ }
  }, [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The step whose drawer is OPEN. Inline opens on select; Canvas opens on
  // double-click only, so a single click can select a chip without the drawer
  // covering the graph you are wiring.
  const [openNodeId, setOpenNodeId] = useState<string | null>(null)
  // Canvas focus request — bumping the nonce re-centers the viewport even when
  // the same node is jumped to twice.
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null)
  // Multi-select: a contiguous range of spine steps (shift-click). Empty in the
  // normal single-select flow; drives the bulk-actions bar + bulk delete.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectAnchor = useRef<string | null>(null)
  const [statusByNode, setStatusByNode] = useState<Record<string, StepStatus>>({})
  // Nodes the copilot just touched — pulsed on the canvas, cleared after 2.5s.
  const [highlightIds, setHighlightIds] = useState<string[]>([])
  const highlightTimer = useRef<number | undefined>(undefined)
  const [zoom, setZoomState] = useState(() => {
    if (typeof window === 'undefined') return 1
    const saved = Number(window.localStorage.getItem('flows.canvasZoom'))
    return saved ? clampZoom(saved) : 1
  })
  const setZoom = useCallback((value: number) => {
    const clamped = clampZoom(value)
    setZoomState(clamped)
    if (typeof window !== 'undefined') window.localStorage.setItem('flows.canvasZoom', String(clamped))
  }, [])
  const canvasScrollRef = useRef<HTMLDivElement>(null)
  const canvasPan = useCanvasPan(canvasScrollRef)
  // The zoom-TRANSFORMED content element — cursor math divides its rect by
  // zoom to get content-space coords (see toContentSpace).
  const canvasContentRef = useRef<HTMLDivElement>(null)
  const [testInput, setTestInput] = useState('')
  const [runs, setRuns] = useState<{ id: string; status: string; startedAt?: string }[]>([])
  const [selectedRun, setSelectedRun] = useState<FlowRunDetail | null>(null)
  const [toolCatalog, setToolCatalog] = useState<ToolCatalog>([])
  // Serialized snapshot of the last-saved state, for the unsaved-changes dot.
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Run the user explicitly picked (dropdown or ?run= deep-link). While set,
  // the poll tick refreshes that run's details instead of stealing selection.
  const pinnedRunId = useRef<string | null>(null)
  // Last run + status this session has SEEN, so pollRuns only toasts outcomes
  // it witnessed transition (never a stale terminal run on first poll).
  const watchedRun = useRef<{ id: string; status: string } | null>(null)
  const dirty = savedSnapshot !== '' && JSON.stringify({ name, description, graph }) !== savedSnapshot

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/flows', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(async ([flowsData, agentsData]) => {
        if (cancelled) return
        let flow = (flowsData.flows || []).find((f: { id: string }) => f.id === id)
        // Why the single-flow fetch refused us, when it did — drives the
        // error state's copy (dead share link vs. no access vs. transient).
        let joinFailure: string | null = null
        if (!flow) {
          // Not in our list: a share-link open (token in URL) or a flow we can
          // access but haven't accepted yet — the single-flow endpoint
          // resolves both and performs token acceptance.
          const shareParam = searchParams.get('share')
          const res = await fetch(`/api/flows/${id}${shareParam ? `?share=${encodeURIComponent(shareParam)}` : ''}`, { cache: 'no-store' }).catch(() => null)
          const data = res ? await res.json().catch(() => null) : null
          if (res?.ok && data?.flow) flow = data.flow
          else if (res && !res.ok) joinFailure = typeof data?.code === 'string' ? data.code : 'NOT_FOUND'
        }
        if (cancelled) return
        if (flow) {
          const g = flow.graph && flow.graph.nodes ? flow.graph : emptyGraph()
          loadedGraphRef.current = g
          baseUpdatedAt.current = flow.updatedAt ?? null
          setName(flow.name)
          setDescription(flow.description || '')
          setFolder(flow.folder || '')
          setGraph(g)
          setStatus(flow.status)
          setVersion(flow.version ?? 1)
          setPublished(Boolean(flow.published))
          setUnpublishedChanges(Boolean(flow.unpublishedChanges))
          setCanEdit(flow.canEdit !== false)
          setVisibility(flow.visibility ?? 'shared')
          setOwnerId(flow.ownerId ?? null)
          setExternal(Boolean(flow.external))
          setShareToken(flow.shareToken ?? null)
          setShareRole(flow.shareRole === 'edit' ? 'edit' : 'view')
          setShareAnonymous(Boolean(flow.shareAnonymous))
          setAnonymousViews(Number(flow.anonymousViews ?? 0))
          setSavedSnapshot(JSON.stringify({ name: flow.name, description: flow.description || '', graph: g }))
          // Only now is it safe to persist — every save path checks this flag.
          loadedOkRef.current = true
        } else {
          // Flow not in the list AND the single-flow fetch didn't resolve it:
          // deleted, inaccessible, or a transient failure. Show the error state
          // rather than a blank builder that would autosave over the real flow.
          setLoadError(joinFailure ?? 'NOT_FOUND')
        }
        setAgents(agentsData.success ? agentsData.agents.map((a: Agent) => ({ id: a.id, title: a.title })) : [])
      })
      .catch(() => {
        // Network/parse failure loading the flow — same guard: never render an
        // editable-but-empty canvas that could clobber the stored graph.
        if (!cancelled) setLoadError('UNKNOWN')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    // The tool catalog loads separately — discovery can be slow and must not
    // block the canvas paint.
    fetch('/api/flows/tool-catalog', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.success) setToolCatalog(data.connections)
      })
      .catch(() => undefined)
    // The workspace roster also loads separately — it only feeds the
    // humanReview "Assign to" select.
    fetch('/api/organizations/members', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.success) setMembers(data.members)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id, searchParams])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // Input memory: prefill the test input once from the last successful run so
  // re-running never demands re-typing the same payload. Initialize-once: the
  // fetch fires once per mount, and the functional setter only fills a still-
  // empty box — anything the user already typed is never clobbered.
  const prefilledInput = useRef(false)
  useEffect(() => {
    if (prefilledInput.current) return
    prefilledInput.current = true
    fetch(`/api/flows/${id}/runs?status=succeeded&take=1`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const last = (data?.runs as { input?: unknown }[] | undefined)?.[0]
        if (!last) return
        const text = prefillTextFromRunInput(last.input)
        if (!text) return
        setTestInput((current) => (current.trim() ? current : text))
      })
      .catch(() => undefined)
  }, [id])

  // ?run=<id> deep-link (waiting-run emails/toasts land here): open the runs
  // panel and select that run once — later param changes don't re-trigger.
  const deepLinkedRun = useRef(false)
  useEffect(() => {
    if (deepLinkedRun.current) return
    const runId = searchParams.get('run')
    if (!runId) return
    deepLinkedRun.current = true
    setShowRuns(true)
    fetch(`/api/flows/${id}/runs`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!data?.runs) return
        setRuns(data.runs.map((r: { id: string; status: string; startedAt?: string }) => ({ id: r.id, status: r.status, startedAt: r.startedAt })))
        const found = (data.runs as FlowRunDetail[]).find((r) => r.id === runId)
        if (found) {
          pinnedRunId.current = found.id
          setSelectedRun(found)
        }
      })
      .catch(() => undefined)
  }, [id, searchParams])

  useEffect(() => () => window.clearTimeout(highlightTimer.current), [])

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Undo/redo history over structural graph edits (not per-keystroke field edits).
  const undoStack = useRef<FlowGraph[]>([])
  const redoStack = useRef<FlowGraph[]>([])
  const commitGraph = useCallback(
    (next: FlowGraph) => {
      if (next === graph) return
      undoStack.current.push(graph)
      if (undoStack.current.length > 50) undoStack.current.shift()
      redoStack.current = []
      setGraph(next)
    },
    [graph],
  )
  // Field-level undo: a burst of per-keystroke field edits (drawer/canvas node
  // changes) is checkpointed ONCE at the start of the burst, so ⌘Z rolls back
  // the whole edit rather than nothing. The timer marks the burst; the pre-burst
  // graph (graphRef, updated each render) is what's pushed.
  const fieldEditTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitFieldEdit = useCallback((node: FlowNode) => {
    if (!fieldEditTimer.current) {
      undoStack.current.push(graph)
      if (undoStack.current.length > 50) undoStack.current.shift()
      redoStack.current = []
    }
    if (fieldEditTimer.current) clearTimeout(fieldEditTimer.current)
    fieldEditTimer.current = setTimeout(() => {
      fieldEditTimer.current = null
    }, 600)
    setGraph((g) => updateNode(g, node))
  }, [graph])

  // ── Live collaboration (Jam) ────────────────────────────────────────────────
  // Presence (who's here) + live graph broadcast/receive via Supabase Realtime.
  const { user, signOut } = useSupabase()
  // Null until the flow has actually loaded, which gates the realtime channels.
  // Two reasons, both about joining honestly rather than optimistically:
  //  - `canEdit` defaults to true and is corrected by the load, so joining
  //    earlier announces permissions we don't know we have.
  //  - a share-link guest's access is GRANTED by that load (the token is
  //    redeemed into a collaborator row), so subscribing first means Postgres
  //    refuses the private channel and the builder flashes "live collaboration
  //    unavailable" on a perfectly valid first open.
  const self = useMemo(
    () => (user && !loading && !loadError
      ? { userId: user.id, name: (user.user_metadata?.full_name as string) || user.email || 'Teammate', canEdit }
      : null),
    [user, canEdit, loading, loadError],
  )
  // Refs so the collab hook (stable) can read the latest graph without re-subscribing.
  const graphRef = useRef(graph)
  graphRef.current = graph
  // A graph value applied FROM a remote broadcast — the broadcast effect skips it
  // so a co-editor's change never echoes back.
  const remoteGraphRef = useRef<FlowGraph | null>(null)
  // The graph as first loaded — the broadcast effect skips it so opening a flow
  // never pushes the stale persisted graph over a live editor's unsaved work.
  const loadedGraphRef = useRef<FlowGraph | null>(null)
  // Authoritative "we loaded a real graph" flag for the save/autosave closures
  // (a ref so the debounced timer reads the live value, not a stale capture).
  // Flips true only after a successful load populates state; guards the
  // data-loss path where a failed load would let the persister autosave PUT an
  // empty graph over the stored flow.
  const loadedOkRef = useRef(false)
  // The flow's updatedAt when we last loaded/saved it — sent on save so the
  // server rejects a stale overwrite (optimistic concurrency, FLOW_STALE_WRITE).
  const baseUpdatedAt = useRef<string | null>(null)
  const applyRemoteGraph = useCallback((incoming: unknown) => {
    // Don't disrupt a read-only version view; ignore malformed payloads.
    if (viewingVersion || !incoming || typeof incoming !== 'object' || !(incoming as FlowGraph).nodes) return
    const next = incoming as FlowGraph
    remoteGraphRef.current = next
    setGraph(next)
    setSelectedId((current) => (current && !next.nodes.some((n) => n.id === current) ? null : current))
  }, [viewingVersion])
  const { participants, roster, cursors, status: jamStatus, broadcastGraph, sendCursor, setSelection, setInHuddle, setCapture, setView: publishView, bus, selfClientId } =
    // Return null until our own load succeeded — otherwise a failed-load client
    // (graph = emptyGraph) would answer a newcomer's realtime bootstrap with an
    // empty graph, which the newcomer adopts and its persister autosaves over
    // the real flow. The hook skips broadcasting when this yields a non-graph.
    useFlowCollab(id, self, applyRemoteGraph, () => (loadedOkRef.current ? graphRef.current : null))
  // Everyone here except me — for the presence avatar stack and the Jam dialog.
  const others = useMemo(() => participants.filter((p) => p.clientId !== selfClientId), [participants, selfClientId])
  // ── Jam autosave ────────────────────────────────────────────────────────────
  // All peers share the merged graph via broadcast, so only ONE client needs
  // to write it to Postgres: the deterministically-elected persister (owner
  // first, else lowest editor clientId — every peer computes the same answer
  // from presence). One writer → zero optimistic-lock contention during a
  // jam; the election self-heals when the persister leaves. Solo editing gets
  // plain autosave — and, crucially, so does an editor whose realtime channel
  // never came up: the roster is presence-fed and empty in that case, which
  // used to elect nobody and silently disable autosave altogether.
  const isPersister = useMemo(
    () => shouldPersistGraph({
      roster: roster.map((p) => ({ clientId: p.clientId, userId: p.userId, canEdit: p.canEdit })),
      selfClientId,
      selfUserId: self?.userId ?? '',
      canEdit,
      ownerId,
    }),
    [roster, ownerId, selfClientId, self?.userId, canEdit],
  )
  const lastJamAuditAt = useRef(0)
  const autosave = useCallback(async () => {
    // Never autosave before a successful load — a transient load failure leaves
    // defaults in place, and a PUT here would overwrite the stored flow with an
    // empty graph (the server skips the stale-write guard when baseUpdatedAt is
    // absent, which it is until we've loaded).
    if (!loadedOkRef.current || !canEdit || viewingVersion) return
    const suppressAudit = !shouldRecordJamAudit(lastJamAuditAt.current, Date.now())
    const response = await fetch('/api/flows', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // Graph only: name/description/status keep manual save + the dirty dot.
      body: JSON.stringify({ id, graph: graphRef.current, suppressAudit, ...(baseUpdatedAt.current ? { baseUpdatedAt: baseUpdatedAt.current } : {}) }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      if (data.code === 'FLOW_STALE_WRITE') {
        // Someone outside the jam saved over us — same recovery as manual save.
        toast.error('A teammate saved changes since you opened this — reloading the latest.', { duration: 5000 })
        window.setTimeout(() => window.location.reload(), 800)
      }
      return // transient failures: the next edit re-arms the debounce
    }
    const data = await response.json().catch(() => ({}))
    if (data.flow?.updatedAt) {
      baseUpdatedAt.current = data.flow.updatedAt
      if (!suppressAudit) lastJamAuditAt.current = Date.now()
      // Mark the GRAPH portion saved so the dirty dot reflects only unsaved
      // name/description/status edits.
      setSavedSnapshot((prev) => {
        if (!prev) return prev
        try { return JSON.stringify({ ...JSON.parse(prev), graph: graphRef.current }) } catch { return prev }
      })
      // Everyone advances their optimistic-concurrency base — no stale-write
      // reloads between jam participants.
      bus.send('saved', { updatedAt: data.flow.updatedAt })
    }
  }, [id, canEdit, viewingVersion, bus])
  // Debounce: persist 2s after the last graph change (local OR merged remote —
  // the persister persists the whole room's work).
  useEffect(() => {
    if (!loadedOkRef.current || !canEdit || !isPersister || viewingVersion) return
    if (graph === loadedGraphRef.current) return
    const timer = window.setTimeout(() => { void autosave() }, 2000)
    return () => window.clearTimeout(timer)
  }, [graph, canEdit, isPersister, viewingVersion, autosave])
  // A co-editor's autosave advances OUR base + graph-saved marker too.
  useEffect(() => bus.on('saved', (payload) => {
    const updatedAt = typeof payload.updatedAt === 'string' ? payload.updatedAt : null
    if (!updatedAt) return
    baseUpdatedAt.current = updatedAt
    setSavedSnapshot((prev) => {
      if (!prev) return prev
      try { return JSON.stringify({ ...JSON.parse(prev), graph: graphRef.current }) } catch { return prev }
    })
  }), [bus])
  // Arrival cue: opening a flow where a jam is live (or a teammate joining
  // yours) is announced once per client — an invitee lands INSIDE a session,
  // not on a silent canvas.
  const seenJamClients = useRef<Set<string>>(new Set())
  const announcedJam = useRef(false)
  useEffect(() => {
    if (others.length === 0) return
    if (!announcedJam.current) {
      announcedJam.current = true
      for (const p of others) seenJamClients.current.add(p.clientId)
      toast(`Jam in progress — ${others.length === 1 ? `${others[0].name} is` : `${others.length} people are`} here`, {
        action: { label: 'View', onClick: () => setShowJam(true) },
      })
      return
    }
    for (const p of others) {
      if (!seenJamClients.current.has(p.clientId)) toast(`${p.name} joined the jam`)
      seenJamClients.current.add(p.clientId)
    }
  }, [others])
  // ── Voice huddle ────────────────────────────────────────────────────────────
  const huddle = useFlowHuddle(bus, selfClientId, setInHuddle)
  // Huddle notes: consent + capture + post-huddle summary (see the
  // huddle-notes spec — audio never persists, only the note survives).
  const huddleCapture = useHuddleCapture({
    flowId: id,
    joined: huddle.joined,
    localStream: huddle.getLocalStream,
    participants,
    selfClientId,
    setCapture,
  })
  // Everyone whose presence says they're in the huddle (incl. self once joined).
  const huddleMembers = useMemo(
    () => participants.filter((p) => p.inHuddle).map((p) => ({ clientId: p.clientId, name: p.name, color: p.color })),
    [participants],
  )
  // Toast when a huddle starts while we're on the page but not in it — the
  // huddle bar alone is easy to miss from another tab. The ref is seeded from
  // the FIRST presence snapshot, so opening a flow whose huddle is already
  // running doesn't claim it just "started"; the bar covers that case.
  const prevParticipantsRef = useRef<typeof participants | null>(null)
  const { joined: huddleIsJoined, join: joinHuddle } = huddle
  useEffect(() => {
    const prev = prevParticipantsRef.current
    prevParticipantsRef.current = participants
    if (!prev) return // first snapshot: seed only
    const starter = detectHuddleStart(prev, participants, selfClientId, huddleIsJoined)
    if (!starter) return
    toast(`${starter} started a huddle`, {
      description: 'Voice chat is live on this flow.',
      action: { label: 'Join', onClick: () => void joinHuddle() },
    })
  }, [participants, selfClientId, huddleIsJoined, joinHuddle])
  // A teammate's in-flight node drag. Positions land here, not in the graph —
  // the move op broadcast on release is what commits, so a dropped end-packet
  // can leave a ghost for the TTL at worst.
  const [dragPreview, setDragPreview] = useState<DragPreview>({})
  useEffect(() => bus.on('drag', (payload) => {
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : null
    if (!nodeId) return
    setDragPreview((prev) => applyDragPreview(prev, {
      nodeId,
      x: typeof payload.x === 'number' ? payload.x : undefined,
      y: typeof payload.y === 'number' ? payload.y : undefined,
      done: payload.done === true,
    }, Date.now()))
  }), [bus])
  useEffect(() => {
    const timer = window.setInterval(() => {
      setDragPreview((prev) => (Object.keys(prev).length ? pruneDragPreview(prev, Date.now()) : prev))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [])
  // Our own drag, throttled to the graph-broadcast cadence: a drag fires per
  // animation frame, which would be ~60 messages a second per dragger.
  const lastDragSentAt = useRef(0)
  const sendNodeDrag = useCallback((nodeId: string, position: { x: number; y: number }, done: boolean) => {
    if (!canEdit || viewingVersion) return
    const now = Date.now()
    if (!done && now - lastDragSentAt.current < 50) return
    lastDragSentAt.current = now
    bus.send('drag', { nodeId, x: position.x, y: position.y, done })
  }, [bus, canEdit, viewingVersion])

  // Live cursors: stream our pointer in content space (throttled in the hook).
  const onCanvasPointerMove = useCallback((event: ReactPointerEvent) => {
    canvasPan.handlers.onPointerMove(event)
    const rect = canvasContentRef.current?.getBoundingClientRect()
    if (!rect) return
    const point = toContentSpace(event.clientX, event.clientY, rect, zoom)
    sendCursor(point.x, point.y, 'inline')
  }, [canvasPan.handlers, zoom, sendCursor])
  // Who's-editing ring: publish our selected node; render everyone else's.
  useEffect(() => { setSelection(selectedId) }, [selectedId, setSelection])
  // Publish which view we're on: a teammate in the other view can't be drawn
  // (the coordinate systems differ), so the roster offers to follow them there
  // instead of leaving them invisible.
  useEffect(() => { publishView(view) }, [view, publishView])
  // Inline lays out in document pixels, Canvas in DAG coordinates — the same
  // (x, y) means two different places, so only same-view cursors are drawn.
  const viewCursors = useMemo(() => cursors.filter((cursor) => cursor.space === view), [cursors, view])
  const remoteSelections = useMemo(() => {
    const map: Record<string, { name: string; color: string }[]> = {}
    for (const p of others) if (p.selection) (map[p.selection] ??= []).push({ name: p.name, color: p.color })
    return map
  }, [others])
  // Broadcast local edits (the hook throttles + size-guards internally). Skips
  // the remote-applied graph and the initial loaded graph so only genuine local
  // edits go out — never an echo, never a stale-load clobber.
  useEffect(() => {
    // Never broadcast before our own load succeeded (would push an empty graph)
    // or as a view-only participant (their local changes must not reach the
    // room or the elected persister).
    if (!loadedOkRef.current || !canEdit) return
    if (graph === remoteGraphRef.current) { remoteGraphRef.current = null; return }
    if (graph === loadedGraphRef.current) return
    broadcastGraph(graph)
  }, [graph, broadcastGraph, canEdit])

  // Shift-click selects the spine range between the anchor (last single click)
  // and the clicked step; a plain click resets to single-select and re-anchors.
  const handleSelect = useCallback((nodeId: string, shiftKey?: boolean) => {
    if (shiftKey && selectAnchor.current && selectAnchor.current !== nodeId) {
      const ids = spineIds(graph)
      const a = ids.indexOf(selectAnchor.current)
      const b = ids.indexOf(nodeId)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelectedIds(ids.slice(lo, hi + 1).filter((id) => id !== 'trigger'))
        setSelectedId(null) // close the drawer while a range is selected
        return
      }
    }
    selectAnchor.current = nodeId
    setSelectedId(nodeId)
    setSelectedIds([])
  }, [graph])
  const bulkDelete = useCallback(() => {
    if (selectedIds.length === 0) return
    commitGraph(deleteNodes(graph, selectedIds))
    setSelectedIds([])
    toast.success(`Deleted ${selectedIds.length} steps — ⌘Z to undo.`)
  }, [graph, selectedIds, commitGraph])
  const bulkDuplicate = useCallback(() => {
    if (selectedIds.length === 0) return
    // Duplicate in spine order so copies land in sequence after the originals.
    const ordered = spineIds(graph).filter((id) => selectedIds.includes(id))
    let next = graph
    for (const id of ordered) next = duplicateNode(next, id).graph
    commitGraph(next)
    setSelectedIds([])
    toast.success(`Duplicated ${ordered.length} steps.`)
  }, [graph, selectedIds, commitGraph])

  const applyInsertSeed = useCallback((next: FlowGraph, nodeId: string, seed?: FlowInsertSeed): FlowGraph => {
    if (!seed) return next
    const node = next.nodes.find((entry) => entry.id === nodeId)
    if (!node) return next
    if (node.type === 'agent') {
      return updateNode(next, {
        ...node,
        data: {
          ...node.data,
          agentId: seed.agentId ?? node.data.agentId,
          ...(seed.label ? { label: seed.label } : {}),
        },
      })
    }
    if (node.type === 'tool') {
      return updateNode(next, {
        ...node,
        data: {
          ...node.data,
          connectionId: seed.connectionId ?? node.data.connectionId,
          toolName: seed.toolName ?? node.data.toolName,
          ...(seed.label ? { label: seed.label } : {}),
        },
      })
    }
    if (node.type === 'variable' && seed.variableOp) {
      // Non-initialize ops mutate a variable declared elsewhere — the default
      // varType only belongs on the declaration site.
      const varType = seed.variableOp === 'initialize' ? node.data.varType : undefined
      return updateNode(next, {
        ...node,
        data: { ...node.data, op: seed.variableOp, varType, ...(seed.label ? { label: seed.label } : {}) },
      })
    }
    if (node.type === 'data' && seed.dataOp) {
      // Ops with required list config start with one empty row so the editor
      // opens ready to fill in (mirrors condition/transform defaults).
      const extras =
        seed.dataOp === 'filterArray'
          ? { clauses: [{ left: '', op: 'contains' as const, right: '' }] }
          : seed.dataOp === 'select'
            ? { fields: [{ name: '', value: '' }] }
            : {}
      return updateNode(next, {
        ...node,
        data: { ...node.data, op: seed.dataOp, ...extras, ...(seed.label ? { label: seed.label } : {}) },
      })
    }
    if (node.type === 'ai' && seed.aiOp) {
      // Ops with required config open ready to fill in (mirrors data-op seeding):
      // extract needs a field row, categorize two category rows, score its bounds.
      const extras =
        seed.aiOp === 'extract'
          ? { outputFields: [{ name: '', type: 'string' as const }] }
          : seed.aiOp === 'categorize'
            ? { categories: ['', ''] }
            : seed.aiOp === 'score'
              ? { scoreMin: 1, scoreMax: 10 }
              : {}
      return updateNode(next, {
        ...node,
        data: { ...node.data, aiOp: seed.aiOp, ...extras, ...(seed.label ? { label: seed.label } : {}) },
      })
    }
    if (node.type === 'code' && seed.codeLanguage) {
      const python = seed.codeLanguage === 'python'
      return updateNode(next, {
        ...node,
        data: {
          ...node.data,
          language: seed.codeLanguage,
          code: python ? 'return input' : 'return input;',
          ...(seed.label ? { label: seed.label } : {}),
        },
      })
    }
    // Every other step type only carries the label (picker leaves like
    // "HTTP Webhook" pre-name their node).
    if (seed.label && node.type !== 'trigger') {
      return updateNode(next, { ...node, data: { ...node.data, label: seed.label } } as FlowNode)
    }
    return next
  }, [])
  // ── Canvas actions ──────────────────────────────────────────────────────────
  // Every one routes through commitGraph, so undo/redo and the jam broadcast
  // work on canvas edits exactly as they do on inline ones.
  const canvasSelectionChange = useCallback((ids: string[]) => {
    setSelectedIds(ids.length > 1 ? ids : [])
    setSelectedId(ids.length === 1 ? ids[0] : null)
    // Changing the selection closes the drawer; re-open with a double-click.
    setOpenNodeId(null)
  }, [])
  const canvasOpenNode = useCallback((nodeId: string) => {
    setSelectedId(nodeId)
    setSelectedIds([])
    setOpenNodeId(nodeId)
  }, [])
  const canvasMoveNodes = useCallback((positions: Map<string, NodePosition>) => {
    commitGraph(setNodePositions(graph, positions))
  }, [graph, commitGraph])
  const canvasConnect = useCallback((source: string, target: string, branch?: string) => {
    const { graph: next, added } = addEdge(graph, source, target, branch)
    if (!added) {
      toast.error('That connection would loop the flow back on itself.')
      return
    }
    commitGraph(next)
  }, [graph, commitGraph])
  const canvasDeleteEdge = useCallback((edgeId: string) => {
    commitGraph(removeEdge(graph, edgeId))
  }, [graph, commitGraph])
  const canvasInsertFromHandle = useCallback(
    (sourceId: string, branch: string | undefined, position: NodePosition, type: StepType, seed?: FlowInsertSeed) => {
      const agentId = type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined
      const { graph: inserted, nodeId } = insertNodeFromHandle(graph, sourceId, branch, type, position, agentId)
      commitGraph(applyInsertSeed(inserted, nodeId, seed))
      setSelectedId(nodeId)
      setOpenNodeId(nodeId)
    },
    [graph, agents, commitGraph, applyInsertSeed],
  )
  const canvasInsertOnEdge = useCallback(
    (edgeId: string, position: NodePosition, type: StepType, seed?: FlowInsertSeed) => {
      const agentId = type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined
      const { graph: inserted, nodeId } = insertNodeOnEdge(graph, edgeId, type, position, agentId)
      if (!nodeId) return
      commitGraph(applyInsertSeed(inserted, nodeId, seed))
      setSelectedId(nodeId)
      setOpenNodeId(nodeId)
    },
    [graph, agents, commitGraph, applyInsertSeed],
  )
  const canvasTidyUp = useCallback(() => {
    commitGraph(setNodePositions(graph, layoutGraph(graph, { force: true })))
    toast.success('Steps re-arranged — ⌘Z to undo.')
  }, [graph, commitGraph])
  const canvasCopy = useCallback(() => {
    const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : []
    const selection = copySelection(graph, ids)
    if (!selection.nodes.length) return
    writeFlowSelection(selection)
    toast.success(`Copied ${selection.nodes.length} step${selection.nodes.length === 1 ? '' : 's'}.`)
  }, [graph, selectedIds, selectedId])
  const canvasPaste = useCallback((position: NodePosition) => {
    const selection = readFlowSelection()
    if (!selection) return
    const { graph: next, nodeIds } = pasteSelectionAt(graph, selection, position)
    if (!nodeIds.length) return
    commitGraph(next)
    setSelectedIds(nodeIds.length > 1 ? nodeIds : [])
    setSelectedId(nodeIds.length === 1 ? nodeIds[0] : null)
    toast.success(`Pasted ${nodeIds.length} step${nodeIds.length === 1 ? '' : 's'}.`)
  }, [graph, commitGraph])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(graph)
    setGraph(prev)
    setSelectedId(null)
  }, [graph])
  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(graph)
    setGraph(next)
    setSelectedId(null)
  }, [graph])
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a.title])), [agents])
  // Stable identity: the canvas memoizes its whole node array on this, so an
  // inline arrow here would rebuild every chip on every unrelated re-render
  // (a live jam cursor stream is ~25 of those a second).
  const agentNameOf = useCallback((agentId: string) => agentsById.get(agentId) ?? '', [agentsById])
  // Friendly labels for {{token}} chips in the drawer's editors and for the
  // humanized read-only summaries on canvas step cards. Version view labels
  // from the viewed snapshot so deleted/renamed steps read as they did then.
  const labelCtx = useMemo(
    () => ({ stepLabels: stepLabelsOf(viewingVersion ? viewingVersion.graph : graph, agents) }),
    [graph, agents, viewingVersion],
  )
  const labelForNode = useCallback(
    (nodeId: string) => {
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (!node) return nodeId
      if (node.type === 'agent') return node.data.label || agentsById.get(node.data.agentId) || 'Agent step'
      return ('label' in node.data && node.data.label) || defaultStepLabel(node)
    },
    [graph, agentsById],
  )

  // "Make a subflow": the picked start step + pending end/name choices.
  const [subflowDraft, setSubflowDraft] = useState<{ startId: string; endId: string; name: string } | null>(null)
  const [makingSubflow, setMakingSubflow] = useState(false)
  const makeSubflow = useCallback(async () => {
    if (!subflowDraft) return
    const plan = planSubflowExtraction(graph, subflowDraft.startId, subflowDraft.endId)
    if ('error' in plan) {
      toast.error(plan.error)
      return
    }
    const fallback = `${name || 'Flow'}: ${labelForNode(subflowDraft.startId)}`
    const childName = subflowDraft.name.trim() || fallback
    setMakingSubflow(true)
    try {
      const createRes = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: childName, status: 'ACTIVE', graph: plan.childGraph }),
      })
      const created = await createRes.json().catch(() => ({}))
      if (!createRes.ok || !created?.flow?.id) {
        toast.error(created?.error || 'Could not create the subflow.')
        return
      }
      const publishRes = await fetch(`/api/flows/${created.flow.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!publishRes.ok) {
        toast.error('The subflow was created but could not be published — publish it manually, then wire it up.')
        return
      }
      const { graph: nextGraph } = replaceRangeWithSubflow(graph, plan, created.flow.id, childName)
      commitGraph(nextGraph)
      setSubflowDraft(null)
      toast.success(`Made "${childName}" — these steps now run as their own flow.`)
    } finally {
      setMakingSubflow(false)
    }
  }, [subflowDraft, graph, commitGraph, name, labelForNode])
  const jumpToNode = useCallback((nodeId: string) => {
    if (viewingVersion) return
    setSelectedId(nodeId)
    if (view === 'canvas') {
      // Bump the nonce so jumping to the same node twice still re-centers.
      setFocusRequest((prev) => ({ id: nodeId, nonce: (prev?.nonce ?? 0) + 1 }))
      return
    }
    document.querySelector(`[data-node-id="${nodeId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [viewingVersion, view])
  const inputFields = useMemo(() => triggerInputFields(graph), [graph])
  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null
  // Inline opens the drawer whenever a step is selected. Canvas needs an
  // explicit double-click, and any change of selection closes it again — so the
  // drawer always shows the step that is actually selected, never a stale one.
  const drawerNode = view === 'canvas' ? (openNodeId && openNodeId === selectedId ? selectedNode : null) : selectedNode
  const closeDrawer = useCallback(() => {
    setOpenNodeId(null)
    setSelectedId(null)
  }, [])
  // The open step's neighbours in reading order, so the drawer's prev/next
  // walks the flow the way the user sees it rather than the order the steps
  // happen to sit in the array.
  const drawerNavigation = useMemo(() => {
    if (!drawerNode) return undefined
    const order = stepOrder(graph)
    const index = order.indexOf(drawerNode.id)
    if (index < 0) return undefined
    const at = (i: number) => {
      const id = order[i]
      return id ? { id, label: labelForNode(id) } : undefined
    }
    return { index: index + 1, total: order.length, previous: at(index - 1), next: at(index + 1) }
  }, [drawerNode, graph, labelForNode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      // isContentEditable covers the TokenTextEditor chip fields (tagName DIV):
      // without it, Backspace inside a chip editor would delete the whole step.
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (viewingVersion) return
        if (selectedIds.length > 1) {
          e.preventDefault()
          bulkDelete()
        } else if (selectedId && selectedId !== 'trigger') {
          e.preventDefault()
          commitGraph(deleteNode(graph, selectedId))
          setSelectedId(null)
          toast.success('Step deleted — ⌘Z to undo.')
        }
        return
      }
      // 'd' toggles disable on the selected step (n8n parity) — not for the
      // trigger or multi-output branch nodes, which can't passthrough.
      if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (viewingVersion) return
        if (selectedNode && selectedNode.type !== 'trigger' && selectedNode.type !== 'condition' && selectedNode.type !== 'switch') {
          e.preventDefault()
          commitGraph(updateNode(graph, { ...selectedNode, disabled: selectedNode.disabled ? undefined : true }))
        }
        return
      }
      // Canvas handles copy/paste itself so a paste lands at the pointer.
      if (view === 'canvas') return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        if (selectedNode && selectedNode.type !== 'trigger') {
          e.preventDefault()
          writeFlowClipboard(selectedNode)
          toast.success('Step copied.')
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        if (viewingVersion) return
        const copied = readFlowClipboard()
        if (!copied) return
        e.preventDefault()
        const ids = spineIds(graph)
        const afterId = selectedId && selectedId !== 'trigger' ? selectedId : ids[ids.length - 1] ?? 'trigger'
        const { graph: next, nodeId } = pasteNodeAfter(graph, afterId, copied)
        commitGraph(next)
        setSelectedId(nodeId)
        toast.success('Step pasted.')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, selectedId, selectedNode, selectedIds, bulkDelete, graph, commitGraph, viewingVersion, view])

  const loopContext = useMemo(() => parentLoop(graph, selectedId), [graph, selectedId])
  const parallelContext = useMemo(() => parentParallelBranch(graph, selectedId), [graph, selectedId])
  // A step that runs once per item ({{perItem.over}}) exposes {{item}} in its own
  // editors, just like a loop body does.
  const selectedPerItemOver = useMemo(() => {
    const pi = selectedNode && 'perItem' in selectedNode.data ? (selectedNode.data as { perItem?: { over?: string } }).perItem : undefined
    return pi?.over?.trim() ? pi.over : undefined
  }, [selectedNode])
  const insideLoop = Boolean(loopContext) || Boolean(selectedPerItemOver)
  const upstreamIds = useMemo(() => {
    const ids = spineIds(graph)
    if (loopContext) {
      const loopIdx = ids.indexOf(loopContext.loop.id)
      return [
        ...(loopIdx > 0 ? ids.slice(1, loopIdx) : []),
        ...loopContext.loop.data.body.slice(0, loopContext.index),
      ].filter((x) => x !== selectedId)
    }
    if (parallelContext) {
      const parallelIdx = ids.indexOf(parallelContext.parallelId)
      return [
        ...(parallelIdx > 0 ? ids.slice(1, parallelIdx) : []),
        ...parallelContext.branch.slice(0, parallelContext.index),
      ].filter((x) => x !== selectedId)
    }
    const idx = ids.indexOf(selectedId ?? '')
    return (idx > 0 ? ids.slice(1, idx) : ids.slice(1)).filter((x) => x !== selectedId)
  }, [graph, selectedId, loopContext, parallelContext])

  // Variables initialized upstream of the selected step: fed to the datatree
  // (as {{var.<name>}} roots) and to the editors' variable-name selects.
  const upstreamVariables = useMemo(() => {
    const byName = new Map<string, string>()
    for (const uid of upstreamIds) {
      const n = graph.nodes.find((x) => x.id === uid)
      if (n?.type === 'variable' && n.data.op === 'initialize' && n.data.name.trim()) {
        byName.set(n.data.name.trim(), n.data.varType ?? 'string')
      }
    }
    return Array.from(byName, ([name, type]) => ({ name, type }))
  }, [graph, upstreamIds])

  // The datatree of mappable upstream data — declared output fields plus fields
  // inferred from the latest run's actual output.
  const dataFields = useMemo(() => {
    if (!selectedNode || selectedNode.type === 'trigger') return []
    const lastOutputs: Record<string, unknown> = {}
    for (const step of selectedRun?.steps ?? []) lastOutputs[step.nodeId] = parseFlowValue(step.output)
    const triggerInput = testInput.trim() ? parseFlowInput(testInput) : storedRunInput(selectedRun?.input)
    const sampleInput = typeof triggerInput === 'string' ? triggerInput : triggerInput == null ? '' : JSON.stringify(triggerInput)
    if (loopContext) {
      lastOutputs.__item = sampleLoopItem(loopContext.loop, lastOutputs, sampleInput)
    } else if (selectedPerItemOver) {
      // A step that runs once per item exposes {{item}} against its own list.
      lastOutputs.__item = sampleLoopItem({ data: { over: selectedPerItemOver } } as Extract<FlowNode, { type: 'loop' }>, lastOutputs, sampleInput)
    }
    const upstream = upstreamIds.map((uid) => {
      const n = graph.nodes.find((x) => x.id === uid)
      const label =
        n?.type === 'agent'
          ? n.data.label || agentsById.get(n.data.agentId) || 'Agent step'
          : n?.type === 'tool'
            ? n.data.label || n.data.toolName || 'Tool call'
            : n?.type === 'http'
              ? n.data.label || `${n.data.method} request`
              : n
                ? ('label' in n.data && n.data.label) || defaultStepLabel(n)
                : uid
      const outputFields = outputFieldsForNode(n, toolCatalog)
      return { id: uid, label, outputFields }
    })
    return buildDataTree({ upstream, insideLoop, lastOutputs, triggerInput, inputFields, variables: upstreamVariables })
  }, [selectedNode, upstreamIds, graph, selectedRun, insideLoop, agentsById, loopContext, selectedPerItemOver, testInput, inputFields, toolCatalog, upstreamVariables])

  // Live chip preview: resolve a field's {{tokens}} against the selected run's
  // recorded outputs + trigger input, so the editor can show what a chip
  // evaluates to before running the flow. Same shape the interpreter builds.
  const previewCtx = useMemo<FlowContext>(() => {
    const step: Record<string, { output: unknown }> = {}
    const variables: Record<string, unknown> = {}
    for (const s of selectedRun?.steps ?? []) {
      const baseId = s.nodeId.split('#')[0]
      const output = parseFlowValue(s.output)
      step[baseId] = { output }
      const node = graph.nodes.find((n) => n.id === baseId)
      if (node?.type === 'variable' && node.data.name.trim()) variables[node.data.name.trim()] = output
    }
    const triggerInput = testInput.trim() ? parseFlowInput(testInput) : storedRunInput(selectedRun?.input)
    const stepLabels = stepLabelsOf(graph, agents)
    const stepAliases: Record<string, string> = {}
    for (const [id, label] of Object.entries(stepLabels)) {
      const alias = normalizeStepAlias(label)
      if (alias && stepAliases[alias] === undefined) stepAliases[alias] = id
    }
    return { trigger: { input: triggerInput }, step, variables, stepAliases, stepLabels }
  }, [selectedRun, testInput, graph, agents])

  const selectedNodeRawInput = useMemo(() => {
    if (!selectedNode) return undefined
    const steps = selectedRun?.steps ?? []
    const isEmpty = (value: unknown) =>
      value === undefined ||
      value === null ||
      (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)

    // 1. Ground truth for debugging — the exact payload this node RECEIVED on
    //    the selected run, as the executor recorded it (a tool/http/agent step
    //    stores its resolved config/args/prompt; tokens are already
    //    substituted). This is what actually went into the node. Loop bodies
    //    record per-iteration rows (`${id}#${index}`); take the latest.
    const ownStep = [...steps]
      .reverse()
      .find((entry) => entry.nodeId === selectedNode.id || entry.nodeId.startsWith(`${selectedNode.id}#`))
    if (ownStep && !isEmpty(ownStep.input)) return parseFlowValue(ownStep.input)

    // 2. The node hasn't recorded a real input (e.g. it never ran, or it's a
    //    pure interpreter node whose input isn't persisted): show the upstream
    //    data that feeds it — the parent nodes' outputs on this run.
    const outputs = new Map(steps.map((step) => [step.nodeId, parseFlowValue(step.output)]))
    const directParents = graph.edges
      .filter((edge) => edge.target === selectedNode.id)
      .map((edge) => edge.source)
    const parentValues = directParents
      .map((nodeId) => ({ nodeId, value: outputs.get(nodeId) }))
      .filter((entry) => entry.value !== undefined)
    if (parentValues.length === 1) return parentValues[0].value
    if (parentValues.length > 1) {
      return Object.fromEntries(parentValues.map((entry) => [entry.nodeId, entry.value]))
    }

    // 3. First node after the trigger: the run's input payload.
    const triggerInput = testInput.trim() ? parseFlowInput(testInput) : storedRunInput(selectedRun?.input)
    return triggerInput === '' ? undefined : triggerInput
  }, [graph.edges, selectedNode, selectedRun, testInput])

  const selectedNodeRawOutput = useMemo(() => {
    if (!selectedNode) return undefined
    const step = [...(selectedRun?.steps ?? [])]
      .reverse()
      .find((entry) => entry.nodeId === selectedNode.id || entry.nodeId.startsWith(`${selectedNode.id}#`))
    if (!step) return undefined
    if (step.error && step.output == null) return { error: step.error, status: step.status }
    return parseFlowValue(step.output)
  }, [selectedNode, selectedRun])

  const selectedNodeRawLogs = useMemo(() => {
    if (!selectedNode) return undefined
    const step = [...(selectedRun?.steps ?? [])]
      .reverse()
      .find((entry) => entry.nodeId === selectedNode.id || entry.nodeId.startsWith(`${selectedNode.id}#`))
    const logs = step?.logs
    return Array.isArray(logs) ? logs.map((entry) => String(entry)) : undefined
  }, [selectedNode, selectedRun])

  const validation = useMemo(
    () => validateFlowGraph(graph, { agents, toolCatalog, flowId: id }),
    [graph, agents, toolCatalog, id],
  )

  const issuesByNode = useMemo(() => {
    const map: Record<string, { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }> = {}
    for (const issue of validation.issues) {
      if (!issue.nodeId) continue
      const entry = (map[issue.nodeId] ??= { errors: 0, warnings: 0, items: [] })
      if (issue.level === 'error') entry.errors += 1
      else entry.warnings += 1
      entry.items.push({ level: issue.level, message: issue.message })
    }
    return map
  }, [validation])

  const save = useCallback(async (): Promise<boolean> => {
    if (!loadedOkRef.current) return false // never overwrite a flow we failed to load
    if (external) return false // guests autosave the canvas; settings saves are org-only
    if (!canEdit) {
      toast.error('This flow is view-only — ask its owner to make changes.')
      return false
    }
    setSaving(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // baseUpdatedAt lets the server reject a stale overwrite if a co-editor
        // saved since we loaded (optimistic concurrency). Status is deliberately
        // NOT sent — publish/unpublish own the lifecycle server-side.
        body: JSON.stringify({ id, name, description, graph, ...(baseUpdatedAt.current ? { baseUpdatedAt: baseUpdatedAt.current } : {}) }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        if (data.code === 'FLOW_STALE_WRITE') {
          toast.error('A teammate saved changes since you opened this — reloading the latest.', { duration: 5000 })
          window.setTimeout(() => window.location.reload(), 800)
          return false
        }
        toast.error(data.error || 'Could not save the flow.')
        return false
      }
      const data = await response.json().catch(() => ({}))
      // Advance our concurrency base to the just-saved version.
      if (data.flow?.updatedAt) baseUpdatedAt.current = data.flow.updatedAt
      if (data.flow) setUnpublishedChanges(Boolean(data.flow.unpublishedChanges))
      setSavedSnapshot(JSON.stringify({ name, description, graph }))
      return true
    } finally {
      setSaving(false)
    }
  }, [id, name, description, graph, canEdit, external])

  const publish = useCallback(
    async (action: 'publish' | 'revert' | 'unpublish' = 'publish') => {
      setPublishing(true)
      try {
        if (action === 'publish' && !validation.ok) {
          // Open the Checker rather than only flashing a toast: a publish that
          // fails validation otherwise leaves the flow sitting as a draft with
          // no visible reason, which reads as "publish is broken".
          setShowChecker(true)
          const count = validation.errors.length
          toast.error(
            count > 1
              ? `${count} things to fix before publishing — see the Checker.`
              : validation.errors[0]?.message || 'Fix the flow before publishing.',
          )
          return
        }
        if (action === 'publish' && !(await save())) return
        const response = await fetch(`/api/flows/${id}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revert: action === 'revert', unpublish: action === 'unpublish' }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          // The server re-validates against live agents/connections, so it can
          // reject a graph the client thought was fine (a deleted agent, a
          // revoked connection). Surface it in the Checker too.
          if (action === 'publish') setShowChecker(true)
          toast.error(data.error || (action === 'unpublish' ? 'Could not unpublish.' : 'Could not publish.'))
          return
        }
        if (action === 'revert' && data.flow?.graph) setGraph(data.flow.graph)
        setVersion(data.flow?.version ?? version)
        setPublished(Boolean(data.flow?.published))
        if (data.flow?.status) setStatus(data.flow.status)
        if (data.flow) setUnpublishedChanges(Boolean(data.flow.unpublishedChanges))
        toast.success(
          action === 'revert'
            ? 'Reverted to the published version.'
            : action === 'unpublish'
              ? 'Unpublished — the flow will no longer run.'
              : `Published v${data.flow?.version}.`,
        )
      } finally {
        setPublishing(false)
      }
    },
    [id, save, validation, version],
  )

  const pollRuns = useCallback(() => {
    const tick = async () => {
      // Don't poll a tab nobody is looking at. Browsers throttle background
      // timers but never stop them, so an abandoned builder tab otherwise
      // issues an authenticated request every couple of seconds for as long as
      // the run lasts. The interval itself keeps ticking, so returning to the
      // tab picks the run back up within one 2s beat — no listener needed, and
      // no cleanup to leak in a component that already has plenty to track.
      if (typeof document !== 'undefined' && document.hidden) return
      const data = await fetch(`/api/flows/${id}/runs`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      const allRuns = data?.runs as FlowRunDetail[] | undefined
      if (allRuns) setRuns(allRuns.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt })))
      const latest = data?.latest as FlowRunDetail | null
      if (!latest) {
        // Nothing to watch (flow never ran) — stop the interval.
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        return
      }
      // Outcome toasts: runs execute in the background now (the execute route
      // returns before the run finishes), so completion is observed here. Only
      // a transition WITNESSED live in this session toasts — a terminal run
      // seen on first poll (e.g. returning to the page later) stays silent.
      const watched = watchedRun.current
      if (watched?.id === latest.id && watched.status !== latest.status) {
        if (latest.status === 'succeeded') toast.success('Flow ran.')
        else if (latest.status === 'failed') toast.error('The flow failed — check the step statuses.')
        else if (latest.status === 'waiting') toast('The flow is waiting for your reply.', { action: { label: 'View', onClick: () => setShowRuns(true) } })
      }
      watchedRun.current = { id: latest.id, status: latest.status }
      // Respect a pinned run: refresh its details (so a waiting banner clears
      // when it resumes) instead of stealing selection back to the latest run.
      const pinned = pinnedRunId.current && pinnedRunId.current !== latest.id
        ? allRuns?.find((r) => r.id === pinnedRunId.current) ?? null
        : null
      const target = pinned ?? latest
      setSelectedRun(target)
      const map: Record<string, StepStatus> = {}
      for (const step of target.steps as { nodeId: string; status: StepStatus }[]) map[step.nodeId] = step.status
      setStatusByNode(map)
      const done = (r: FlowRunDetail) => ['succeeded', 'failed'].includes(r.status)
      if (done(latest) && (!pinned || done(pinned)) && pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    if (pollRef.current) clearInterval(pollRef.current)
    // The tick itself skips while the tab is hidden (see its first line), so a
    // builder left open in a background tab on a long run stops polling and
    // resumes on return. The interval keeps running because it is also what
    // self-stops the poll once the run reaches a terminal state.
    pollRef.current = setInterval(tick, 2000)
    tick()
  }, [id])

  // Runs continue in the background after the execute request returns, so a
  // user returning to the builder must immediately see history and pick up a
  // still-live run. The tick self-stops once the latest run is terminal (or
  // when the flow has never run).
  useEffect(() => {
    pollRuns()
  }, [pollRuns])

  // Realtime streaming: when a run is live, subscribe to its channel and refresh
  // the instant a step changes (debounced to coalesce bursts) instead of waiting
  // for the 2s poll. The poll stays as a fallback when Supabase is unavailable.
  const streamRunId = selectedRun && !['succeeded', 'failed'].includes(selectedRun.status) ? selectedRun.id : null
  const nudgeRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onStreamTick = useCallback(() => {
    if (nudgeRef.current) return
    nudgeRef.current = setTimeout(() => {
      nudgeRef.current = null
      pollRuns()
    }, 400)
  }, [pollRuns])
  useFlowRunStream(streamRunId, onStreamTick)

  const updateSharing = useCallback(async (next: 'shared' | 'view' | 'private') => {
    const response = await fetch('/api/flows', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, visibility: next }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      toast.error('Could not change sharing.')
      return
    }
    // A settings PUT advances Flow.updatedAt too. Keep the optimistic-lock base
    // in sync or the next canvas save is falsely rejected as a teammate edit.
    if (data.flow?.updatedAt) baseUpdatedAt.current = data.flow.updatedAt
    setVisibility(next)
    toast.success(next === 'shared' ? 'Everyone in your workspace can edit this flow.' : next === 'view' ? 'Everyone can view and run it — only you can edit.' : 'Only you can see this flow now.')
  }, [id])

  const openFlowSettings = useCallback(() => {
    setSettingsDraft({ name, description, folder })
    setShowFlowSettings(true)
  }, [name, description, folder])

  const saveFlowSettings = useCallback(async () => {
    const nextName = settingsDraft.name.trim()
    if (!nextName) {
      toast.error('Flow name is required.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: nextName,
          description: settingsDraft.description,
          folder: settingsDraft.folder.trim().slice(0, 60),
          ...(baseUpdatedAt.current ? { baseUpdatedAt: baseUpdatedAt.current } : {}),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not save flow settings.')
        return
      }
      const nextDescription = settingsDraft.description
      const nextFolder = settingsDraft.folder.trim().slice(0, 60)
      setName(nextName)
      setDescription(nextDescription)
      setFolder(nextFolder)
      if (data.flow?.updatedAt) baseUpdatedAt.current = data.flow.updatedAt
      setSavedSnapshot(JSON.stringify({ name: nextName, description: nextDescription, graph }))
      setShowFlowSettings(false)
      toast.success('Flow settings saved.')
    } finally {
      setSaving(false)
    }
  }, [id, settingsDraft, graph])

  const rerunFromStep = useCallback(async (runId: string, nodeId: string) => {
    const response = await fetch(`/api/flows/${id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromRunId: runId, fromNodeId: nodeId }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      toast.error(data.error || 'Could not re-run from that step.')
      return
    }
    toast.success('Re-running from that step — earlier steps replay their recorded results.')
    pollRuns()
  }, [id, pollRuns])

  const forkWithEdits = useCallback(
    async (runId: string, nodeId: string, recordedOutput: unknown, runFailed: boolean) => {
      const edited = window.prompt(
        `Replace what "${nodeId}" produced. Everything after it runs again with this value.`,
        JSON.stringify(recordedOutput ?? null, null, 2),
      )
      if (edited === null) return

      let value: unknown
      try {
        value = JSON.parse(edited)
      } catch {
        toast.error('That is not valid JSON — check for a missing quote or comma.')
        return
      }

      // The asymmetry is real and worth stating plainly: a fork is a NEW run, so
      // it gets fresh idempotency keys and any step that writes to an external
      // system writes again. Continuing the same run keeps its keys, so already
      // completed steps stay deduped.
      const patch =
        runFailed &&
        window.confirm(
          'Continue this same run from the edited step?\n\n' +
            'OK — continue this run. Steps that already ran will not repeat their external actions.\n\n' +
            'Cancel — start a separate run instead. Steps that send email, post messages, or write to other systems WILL run again.',
        )

      const response = await fetch(`/api/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromRunId: runId,
          fromNodeId: nodeId,
          mode: patch ? 'patch' : 'fork',
          overrides: { [nodeId]: value },
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not start that run.')
        return
      }
      toast.success(patch ? 'Continuing this run from the edited step.' : 'Started a separate run with your edit.')
      pollRuns()
    },
    [id, pollRuns],
  )

  const selectRun = useCallback(
    async (runId: string) => {
      pinnedRunId.current = runId
      const data = await fetch(`/api/flows/${id}/runs`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      const found = (data?.runs as FlowRunDetail[] | undefined)?.find((r) => r.id === runId)
      if (found) setSelectedRun(found)
    },
    [id],
  )

  // Node-editor step controls: run through a node ("Execute step") or up to but
  // not including it ("Execute previous nodes"). Both start a partial run whose
  // recorded step rows populate the drawer's INPUT/OUTPUT panes.
  const runPartial = useCallback(
    async (nodeId: string, mode: 'stopAfter' | 'stopBefore' | 'only') => {
      // 'only' is single-step execution: replay the selected run's recorded
      // outputs up to this node, then run THIS node and stop. Every upstream
      // step is read from that run rather than re-executed, so testing one
      // node costs one call instead of the whole pipeline. It needs a run to
      // replay from — without one there is no upstream data to stand on.
      if (mode === 'only' && !selectedRun?.id) {
        toast.error('Run the flow once first — this replays the last run’s data into just this step.')
        return
      }
      const body =
        mode === 'only'
          ? { fromRunId: selectedRun!.id, fromNodeId: nodeId, stopAfterNodeId: nodeId }
          : mode === 'stopAfter'
            ? { stopAfterNodeId: nodeId }
            : { stopBeforeNodeId: nodeId }
      const response = await fetch(`/api/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not run this step.')
        return
      }
      const runId = data?.run?.flowRunId
      if (runId) void selectRun(runId)
      pollRuns()
    },
    [id, pollRuns, selectRun, selectedRun],
  )

  // "Set mock data": pin a node's output on the graph so it isn't executed and
  // downstream steps consume the pinned value. Clearing removes the pin.
  const setNodeMockData = useCallback((nodeId: string, value: unknown | undefined) => {
    setGraph((g) => {
      const pinData = { ...(g.pinData ?? {}) }
      if (value === undefined) delete pinData[nodeId]
      else pinData[nodeId] = value
      return { ...g, pinData: Object.keys(pinData).length ? pinData : undefined }
    })
  }, [])

  // Answer a paused run's agent question — the execute route resumes it.
  const replyToRun = useCallback(
    async (flowRunId: string, reply: string) => {
      const response = await fetch(`/api/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowRunId, reply }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error ?? 'Could not send the reply.')
        // Re-throw so the panel keeps the typed reply for a retry.
        throw new Error(data.error ?? 'Could not send the reply.')
      }
      toast.success('Reply sent — resuming the flow.')
      pollRuns()
    },
    [id, pollRuns],
  )

  const viewVersion = useCallback(
    async (v: number) => {
      const data = await fetch(`/api/flows/${id}/versions?version=${v}`, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
      if (data?.success && data.version?.graph) {
        setSelectedId(null)
        setViewingVersion({ version: v, graph: data.version.graph })
      } else {
        toast.error('Could not load that version.')
      }
    },
    [id],
  )

  const restoreVersion = useCallback(
    async (v: number) => {
      const response = await fetch(`/api/flows/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: v, action: 'restore' }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.flow?.graph) {
        commitGraph(data.flow.graph)
        setSavedSnapshot(JSON.stringify({ name, description, graph: data.flow.graph }))
        setUnpublishedChanges(true)
        setViewingVersion(null)
        toast.success(`Restored v${v} into the draft.`)
      } else {
        toast.error(data.error || 'Could not restore that version.')
      }
    },
    [id, commitGraph, name, description],
  )

  const run = useCallback(async () => {
    if (viewingVersion) {
      toast.error('Close the version view before running.')
      return
    }
    if (!validation.ok) {
      toast.error(validation.errors[0]?.message || 'Fix the flow before running.')
      return
    }
    const missing = missingRequiredInputFields(inputFields, parseFlowInput(testInput))
    if (missing.length) {
      toast.error(`Fill the required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
      setShowTest(true)
      return
    }
    setRunning(true)
    setShowRuns(true)
    setStatusByNode({})
    // A fresh run should be followed — drop any pin on an older run.
    pinnedRunId.current = null
    try {
      if (!(await save())) return
      const response = await fetch(`/api/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: testInput }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) toast.error(data.error || 'Run failed.')
      else {
        // The run executes in the background — it keeps going (and stays in
        // history) even if you leave this page. pollRuns follows it live and
        // toasts the outcome when it settles.
        if (data.run?.flowRunId) watchedRun.current = { id: data.run.flowRunId, status: 'running' }
        toast.success('Run started — it keeps going even if you leave this page.')
      }
      pollRuns()
    } finally {
      setRunning(false)
    }
  }, [id, save, pollRuns, testInput, validation, inputFields, viewingVersion])

  const fixWithCopilot = useCallback(async () => {
    // Copilot generation grounds on the CALLER's workspace, so an external guest
    // would inject their org's agent/tool ids into another org's flow; and a
    // view-only user must not edit at all. Gate the action (the button is also
    // hidden for these users — this is the server-of-truth guard).
    if (external || !canEdit) {
      toast.error(external ? 'Fix-with-Copilot isn’t available on shared flows — ask in the Copilot chat instead.' : 'This flow is view-only — ask its owner to make changes.')
      return
    }
    if (viewingVersion) {
      toast.error('Close the version view before applying fixes.')
      return
    }
    setFixing(true)
    try {
      const response = await fetch('/api/flows/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'Fix the validation problems in this flow.',
          currentGraph: graph,
          issues: [...validation.errors, ...validation.warnings].map((issue) => issue.message),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.success && data.graph) {
        commitGraph(data.graph)
        setSelectedId(null)
        const remainingErrors = data.validation?.errors?.length ?? 0
        if (remainingErrors) {
          toast.warning(`Copilot applied fixes — ${remainingErrors} check${remainingErrors === 1 ? '' : 's'} still need attention.`)
        } else {
          toast.success('Copilot applied fixes — review the changes.')
        }
      } else {
        toast.error(data.error || 'Could not fix the flow.')
      }
    } finally {
      setFixing(false)
    }
  }, [graph, validation, commitGraph, viewingVersion, external, canEdit])

  const onCopilotOps = useCallback(
    (ops: CopilotOp[]) => {
      if (viewingVersion) {
        toast.error('Close the version view before applying copilot changes.')
        return { applied: 0, skipped: ops.map(() => ({ reason: 'read-only version view' })) }
      }
      const result = applyCopilotOps(graph, ops)
      if (result.applied > 0) {
        commitGraph(result.graph)
        setSelectedId(null)
        setHighlightIds(result.touchedIds)
        window.clearTimeout(highlightTimer.current)
        highlightTimer.current = window.setTimeout(() => setHighlightIds([]), 2500)
      }
      return { applied: result.applied, skipped: result.skipped.map((s) => ({ reason: s.reason })) }
    },
    [viewingVersion, graph, commitGraph],
  )

  const duplicateFlow = useCallback(async () => {
    const flowName = name.trim() || 'Untitled flow'
    const response = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${flowName} copy`,
        description,
        graph,
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data.flow?.id) {
      toast.success('Flow duplicated.')
      router.push(`/flows/${data.flow.id}`)
    } else {
      toast.error(data.error || 'Could not duplicate the flow.')
    }
  }, [name, description, graph, router])

  const downloadFlow = useCallback(async () => {
    const flowName = name.trim() || 'Untitled flow'
    const response = await fetch(`/api/flows/${id}/export`, { cache: 'no-store' })
    if (!response.ok) return toast.error('Could not export this flow.')
    downloadBlob(await response.text(), 'application/json', `${filenameSlug(flowName)}.backstory.json`)
  }, [id, name])

  // Webhook-trigger flows export with WORKING credentials: a fresh trigger
  // secret is minted (rotating any prior one) and embedded alongside the
  // trigger URL, so the exported file runs against Backstory without the user
  // hunting for credentials. Non-webhook flows (or a failed mint, e.g. a
  // view-only viewer) export without credentials, as before.
  const exportCredentials = useCallback(async (): Promise<{ triggerUrl: string; triggerSecret: string } | undefined> => {
    const triggerNode = graph.nodes.find((n) => n.type === 'trigger')
    const triggerType = triggerNode && 'trigger' in triggerNode.data ? triggerNode.data.trigger?.type : undefined
    if (triggerType !== 'webhook') return undefined
    try {
      const response = await fetch(`/api/flows/${id}/trigger-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotate: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || typeof data.secret !== 'string' || !data.secret) return undefined
      toast('A fresh trigger secret was minted into this export — any previously issued secret no longer works.', { duration: 6000 })
      return { triggerUrl: String(data.url || ''), triggerSecret: data.secret }
    } catch {
      return undefined
    }
  }, [id, graph])

  // Export for n8n: an importable workflow JSON (structural nodes run; agent/
  // tool steps import as flagged No-Op placeholders — see @/lib/flows/export).
  const exportN8n = useCallback(async () => {
    const flowName = name.trim() || 'Untitled flow'
    const credentials = await exportCredentials()
    downloadBlob(JSON.stringify(flowToN8n({ name: flowName, graph, credentials }), null, 2), 'application/json', `${filenameSlug(flowName)}.n8n.json`)
    toast.success('Exported for n8n — import it under Workflows → Import.')
  }, [name, graph, exportCredentials])

  // Export as copilot-ready instructions (Markdown): paste into Zapier/Workato/
  // Make/n8n AI builders, or follow by hand.
  const exportInstructions = useCallback(async () => {
    const flowName = name.trim() || 'Untitled flow'
    const credentials = await exportCredentials()
    downloadBlob(flowToInstructions({ name: flowName, description, graph, credentials }, agents), 'text/markdown', `${filenameSlug(flowName)}.md`)
    toast.success('Exported instructions — paste them into your platform’s AI builder.')
  }, [name, description, graph, agents, exportCredentials])

  const deleteFlow = useCallback(async () => {
    const flowName = name.trim() || 'this flow'
    if (!window.confirm(`Delete "${flowName}"? This cannot be undone.`)) return
    const response = await fetch('/api/flows', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok) {
      toast.success('Flow deleted.')
      router.push('/flows')
    } else {
      toast.error(data.error || 'Could not delete the flow.')
    }
  }, [id, name, router])

  const refreshAgents = useCallback(async () => {
    const data = await fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    if (data?.success) setAgents(data.agents.map((a: Agent) => ({ id: a.id, title: a.title })))
  }, [])

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-3">
          <Skeleton className="h-8 w-64 rounded-lg" />
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="mx-auto h-96 max-w-xl rounded-xl" />
        </div>
      </div>
    )
  }

  if (loadError) {
    const failure = joinErrorMessage(loadError, user?.email ?? null)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
        <div className="max-w-sm space-y-2">
          <h2 className="text-lg font-semibold">{failure.title}</h2>
          <p className="text-sm text-muted-foreground">{failure.body}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Try again</Button>
          {failure.canSwitchAccount && (
            <Button
              variant="outline"
              onClick={() => {
                // Signing in as someone else should resume THIS link, share
                // token and all — an invite usually goes to the work account,
                // not whichever one the browser happens to be signed into.
                const destination = `${window.location.pathname}${window.location.search}`
                void signOut()
                  .catch(() => undefined)
                  .finally(() => { window.location.href = `/auth/login?return_to=${encodeURIComponent(destination)}` })
              }}
            >
              Use a different account
            </Button>
          )}
          <Button variant="outline" onClick={() => router.push('/flows')}>Back to flows</Button>
        </div>
      </div>
    )
  }

  // While viewing a historical snapshot, the canvas renders that version's
  // graph and every mutation path is inert — the live draft (`graph` state)
  // is untouched underneath, so Save/Publish/Run still act on the real draft.
  const canvasGraph = viewingVersion ? viewingVersion.graph : graph

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" onClick={() => router.push('/flows')} aria-label="Back to flows">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-base font-semibold outline-none hover:bg-muted focus:bg-muted"
          placeholder="Untitled flow"
        />
        <Button variant="ghost" size="icon" onClick={undo} aria-label="Undo" title="Undo (⌘Z)">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={redo} aria-label="Redo" title="Redo (⌘⇧Z)">
          <Redo2 className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Flow settings" title="Flow settings">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Flow settings</DropdownMenuLabel>
            {canEdit && !external && (
              <DropdownMenuItem onSelect={openFlowSettings}>
                <FileText className="h-4 w-4" /> Edit details…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={duplicateFlow}>
              <Copy className="h-4 w-4" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSavingTemplate(true)}>
              <BookmarkPlus className="h-4 w-4" /> Save as template…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Export</DropdownMenuLabel>
            <DropdownMenuItem onSelect={downloadFlow}>
              <Download className="h-4 w-4" /> Backstory JSON
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exportN8n}>
              <Download className="h-4 w-4" /> For n8n (importable JSON)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exportInstructions}>
              <FileText className="h-4 w-4" /> As instructions (Markdown)
            </DropdownMenuItem>
            {canEdit && !external && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Sharing</DropdownMenuLabel>
                {([
                  { value: 'shared', label: 'Everyone can edit' },
                  { value: 'view', label: 'Everyone can view, only I edit' },
                  { value: 'private', label: 'Only me' },
                ] as const).map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => void updateSharing(option.value)}
                    className={visibility === option.value ? 'font-semibold text-indigo-700' : undefined}
                  >
                    {visibility === option.value ? '✓ ' : ''}{option.label}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            {!external && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={deleteFlow} className="text-red-600 focus:text-red-700">
                  <Trash2 className="h-4 w-4" /> Delete flow
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Builder view: the inline chain, or the free-form DAG canvas. */}
        <div className="flex items-center rounded-lg border border-border p-0.5" role="tablist" aria-label="Builder view">
          {(['inline', 'canvas'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              onClick={() => changeView(option)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition-colors ${
                view === option ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        {!external && (
          <>
            <Button variant="outline" size="sm" onClick={() => setShowTest((v) => !v)}>
              <FlaskConical className="mr-1.5 h-4 w-4" /> Test
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowRuns((v) => !v)}>
              <ListChecks className="mr-1.5 h-4 w-4" /> Runs
            </Button>
            <Button variant="ghost" size="sm" onClick={() => router.push(`/flows/${id}/activity`)}>
              <ScrollText className="mr-1.5 h-4 w-4" /> Activity
            </Button>
          </>
        )}
        {others.length > 0 && (
          <div className="flex items-center -space-x-1.5" title={`${others.map((p) => p.name).join(', ')} here now`}>
            {others.slice(0, 4).map((p) => (
              <span
                key={p.clientId}
                className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
                style={{ backgroundColor: p.color }}
                title={p.name}
              >
                {p.name.trim().charAt(0).toUpperCase() || '?'}
              </span>
            ))}
            {others.length > 4 && (
              <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground">
                +{others.length - 4}
              </span>
            )}
          </div>
        )}
        {/* Realtime health. Silent when live — the point is that a jam which
            can't connect says so instead of looking like an empty room. */}
        {jamStatus !== 'live' && (
          <span
            title={jamStatus === 'error'
              ? 'The live channel refused the connection. Your edits still save; teammates just won’t see them live.'
              : 'Reconnecting to the live channel…'}
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              jamStatus === 'error'
                ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                : 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'
            }`}
          >
            {jamStatus === 'connecting' ? 'Connecting…' : jamStatus === 'degraded' ? 'Reconnecting…' : 'Live editing unavailable'}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={() => setShowJam(true)}>
          <Users className="mr-1.5 h-4 w-4" /> Jam
          {others.length > 0 && <span className="ml-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">{others.length}</span>}
          {huddleMembers.length > 0 && <Mic className="ml-1.5 h-3.5 w-3.5 text-emerald-600" />}
        </Button>
        {/* The ONE huddle control outside the Jam widget. Muting has to be
            reachable in one action; everything else lives in the dialog. */}
        {huddle.joined && (
          huddle.pttEnabled ? (
            <Button
              variant={huddle.transmitting ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowJam(true)}
              title="Push to talk is on — hold Space to speak"
            >
              <Radio className={cn('mr-1.5 h-4 w-4', huddle.transmitting && 'animate-pulse')} />
              {huddle.transmitting ? 'Live' : 'Hold Space'}
            </Button>
          ) : (
            <Button
              variant={huddle.muted ? 'default' : 'outline'}
              size="sm"
              onClick={huddle.toggleMute}
              aria-label={huddle.muted ? 'Unmute' : 'Mute'}
            >
              {huddle.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          )
        )}
        {!external && (
          <Button variant="outline" size="sm" onClick={() => setShowVersions((v) => !v)}>
            <History className="mr-1.5 h-4 w-4" /> History
          </Button>
        )}
        {canEdit && (
          <Button variant="outline" size="sm" onClick={() => setShowCopilot((v) => !v)}>
            <Sparkles className="mr-1.5 h-4 w-4" /> Copilot
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setShowChecker((v) => !v)}>
          <ShieldCheck className="mr-1.5 h-4 w-4" /> Checker
          {validation.errors.length > 0 && (
            <Badge variant="risk" className="ml-1.5">{validation.errors.length}</Badge>
          )}
          {validation.errors.length === 0 && validation.warnings.length > 0 && (
            <Badge variant="warn" className="ml-1.5">{validation.warnings.length}</Badge>
          )}
        </Button>
        {!external && (
          <>
            <Button variant="outline" size="sm" onClick={save} loading={saving} className="relative">
              <Save className="mr-1.5 h-4 w-4" /> Save
              {dirty && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-400" title="Unsaved changes" />}
            </Button>
            {published && !dirty && !unpublishedChanges ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => publish('unpublish')}
                loading={publishing}
                title={`Published v${version} — unpublish to stop it running`}
              >
                Unpublish
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => publish()}
                loading={publishing}
                title={published ? `Published v${version} — publish your changes as v${version + 1}` : 'Not yet published'}
              >
                Publish
              </Button>
            )}
            {published && (dirty || unpublishedChanges) && (
              <Button variant="ghost" size="sm" onClick={() => publish('revert')} title="Discard draft changes and restore the published version">
                Revert
              </Button>
            )}
            <Button size="sm" onClick={run} disabled={running}>
              {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />} Run
            </Button>
          </>
        )}
      </div>

      {viewingVersion && (
        <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
          <span>Viewing v{viewingVersion.version} — read-only</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => restoreVersion(viewingVersion.version)}>
              Restore this version
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setViewingVersion(null)}>
              Close
            </Button>
          </div>
        </div>
      )}

      {/* The live channel is authorized by Postgres and fails CLOSED, so a
          refusal is stated plainly rather than degrading into a silently
          single-player builder. Saving is unaffected either way. */}
      {jamStatus === 'error' && (
        <div className="flex items-center justify-center gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs font-medium text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
          Live collaboration is unavailable — your changes still save, but teammates won’t see them until this reconnects.
        </div>
      )}

      {external && (
        <div className="flex items-center justify-center gap-2 border-b border-indigo-200 bg-indigo-50 px-4 py-1.5 text-xs font-medium text-indigo-800 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
          Guest access — you’re jamming on another workspace’s flow. Running and publishing stay with the owning workspace.
        </div>
      )}
      {!canEdit && !external && (
        <div className="flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          View only — you can run this flow, but only its owner can edit it.
        </div>
      )}

      {/* Body: canvas + optional drawer + optional copilot */}
      <div className="relative flex min-h-0 flex-1">
        {view === 'canvas' && (
          <div className="min-w-0 flex-1 bg-white">
            <GraphCanvas
              graph={canvasGraph}
              agentName={agentNameOf}
              agents={agents}
              toolCatalog={toolCatalog}
              labelCtx={labelCtx}
              published={published}
              statusByNode={viewingVersion ? {} : statusByNode}
              issuesByNode={viewingVersion ? undefined : issuesByNode}
              highlightIds={viewingVersion ? [] : selectedIds.length > 1 ? selectedIds : highlightIds}
              selectedId={selectedId}
              selectedIds={selectedIds}
              remoteSelections={viewingVersion ? undefined : remoteSelections}
              cursors={viewCursors}
              dragPreview={dragPreview}
              focusRequest={focusRequest}
              readOnly={Boolean(viewingVersion) || !canEdit}
              onSelectionChange={canvasSelectionChange}
              onOpenNode={canvasOpenNode}
              onMoveNodes={canvasMoveNodes}
              onConnectNodes={canvasConnect}
              onDeleteEdge={canvasDeleteEdge}
              onInsertFromHandle={canvasInsertFromHandle}
              onInsertOnEdge={canvasInsertOnEdge}
              onTidyUp={canvasTidyUp}
              onCopySelection={canvasCopy}
              onPasteAt={canvasPaste}
              onCursorMove={(position) => sendCursor(position.x, position.y, 'canvas')}
              onNodeDrag={sendNodeDrag}
            />
          </div>
        )}

        <div
          ref={canvasScrollRef}
          className={`min-w-0 flex-1 overflow-auto bg-white p-8 ${view === 'canvas' ? 'hidden' : ''} ${canvasPan.panning ? 'cursor-grabbing select-none' : 'cursor-grab'}`}
          onClick={() => { if (!canvasPan.consumeMoved()) setSelectedId(null) }}
          {...canvasPan.handlers}
          onPointerMove={onCanvasPointerMove}
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(15, 23, 42, 0.22) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        >
          <div
            ref={canvasContentRef}
            className="relative"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', width: `${100 / zoom}%`, marginLeft: `${(1 - 1 / zoom) * 50}%` }}
          >
            <CursorLayer cursors={viewCursors} />
            <FlowCanvas
              graph={canvasGraph}
              agentName={agentNameOf}
              agents={agents}
              members={members}
              toolCatalog={toolCatalog}
              dataFields={dataFields}
              labelCtx={labelCtx}
              variableNames={upstreamVariables.map((variable) => variable.name)}
              flowId={id}
              published={published}
              onFlowPersisted={(updatedAt) => { baseUpdatedAt.current = updatedAt }}
              statusByNode={viewingVersion ? {} : statusByNode}
              issuesByNode={viewingVersion ? undefined : issuesByNode}
              highlightIds={viewingVersion ? [] : selectedIds.length > 1 ? selectedIds : highlightIds}
              selectedId={selectedId}
              remoteSelections={viewingVersion ? undefined : remoteSelections}
              onSelect={viewingVersion ? () => {} : handleSelect}
              onBackgroundClick={() => setSelectedId(null)}
              onMakeSubflow={viewingVersion ? undefined : (startId) => setSubflowDraft({ startId, endId: startId, name: '' })}
              onChangeNode={viewingVersion ? () => {} : commitFieldEdit}
              onInsertAfter={
                viewingVersion
                  ? () => {}
                  : (afterId, type, seed) => {
                      const { graph: inserted, nodeId } = insertNodeAfter(graph, afterId, type, type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined)
                      const next = applyInsertSeed(inserted, nodeId, seed)
                      commitGraph(next)
                      setSelectedId(nodeId)
                    }
              }
              onAppendBranch={
                viewingVersion
                  ? () => {}
                  : (conditionId, branch, type, seed) => {
                      const { graph: inserted, nodeId } = appendToBranch(graph, conditionId, branch, type, type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined)
                      const next = applyInsertSeed(inserted, nodeId, seed)
                      commitGraph(next)
                      setSelectedId(nodeId)
                    }
              }
              onRefreshAgents={refreshAgents}
              onDuplicateNode={
                viewingVersion
                  ? () => {}
                  : (nodeId) => {
                      const { graph: next, nodeId: newId } = duplicateNode(graph, nodeId)
                      commitGraph(next)
                      setSelectedId(newId)
                    }
              }
              onDeleteNode={
                viewingVersion
                  ? () => {}
                  : (nodeId) => {
                      commitGraph(deleteNode(graph, nodeId))
                      if (selectedId === nodeId) setSelectedId(null)
                    }
              }
              onPickTrigger={
                viewingVersion
                  ? () => {}
                  : (type) => {
                      const triggerNode = graph.nodes.find((n) => n.type === 'trigger')
                      if (!triggerNode || triggerNode.type !== 'trigger') return
                      const current = isRecordLike(triggerNode.data.trigger) ? triggerNode.data.trigger : {}
                      // Schedule + poll both need a schedule to be due — seed a
                      // sensible default so the trigger is valid on first pick.
                      const seed =
                        (type === 'schedule' || type === 'poll') && !isRecordLike((current as { schedule?: unknown }).schedule)
                          ? { schedule: { type: type === 'poll' ? 'hourly' : 'daily', time: '09:00', timezone: 'UTC', isActive: true } }
                          : {}
                      commitGraph(updateNode(graph, { ...triggerNode, data: { trigger: { ...current, ...seed, type } } }))
                      setSelectedId(triggerNode.id)
                    }
              }
              onMoveAfter={viewingVersion ? () => {} : (nodeId, afterId) => commitGraph(moveNodeAfter(graph, nodeId, afterId))}
              onReorderContainer={
                viewingVersion
                  ? () => {}
                  : (containerId, from, to, branchIndex) => commitGraph(moveContainerStep(graph, containerId, from, to, branchIndex))
              }
            />
          </div>
        </div>

        {selectedIds.length > 1 && !viewingVersion && (
          <div className="pointer-events-auto fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
            <span className="text-sm font-medium">{selectedIds.length} steps selected</span>
            <Button size="sm" variant="outline" onClick={bulkDuplicate}>Duplicate</Button>
            <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700" onClick={bulkDelete}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>Clear</Button>
          </div>
        )}

        {view === 'inline' && (
        <CanvasRail
          zoom={zoom}
          onZoom={setZoom}
          onFit={() => {
            setZoom(1)
            canvasScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
          }}
          nodes={canvasGraph.nodes.filter((n) => n.type !== 'trigger').map((n) => ({ id: n.id, title: labelForNode(n.id) }))}
          onJump={jumpToNode}
        />
        )}

        {drawerNode && !viewingVersion && (
          <div
            className="fixed inset-0 z-50 bg-slate-950/55 p-2 backdrop-blur-sm md:p-3"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSelectedId(null)
            }}
          >
            <div className="mx-auto h-full w-full max-w-[1800px]" onMouseDown={(event) => event.stopPropagation()}>
              <StepDrawer
                layout="workspace"
                node={drawerNode}
                flowId={id}
                issues={issuesByNode[drawerNode.id]?.items}
                agents={agents}
                members={members}
                toolCatalog={toolCatalog}
                dataFields={dataFields}
                published={published}
                onFlowPersisted={(updatedAt) => { baseUpdatedAt.current = updatedAt }}
                labelCtx={labelCtx}
                previewCtx={previewCtx}
                variableNames={upstreamVariables.map((variable) => variable.name)}
                rawInput={selectedNodeRawInput}
                rawOutput={selectedNodeRawOutput}
                rawLogs={selectedNodeRawLogs}
                mockData={graph.pinData?.[drawerNode.id]}
                navigation={drawerNavigation}
                onNavigate={(nodeId) => {
                  // Move the canvas selection with the drawer, so closing it
                  // leaves the user on the step they navigated to.
                  jumpToNode(nodeId)
                  setOpenNodeId(nodeId)
                  setSelectedIds([])
                }}
                onExecuteStep={() => void runPartial(drawerNode.id, 'stopAfter')}
                onExecuteOnly={selectedRun?.id ? () => void runPartial(drawerNode.id, 'only') : undefined}
                onExecutePrevious={() => void runPartial(drawerNode.id, 'stopBefore')}
                onSetMockData={(value) => setNodeMockData(drawerNode.id, value)}
                onChange={commitFieldEdit}
                onChangeType={(type) => commitGraph(changeNodeType(graph, drawerNode.id, type))}
                onDuplicate={() => {
                  const { graph: next, nodeId } = duplicateNode(graph, drawerNode.id)
                  commitGraph(next)
                  setSelectedId(nodeId)
                }}
                onAddStep={
                  drawerNode.type === 'loop' || drawerNode.type === 'parallel'
                    ? (type) => {
                        const { graph: next, nodeId } = addContainerStep(graph, drawerNode.id, type, type === 'agent' ? agents[0]?.id ?? '' : undefined)
                        commitGraph(next)
                        setSelectedId(nodeId)
                      }
                    : undefined
                }
                onDelete={() => {
                  commitGraph(deleteNode(graph, drawerNode.id))
                  closeDrawer()
                }}
                onClose={closeDrawer}
              />
            </div>
          </div>
        )}

        {showCopilot && canEdit && (
          <ResizablePanel storageKey="flow.copilotWidth">
            <CopilotPanel
              graph={graph}
              external={external}
              onOps={onCopilotOps}
              onJump={jumpToNode}
              onGraph={(next) => {
                // Read-only version viewing: never let a generated graph
                // silently replace the live draft under the read-only banner.
                if (viewingVersion) {
                  toast.error('Close the version view before generating a flow.')
                  return
                }
                commitGraph(next as FlowGraph)
                setSelectedId(null)
                // Keep Copilot open so the user can keep iterating on the draft.
              }}
              onNeedsAttention={(issues) => {
                if (issues.length) setShowChecker(true)
              }}
            />
          </ResizablePanel>
        )}

        {showTest && (
          <ResizablePanel storageKey="flow.testWidth">
            <TestPanel
              fields={inputFields}
              value={testInput}
              onChange={setTestInput}
              onRun={run}
              running={running}
              steps={(selectedRun?.steps ?? []).map((s) => ({ nodeId: s.nodeId, status: s.status }))}
              labelForNode={labelForNode}
              onInspect={() => setShowRuns(true)}
              onClose={() => setShowTest(false)}
            />
          </ResizablePanel>
        )}

        {showRuns && (
          <ResizablePanel storageKey="flow.runsWidth">
            <RunPanel
              runs={runs}
              selected={selectedRun}
              onSelectRun={selectRun}
              onClose={() => setShowRuns(false)}
              labelForNode={labelForNode}
              onReply={replyToRun}
              onRerunFrom={(runId, nodeId) => void rerunFromStep(runId, nodeId)}
              onForkWithEdits={(runId, nodeId, recordedOutput, runFailed) =>
                void forkWithEdits(runId, nodeId, recordedOutput, runFailed)
              }
            />
          </ResizablePanel>
        )}

        {showChecker && (
          <ResizablePanel storageKey="flow.checkerWidth">
            <CheckerPanel
              validation={validation}
              fixing={fixing}
              onFixWithCopilot={fixWithCopilot}
              canFix={canEdit && !external}
              onClose={() => setShowChecker(false)}
              onJump={jumpToNode}
            />
          </ResizablePanel>
        )}

        {showVersions && (
          <ResizablePanel storageKey="flow.versionsWidth">
            <VersionsPanel
              flowId={id}
              currentVersion={version}
              onView={viewVersion}
              onRestore={restoreVersion}
              onClose={() => setShowVersions(false)}
            />
          </ResizablePanel>
        )}
      </div>

      <JamDialog
        open={showJam}
        onOpenChange={setShowJam}
        flowId={id}
        flowName={name}
        visibility={visibility as 'shared' | 'view' | 'private'}
        canEdit={canEdit && !external}
        onChangeVisibility={(next) => void updateSharing(next)}
        presence={others.map((p) => ({
          id: p.clientId,
          name: p.name,
          color: p.color,
          inHuddle: p.inHuddle,
          view: p.view,
          ...describeParticipantView(p, view),
        }))}
        onFollow={(target) => { setShowJam(false); changeView(target) }}
        huddle={huddle}
        huddleMembers={huddleMembers}
        selfClientId={selfClientId}
        capture={huddleCapture}
        shareToken={shareToken}
        shareRole={shareRole}
        shareAnonymous={shareAnonymous}
        anonymousViews={anonymousViews}
        onShareChanged={(token, role, anonymous, views) => {
          setShareToken(token)
          setShareRole(role)
          setShareAnonymous(anonymous)
          setAnonymousViews(views)
        }}
      />

      <SaveAsTemplateDialog
        open={savingTemplate}
        onOpenChange={setSavingTemplate}
        flowId={id}
        flowName={name}
        flowDescription={description}
        graph={graph}
      />

      <Dialog open={showFlowSettings} onOpenChange={setShowFlowSettings}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Flow settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Name</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={settingsDraft.name}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Description</span>
              <Textarea
                rows={3}
                value={settingsDraft.description}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder="What this flow does and when to use it."
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Folder</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={settingsDraft.folder}
                maxLength={60}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, folder: event.target.value }))}
                placeholder="Optional"
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFlowSettings(false)}>Cancel</Button>
            <Button onClick={() => void saveFlowSettings()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {subflowDraft && (() => {
        // Every main-chain step from the picked start downward is a legal end.
        const candidates: string[] = []
        const guard = new Set<string>()
        let cursor: string | null = subflowDraft.startId
        while (cursor && !guard.has(cursor)) {
          guard.add(cursor)
          candidates.push(cursor)
          const edge = graph.edges.find((e) => e.source === cursor && !e.branch)
          cursor = edge ? edge.target : null
        }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => setSubflowDraft(null)}>
            <div className="w-full max-w-md rounded-2xl border border-border bg-background p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
              <p className="text-sm font-semibold">Make a subflow</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Moves the selected steps into their own flow and runs it here as one step.
              </p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium">From</label>
                  <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-sm">{labelForNode(subflowDraft.startId)}</p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium" htmlFor="subflow-end">Through</label>
                  <select
                    id="subflow-end"
                    className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
                    value={subflowDraft.endId}
                    onChange={(event) => setSubflowDraft({ ...subflowDraft, endId: event.target.value })}
                  >
                    {candidates.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {labelForNode(candidate)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium" htmlFor="subflow-name">Name the new flow</label>
                  <input
                    id="subflow-name"
                    className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
                    value={subflowDraft.name}
                    placeholder={`${name || 'Flow'}: ${labelForNode(subflowDraft.startId)}`}
                    onChange={(event) => setSubflowDraft({ ...subflowDraft, name: event.target.value })}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setSubflowDraft(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" loading={makingSubflow} onClick={() => void makeSubflow()}>
                    Create subflow
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// useSearchParams needs a Suspense boundary — same pattern as the other pages.
export default function FlowBuilderPage() {
  return (
    <Suspense fallback={null}>
      <FlowBuilder />
    </Suspense>
  )
}
