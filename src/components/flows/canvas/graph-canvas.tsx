'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
  useViewport,
  ViewportPortal,
  type Connection,
  type FinalConnectionState,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Hand, LayoutGrid, Maximize2, MousePointer2, Plus, Sparkles, Workflow, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Aurora } from '@/components/ui/motion-primitives'
import { Button } from '@/components/ui/button'
import { NON_EXECUTABLE_NODE_TYPES } from '@/lib/flows/graph'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import type { StepType } from '@/lib/flows/mutate'
import { canConnect } from '@/lib/flows/mutate'
import { layoutGraph, type NodePosition } from '@/lib/flows/layout'
import {
  baseHandleId,
  edgeRunStates,
  hasTargetHandle,
  outerEdges,
  outerNodes,
  placeDownstreamOf,
  sourceHandleOf,
  sourceHandlesFor,
} from '@/lib/flows/canvas-model'
import { subtitleFor, titleFor, type StepStatus } from '@/lib/flows/node-presentation'
import { selectedToolPresentation, stepBrandFallback, toolConnectionBrand } from '@/lib/flows/tool-presentation'
import { humanizeTokens, type TokenLabelContext } from '@/lib/flows/token-text'
import type { RemoteCursor } from '@/lib/flows/cursor-store'
import type { DragPreview } from '@/lib/flows/drag-preview'
import { CursorLayer } from '@/components/flows/cursor-layer'
import { FlowPicker } from '@/components/flows/flow-picker'
import type { FlowInsertSeed } from '@/components/flows/flow-canvas'
import type { ToolCatalog } from '@/components/flows/step-drawer'
import { CanvasActionsContext, StepNode, type StepFlowNode } from './step-node'
import { StepEdge, FlowEdgeMarkerDefs, type StepFlowEdge } from './step-edge'
import { useHoldToPan } from './use-hold-to-pan'

/**
 * The n8n-style graph editor. Steps are compact chips positioned freely;
 * connections are drawn between handles, so one step can fan out to several
 * downstream paths — which the scheduler already executes concurrently.
 *
 * This component owns viewport, selection and the insert picker. It owns NO
 * graph mutations: every structural change is reported upward so the page
 * applies it through its single `commitGraph` entry point, keeping undo/redo
 * and the jam broadcast working unchanged.
 */

type Agent = { id: string; title: string; icon?: string }

export type GraphCanvasProps = {
  graph: FlowGraph
  agentName: (agentId: string) => string
  agents: Agent[]
  toolCatalog: ToolCatalog
  labelCtx?: TokenLabelContext
  published?: boolean
  statusByNode: Record<string, StepStatus>
  issuesByNode?: Record<string, { errors: number; warnings: number }>
  highlightIds?: string[]
  selectedId: string | null
  selectedIds: string[]
  remoteSelections?: Record<string, { name: string; color: string }[]>
  cursors?: RemoteCursor[]
  /** Positions of nodes a teammate is dragging RIGHT NOW. Applied to the
   *  canvas only — never to the graph, which the op on release commits. */
  dragPreview?: DragPreview
  /** Center the viewport on a step (search, copilot jump). The nonce makes a
   *  repeat jump to the same step re-center rather than no-op. */
  focusRequest?: { id: string; nonce: number } | null
  readOnly?: boolean
  onSelectionChange: (ids: string[]) => void
  onOpenNode: (nodeId: string) => void
  /** A completed click — never fired when the pointer dragged past the drag
   *  threshold, unlike `onSelectionChange`, which fires on mousedown. Anything
   *  that opens UI on a single click must hang off this, not selection. */
  onNodeClick?: (nodeId: string) => void
  onMoveNodes: (positions: Map<string, NodePosition>) => void
  onConnectNodes: (source: string, target: string, branch?: string) => void
  onDeleteEdge: (edgeId: string) => void
  onInsertFromHandle: (
    sourceId: string,
    branch: string | undefined,
    position: NodePosition,
    type: StepType,
    seed?: FlowInsertSeed,
  ) => void
  onInsertOnEdge: (edgeId: string, position: NodePosition, type: StepType, seed?: FlowInsertSeed) => void
  /** Create a step at a free canvas position wired to NOTHING — the top-right
   *  "+" button. The user connects it (or leaves it parked) afterwards. */
  onInsertStandalone?: (position: NodePosition, type: StepType, seed?: FlowInsertSeed) => void
  /** Open the Copilot panel — the empty canvas offers it as the "describe it
   *  instead" path to a first draft. */
  onOpenCopilot?: () => void
  onTidyUp: () => void
  onCopySelection: () => void
  onPasteAt: (position: NodePosition) => void
  onCursorMove?: (position: NodePosition) => void
  /** Fires continuously while a node is dragged, then once with `done` on
   *  release, so teammates see the move instead of a teleport. */
  onNodeDrag?: (nodeId: string, position: NodePosition, done: boolean) => void
  /** Commit a field edit from canvas sub-node controls (agent chat model / memory / tools). */
  onChangeNode?: (node: FlowNode) => void
}

const nodeTypes = { step: StepNode }
const edgeTypes = { step: StepEdge }

/** Where an insert picker is open, and what it will do on pick. */
type PickerState = {
  position: NodePosition
  target:
    | { kind: 'handle'; sourceId: string; branch?: string }
    | { kind: 'edge'; edgeId: string }
    | { kind: 'standalone' }
}

/** The graph branch a connection drag encodes. A drag can start from a plain
 *  source handle OR from its `+` stub — the stub's id carries a suffix that
 *  `baseHandleId` maps back to the same branch; `out` means no branch. */
function branchOfHandle(handleId: string | null | undefined): string | undefined {
  const base = handleId ? baseHandleId(handleId) : undefined
  return base && base !== 'out' ? base : undefined
}

const MINIMAP_COLOR: Record<string, string> = {
  running: '#fbbf24',
  succeeded: '#10b981',
  failed: '#ef4444',
  waiting: '#3b82f6',
  skipped: '#cbd5e1',
  stopped: '#64748b',
}

function GraphCanvasInner(props: GraphCanvasProps) {
  const {
    graph,
    agentName,
    agents,
    toolCatalog,
    labelCtx,
    published,
    statusByNode,
    issuesByNode,
    highlightIds,
    selectedId,
    selectedIds,
    remoteSelections,
    cursors,
    focusRequest,
    readOnly,
    onSelectionChange,
    onOpenNode,
    onNodeClick,
    onMoveNodes,
    onConnectNodes,
    onDeleteEdge,
    onInsertFromHandle,
    onInsertOnEdge,
    onInsertStandalone,
    onOpenCopilot,
    onTidyUp,
    onCopySelection,
    onPasteAt,
    onCursorMove,
    onNodeDrag,
    onChangeNode,
    dragPreview,
  } = props

  const wrapperRef = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition, fitView, zoomIn, zoomOut } = useReactFlow()
  const storeApi = useStoreApi()
  const { zoom } = useViewport()
  const [picker, setPicker] = useState<PickerState | null>(null)
  const pickerElRef = useRef<HTMLDivElement>(null)

  // No executable steps yet — the canvas is a dot grid plus a trigger, so the
  // first-run invitation below is the only visible next action.
  const emptyGraph = graph.nodes.every((node) => NON_EXECUTABLE_NODE_TYPES.has(node.type))

  // The picker's position is owned by its classes (anchored top-right); this
  // effect only bounds its height. Keep the 72vh cap, but a short canvas
  // (split panes, small windows) tightens it further so the popover always
  // fits inside the wrapper.
  useLayoutEffect(() => {
    if (!picker) return
    const el = pickerElRef.current
    const wrapper = wrapperRef.current
    if (!el || !wrapper) return
    const clamp = () => {
      const margin = 16
      el.style.maxHeight = `${Math.min(Math.round(window.innerHeight * 0.72), Math.max(200, wrapper.clientHeight - margin * 2))}px`
    }
    clamp()
    const observer = new ResizeObserver(clamp)
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [picker])
  /** Hand tool: plain left-drag pans instead of marquee-selecting. */
  const [handTool, setHandTool] = useState(false)
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<StepFlowNode>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<StepFlowEdge>([])
  /** Last pointer position in flow coordinates — where a paste lands. */
  const pointerRef = useRef<NodePosition>({ x: 0, y: 0 })
  const selectedEdgeIdsRef = useRef<string[]>([])

  // Positions: persisted where the user arranged them, dagre-computed for the
  // rest. Never committed on open — merely viewing a flow must not dirty it.
  const positions = useMemo(() => layoutGraph(graph), [graph])

  const humanize = useCallback(
    (value?: string) => (value && labelCtx ? humanizeTokens(value, labelCtx) : value),
    [labelCtx],
  )

  const presentation = useMemo(
    () => ({ agentName, toolCatalog, published }),
    [agentName, toolCatalog, published],
  )

  // The selection the page wants, kept in a ref rather than read as a dep.
  //
  // Selection has three writers — React Flow's own store (click/marquee), the
  // `selected` flag written when nodes are rebuilt, and the page state that
  // `onSelectionChange` feeds. When the rebuild re-asserted selection, React
  // Flow echoed the write back through `onSelectionChange`, the page adopted
  // the echo as user intent, and that rewrote the nodes again: opening a node
  // ping-ponged selected → [] → selected until React threw "Maximum update
  // depth exceeded" and the builder fell into its error boundary.
  //
  // Reading through a ref keeps selection OUT of the rebuild's dependencies, so
  // React Flow stays the single owner of what's selected; the effect below only
  // reconciles when the page and the canvas genuinely disagree.
  const selectionRef = useRef<Set<string>>(new Set())
  selectionRef.current = new Set(selectedIds.length ? selectedIds : selectedId ? [selectedId] : [])

  const buildNodes = useCallback((): StepFlowNode[] => {
    const selection = selectionRef.current
    const connectedHandles = new Map<string, Set<string>>()
    for (const edge of outerEdges(graph)) {
      const handles = connectedHandles.get(edge.source) ?? new Set<string>()
      handles.add(sourceHandleOf(edge))
      connectedHandles.set(edge.source, handles)
    }
    return outerNodes(graph).map((node: FlowNode) => {
      // Catalog identity first (a bound connection knows its provider); fall
      // back to the step's own signals (tool name, note, URL host) so unbound
      // imports and branded API calls still show the company logo.
      const brand =
        (node.type === 'tool'
          ? selectedToolPresentation(toolCatalog, node.data.connectionId, node.data.toolName).brand
          : undefined) ?? stepBrandFallback(node as { type: string; data: Record<string, unknown> })
      return {
        id: node.id,
        type: 'step' as const,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        selected: selection.has(node.id),
        deletable: node.type !== 'trigger',
        data: {
          node,
          title: humanize(titleFor(node, presentation)) ?? '',
          subtitle: humanize(subtitleFor(node, presentation)),
          status: statusByNode[node.id],
          issues: issuesByNode?.[node.id],
          handles: sourceHandlesFor(node),
          hasTarget: hasTargetHandle(node),
          connected: [...(connectedHandles.get(node.id) ?? [])],
          bodyCount:
            node.type === 'loop'
              ? node.data.body.length
              : node.type === 'parallel'
                ? node.data.branches.flat().length
                : undefined,
          editors: remoteSelections?.[node.id],
          brand: brand ? { slug: brand.slug, label: brand.label } : undefined,
          emoji: node.type === 'agent' ? agents.find((agent) => agent.id === node.data.agentId)?.icon || undefined : undefined,
          highlighted: highlightIds?.includes(node.id),
        },
      }
    })
  }, [
    graph,
    positions,
    presentation,
    humanize,
    statusByNode,
    issuesByNode,
    highlightIds,
    remoteSelections,
    toolCatalog,
    agents,
  ])

  const buildEdges = useCallback((): StepFlowEdge[] => {
    const states = edgeRunStates(graph, statusByNode)
    return outerEdges(graph).map((edge) => ({
      id: edge.id,
      type: 'step' as const,
      source: edge.source,
      target: edge.target,
      sourceHandle: sourceHandleOf(edge),
      targetHandle: 'in',
      data: { isError: edge.branch === 'error', state: states.get(edge.id) ?? 'idle' },
    }))
  }, [graph, statusByNode])

  useEffect(() => {
    setRfNodes(buildNodes())
  }, [buildNodes, setRfNodes])

  useEffect(() => {
    setRfEdges(buildEdges())
  }, [buildEdges, setRfEdges])

  // Push the page's selection onto the canvas only where the two disagree, and
  // return the SAME array when they don't. An unconditional rebuild here would
  // re-enter the feedback loop described above; bailing out means a selection
  // that originated in React Flow round-trips to no-op instead of echoing.
  useEffect(() => {
    setRfNodes((nodes) => {
      let changed = false
      const next = nodes.map((node) => {
        const selected = selectionRef.current.has(node.id)
        if (node.selected === selected) return node
        changed = true
        return { ...node, selected }
      })
      return changed ? next : nodes
    })
  }, [selectedId, selectedIds, setRfNodes])

  // A teammate's in-flight drag moves their node here without touching the
  // graph. Same shape as the selection sync above: write only where the two
  // disagree and return the SAME array otherwise, so this can't re-enter the
  // rebuild feedback loop.
  useEffect(() => {
    if (!dragPreview || Object.keys(dragPreview).length === 0) return
    setRfNodes((nodes) => {
      let changed = false
      const next = nodes.map((node) => {
        const preview = dragPreview[node.id]
        if (!preview || (node.position.x === preview.x && node.position.y === preview.y)) return node
        changed = true
        return { ...node, position: { x: preview.x, y: preview.y } }
      })
      return changed ? next : nodes
    })
  }, [dragPreview, setRfNodes])

  useEffect(() => {
    if (!focusRequest) return
    void fitView({ nodes: [{ id: focusRequest.id }], maxZoom: 1.2, duration: 300 })
  }, [focusRequest, fitView])

  // ── Insert picker ───────────────────────────────────────────────────────────

  const openPicker = useCallback(
    (position: NodePosition, target: PickerState['target']) => {
      if (readOnly) return
      setPicker({ position, target })
    },
    [readOnly],
  )

  const handleAddFrom = useCallback(
    (sourceId: string, branch: string | undefined) => {
      openPicker(placeDownstreamOf(sourceId, positions), { kind: 'handle', sourceId, branch })
    },
    [openPicker, positions],
  )

  const handleInsertOnEdge = useCallback(
    (edgeId: string) => {
      const edge = graph.edges.find((candidate) => candidate.id === edgeId)
      if (!edge) return
      const source = positions.get(edge.source)
      const target = positions.get(edge.target)
      const midpoint =
        source && target
          ? { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 }
          : placeDownstreamOf(edge.source, positions)
      openPicker(midpoint, { kind: 'edge', edgeId })
    },
    [graph.edges, positions, openPicker],
  )

  const pick = useCallback(
    (type: StepType, seed?: FlowInsertSeed) => {
      if (!picker) return
      if (picker.target.kind === 'handle') {
        onInsertFromHandle(picker.target.sourceId, picker.target.branch, picker.position, type, seed)
      } else if (picker.target.kind === 'edge') {
        onInsertOnEdge(picker.target.edgeId, picker.position, type, seed)
      } else {
        onInsertStandalone?.(picker.position, type, seed)
      }
      setPicker(null)
    },
    [picker, onInsertFromHandle, onInsertOnEdge, onInsertStandalone],
  )

  /** Top-right "+": drop an unconnected step at the center of the viewport. */
  const handleAddStandalone = useCallback(() => {
    const wrapper = wrapperRef.current?.getBoundingClientRect()
    const position = wrapper
      ? screenToFlowPosition({ x: wrapper.left + wrapper.width / 2, y: wrapper.top + wrapper.height / 2 })
      : { x: 0, y: 0 }
    openPicker({ x: Math.round(position.x), y: Math.round(position.y) }, { kind: 'standalone' })
  }, [openPicker, screenToFlowPosition])

  // Branding for the agent sub-node "Tool" port menu (grantable connections).
  const toolConnections = useMemo(
    () => toolCatalog.map((connection) => ({ id: connection.id, name: connection.name || connection.id, slug: toolConnectionBrand(connection).slug })),
    [toolCatalog],
  )

  const actions = useMemo(
    () => ({ onAddFrom: handleAddFrom, onInsertOnEdge: handleInsertOnEdge, onDeleteEdge, readOnly, onChangeNode, toolConnections, labelCtx }),
    [handleAddFrom, handleInsertOnEdge, onDeleteEdge, readOnly, onChangeNode, toolConnections, labelCtx],
  )

  // ── React Flow handlers ─────────────────────────────────────────────────────

  const isValidConnection = useCallback(
    (connection: Connection | { source: string; target: string; sourceHandle?: string | null }) => {
      if (!connection.source || !connection.target) return false
      return canConnect(graph, connection.source, connection.target, branchOfHandle(connection.sourceHandle))
    },
    [graph],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      onConnectNodes(connection.source, connection.target, branchOfHandle(connection.sourceHandle))
    },
    [onConnectNodes],
  )

  /** Released on empty canvas: offer to create the step right there. */
  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (readOnly || state.toNode || !state.fromNode) return
      const point = 'changedTouches' in event ? event.changedTouches[0] : event
      const position = screenToFlowPosition({ x: point.clientX, y: point.clientY })
      openPicker(position, {
        kind: 'handle',
        sourceId: state.fromNode.id,
        branch: branchOfHandle(state.fromHandle?.id),
      })
    },
    [openPicker, readOnly, screenToFlowPosition],
  )

  const handleSelectionChange = useCallback(
    ({ nodes, edges }: OnSelectionChangeParams) => {
      selectedEdgeIdsRef.current = edges.map((edge) => edge.id)
      const ids = nodes.map((node) => node.id)
      // Compared against the ref, not the props captured when this callback was
      // memoized: a stale copy reports "changed" for a selection the page has
      // already applied, which is the echo that drove the render loop.
      const current = selectionRef.current
      const same = ids.length === current.size && ids.every((id) => current.has(id))
      if (!same) onSelectionChange(ids)
    },
    [onSelectionChange],
  )

  const handleNodeDragStop = useCallback(() => {
    const moved = new Map<string, NodePosition>()
    for (const node of rfNodes) moved.set(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) })
    onMoveNodes(moved)
    // Clear teammates' previews for these nodes; the committed op that
    // onMoveNodes broadcasts is now the authority on where they sit.
    for (const [nodeId, position] of moved) onNodeDrag?.(nodeId, position, true)
  }, [rfNodes, onMoveNodes, onNodeDrag])

  const handleNodeDrag = useCallback<NonNullable<React.ComponentProps<typeof ReactFlow<StepFlowNode, StepFlowEdge>>['onNodeDrag']>>(
    (_event, node) => {
      onNodeDrag?.(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }, false)
    },
    [onNodeDrag],
  )

  // Press-and-hold on empty canvas converts the drag into a pan (a quick drag
  // still marquee-selects). Redundant while the hand tool already pans.
  const holdPanning = useHoldToPan(wrapperRef, {
    enabled: !handTool,
    panBy: (delta) => void storeApi.getState().panBy(delta),
    // Drop the pane's pending zero-size selection rect so releasing the hold
    // doesn't read back as a pane click (which would deselect).
    onEngage: () => storeApi.setState({ userSelectionRect: null }),
  })

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      pointerRef.current = position
      onCursorMove?.(position)
    },
    [screenToFlowPosition, onCursorMove],
  )

  // Canvas-owned keyboard: edge delete (the page's handler owns node delete, so
  // deletions keep going through `deleteNode`'s chain healing) and
  // position-aware copy/paste.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key.toLowerCase() === 'h') setHandTool(true)
        if (event.key.toLowerCase() === 'v') setHandTool(false)
      }
      if (readOnly) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.metaKey && !event.ctrlKey) {
        const edgeIds = selectedEdgeIdsRef.current
        if (edgeIds.length) {
          event.preventDefault()
          for (const edgeId of edgeIds) onDeleteEdge(edgeId)
        }
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        onCopySelection()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        onPasteAt(pointerRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDeleteEdge, onCopySelection, onPasteAt, readOnly])

  return (
    <div
      ref={wrapperRef}
      className={cn('relative h-full w-full', holdPanning && '[&_.react-flow__pane]:!cursor-grabbing')}
      onPointerMove={handlePointerMove}
    >
      {/* Ambient depth behind the first-run invitation; sits under the (transparent)
          React Flow pane so the dot grid draws over it. */}
      {emptyGraph && !readOnly && <Aurora intensity={0.55} />}
      <FlowEdgeMarkerDefs />
      <CanvasActionsContext.Provider value={actions}>
        <ReactFlow<StepFlowNode, StepFlowEdge>
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={onNodeClick ? (_, node) => onNodeClick(node.id) : undefined}
          onNodeDoubleClick={(_, node) => onOpenNode(node.id)}
          onConnect={handleConnect}
          onConnectEnd={handleConnectEnd}
          isValidConnection={isValidConnection}
          // The in-flight line matches a resting edge, so the drag previews the
          // wire it becomes; the generous radius lets a drop land near a step's
          // input port instead of demanding a direct hit.
          connectionLineStyle={{ stroke: '#64748b', strokeWidth: 2.25 }}
          connectionRadius={28}
          onSelectionChange={handleSelectionChange}
          onPaneClick={() => setPicker(null)}
          onContextMenu={(event) => event.preventDefault()}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          edgesReconnectable={!readOnly}
          // Node deletion routes through the page so the chain heals; React
          // Flow's own delete key would drop edges without reconnecting.
          deleteKeyCode={null}
          // n8n feel: left-drag marquee-selects, middle/right-drag pans. The
          // hand tool flips left-drag to panning; press-and-hold pans either way.
          selectionOnDrag={!handTool}
          selectionMode={SelectionMode.Partial}
          panOnDrag={handTool ? [0, 1, 2] : [1, 2]}
          panOnScroll
          zoomOnDoubleClick={false}
          minZoom={0.15}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={28} size={1.4} color="rgba(15,23,42,0.22)" />
          <MiniMap
            pannable
            zoomable
            className="!bottom-6 !right-4 !h-24 !w-40 rounded-lg border border-slate-200 !bg-white/90"
            nodeColor={(node) => MINIMAP_COLOR[String((node.data as { status?: string }).status ?? '')] ?? '#cbd5e1'}
          />

          {!readOnly && onInsertStandalone && (
            <Panel position="top-right" className="!right-4 !top-4 !m-0">
              <button
                type="button"
                onClick={handleAddStandalone}
                aria-label="Add step"
                title="Add step — place a new step without connecting it"
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                <Plus className="h-4 w-4" />
              </button>
            </Panel>
          )}

          <Panel position="bottom-left" className="!bottom-6 !left-4 !m-0">
            <div className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.12)]">
              <button
                type="button"
                onClick={() => setHandTool(false)}
                aria-label="Select tool"
                aria-pressed={!handTool}
                title="Select — drag to select steps (V). Hold on empty canvas to pan."
                className={cn(
                  'flex h-9 w-9 items-center justify-center transition-colors hover:bg-slate-50',
                  !handTool ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-900',
                )}
              >
                <MousePointer2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setHandTool(true)}
                aria-label="Hand tool"
                aria-pressed={handTool}
                title="Hand — drag to pan the canvas (H)"
                className={cn(
                  'flex h-9 w-9 items-center justify-center border-t border-slate-200 transition-colors hover:bg-slate-50',
                  handTool ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-900',
                )}
              >
                <Hand className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void zoomIn()}
                aria-label="Zoom in"
                title="Zoom in"
                className="flex h-9 w-9 items-center justify-center border-t border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <div className="w-full border-t border-slate-200 py-1 text-center text-[10px] font-semibold text-slate-500">
                {Math.round(zoom * 100)}%
              </div>
              <button
                type="button"
                onClick={() => void zoomOut()}
                aria-label="Zoom out"
                title="Zoom out"
                className="flex h-9 w-9 items-center justify-center border-t border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void fitView({ padding: 0.25, maxZoom: 1 })}
                aria-label="Fit view"
                title="Fit view"
                className="flex h-9 w-9 items-center justify-center border-t border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              {!readOnly && (
                <button
                  type="button"
                  onClick={onTidyUp}
                  aria-label="Tidy up"
                  title="Tidy up — re-layout every step"
                  className="flex h-9 w-9 items-center justify-center border-t border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
              )}
            </div>
          </Panel>

          {cursors && cursors.length > 0 && (
            <ViewportPortal>
              {/* Cursor coordinates ARE flow coordinates, so a teammate's pointer
                  lands on the same step for every viewer regardless of pan/zoom. */}
              <CursorLayer cursors={cursors} anchor="origin" />
            </ViewportPortal>
          )}
        </ReactFlow>
      </CanvasActionsContext.Provider>

      {/* First-run invitation: sits below the trigger chip (which fitView centers)
          and disappears the moment a real step exists or the picker opens. */}
      {emptyGraph && !readOnly && !picker && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex justify-center px-4 pt-16 animate-fade-in-up">
          <div className="pointer-events-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-slate-200/80 bg-white/85 px-8 py-6 text-center shadow-2 backdrop-blur">
            <div className="relative">
              <div aria-hidden="true" className="absolute inset-0 -z-10 scale-[1.8] rounded-full bg-horizon-200/50 blur-2xl" />
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-horizon-50 text-horizon-600 ring-1 ring-horizon-100">
                <Workflow className="h-5 w-5" aria-hidden="true" />
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">Add your first step</p>
              <p className="text-sm text-muted-foreground">
                Every flow starts at the trigger above. Add a step to build it yourself
                {onOpenCopilot ? ', or describe the flow and Copilot drafts it for you.' : '.'}
              </p>
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              {onInsertStandalone && (
                <Button size="sm" onClick={handleAddStandalone}>
                  <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  Add a step
                </Button>
              )}
              {onOpenCopilot && (
                <Button size="sm" variant="outline" onClick={onOpenCopilot}>
                  <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  Ask Copilot
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {picker && (
        <>
          <div className="absolute inset-0 z-30" onClick={() => setPicker(null)} />
          {/* Anchored to the canvas's top-right, deliberately covering the
              floating + button (same right-4/top-4 corner): the panel IS that
              button's expanded state, and a fixed home means it never lands on
              top of the nodes you're wiring. */}
          <div
            ref={pickerElRef}
            className={cn(
              'absolute right-4 top-4 z-40 flex max-h-[calc(100%-2rem)] w-[min(620px,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]',
            )}
          >
            <FlowPicker
              mode="action"
              agents={agents}
              toolCatalog={toolCatalog}
              onPick={pick}
              onClose={() => setPicker(null)}
            />
          </div>
        </>
      )}
    </div>
  )
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
