'use client'

import { memo, createContext, useContext, useEffect, useRef } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps, type Node } from '@xyflow/react'
import { AlertTriangle, Ban, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { NODE_ICON, NODE_TONE, STATUS_DOT, type StepStatus } from '@/lib/flows/node-presentation'
import { plusHandleId, type SourceHandle } from '@/lib/flows/canvas-model'
import type { FlowNode } from '@/lib/flows/graph'
import { AgentSubNodes } from './agent-sub-nodes'

/**
 * The compact canvas chip — an n8n-style widget, ~200×64. It shows WHAT a step
 * is, never HOW it is configured: all editing happens in the StepDrawer on
 * double-click. That separation is what lets a twenty-step flow fit on screen.
 */

export type StepNodeData = {
  node: FlowNode
  title: string
  subtitle?: string
  status?: StepStatus
  issues?: { errors: number; warnings: number }
  /** Source handles, in render order (branches for condition/switch, +error). */
  handles: SourceHandle[]
  hasTarget: boolean
  /** Handle ids that already have at least one outgoing edge — the rest get a
   *  `+` stub, the canvas's primary "add the next step" affordance. */
  connected: string[]
  /** Step count badge for loop/parallel containers. */
  bodyCount?: number
  /** Teammates with this step selected in a jam session. */
  editors?: { name: string; color: string }[]
  /** Brand logo for a configured tool step. */
  brand?: { slug: string; label: string }
  /** The bound agent's emoji — replaces the generic robot tile on agent steps. */
  emoji?: string
  highlighted?: boolean
}

export type StepFlowNode = Node<StepNodeData, 'step'>

/** Canvas callbacks live in context so node `data` stays pure data — a
 *  function identity in `data` would defeat memoization on every render. */
export type CanvasActions = {
  onAddFrom: (nodeId: string, branch: string | undefined) => void
  onInsertOnEdge: (edgeId: string) => void
  onDeleteEdge: (edgeId: string) => void
  readOnly?: boolean
  /** Commit a field-level edit made by canvas sub-node controls (agent chat model / memory / tools). */
  onChangeNode?: (node: FlowNode) => void
  /** Connections an agent step can be granted as tools, with display branding. */
  toolConnections?: { id: string; name: string; slug: string }[]
  /** Step-label context for token chips edited inside sub-node config panels. */
  labelCtx?: { stepLabels: Record<string, string> }
}

export const CanvasActionsContext = createContext<CanvasActions>({
  onAddFrom: () => {},
  onInsertOnEdge: () => {},
  onDeleteEdge: () => {},
})

/** Vertical offsets for N handles spread down a node's right edge. */
/**
 * The note shown under a node on the canvas, or '' when there is none.
 *
 * A step's note explains why it exists — the thing someone reading the flow six
 * months later most needs — and it was editable in the config panel and
 * rendered nowhere, so it only ever reached a reader who already knew to open
 * that step. n8n calls this notesInFlow.
 *
 * Trimmed and clamped: the field is free text, and a long note would push the
 * node out of the lane every other node sits in.
 */
export function stepNoteLabel(node: FlowNode): string {
  const raw = (node.data as { note?: unknown }).note
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 120) : ''
}

function handleOffsets(count: number): string[] {
  if (count <= 1) return ['50%']
  const span = 70
  const start = 50 - span / 2
  return Array.from({ length: count }, (_, index) => `${start + (span / (count - 1)) * index}%`)
}

function StepNodeComponent({ id, data, selected }: NodeProps<StepFlowNode>) {
  const { onAddFrom, readOnly } = useContext(CanvasActionsContext)
  const { node, title, subtitle, status, issues, handles, hasTarget, connected, bodyCount, editors, brand, emoji, highlighted } = data
  const note = stepNoteLabel(node)
  const Icon = NODE_ICON[node.type]
  const offsets = handleOffsets(handles.length)
  const connectedSet = new Set(connected)
  const errorCount = issues?.errors ?? 0
  const warningCount = issues?.warnings ?? 0
  const ring = editors?.[0]?.color

  // Where the pointer pressed a `+` stub — a click opens the picker, but a
  // drag that circles back and releases on the stub must not.
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)

  // The `+` stubs are real connection handles that mount and unmount as edges
  // come and go, so React Flow must re-measure this node's handle bounds —
  // otherwise a drag from a fresh stub draws its line from a stale anchor.
  const updateNodeInternals = useUpdateNodeInternals()
  const handleSetKey = `${handles.map((handle) => handle.id).join('|')};${connected.join('|')}`
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, handleSetKey, updateNodeInternals])

  return (
    <div className="relative" style={{ width: 200 }}>
      {editors && editors.length > 0 && (
        <span
          className="absolute -top-2.5 right-2 z-10 max-w-[160px] truncate rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
          style={{ backgroundColor: editors[0].color }}
        >
          {editors.map((editor) => editor.name).join(', ')} editing
        </span>
      )}

      {/* Card + side handles live in their own positioning context, so the
          %-based handle offsets keep resolving against the 64px card even when
          agent sub-node ports extend the node downward. */}
      <div className="relative">
      {hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="!h-3 !w-3 !border-2 !border-white !bg-slate-400"
        />
      )}

      <div
        className={cn(
          'flex h-16 items-center gap-2.5 rounded-xl border bg-white px-3 shadow-sm',
          'transition-[transform,box-shadow,border-color] duration-fast ease-out-quart hover:-translate-y-0.5 hover:shadow-2',
          'dark:border-slate-700 dark:bg-slate-900',
          selected ? 'border-blue-500 ring-2 ring-blue-500/35' : 'border-slate-200 hover:border-slate-300',
          highlighted && !selected && 'border-indigo-400 ring-2 ring-indigo-400/35',
          // During a run the whole card takes the outcome, not just the dot —
          // a failed step is the one thing the canvas must make impossible to miss.
          !selected && status === 'failed' && 'border-red-500 ring-2 ring-red-500/30',
          !selected && status === 'succeeded' && 'border-emerald-500/70 ring-1 ring-emerald-500/20',
          !selected && status === 'running' && 'border-amber-400 ring-2 ring-amber-400/30',
          errorCount > 0 && !status && 'border-red-400',
          node.disabled && 'opacity-55',
        )}
        style={ring ? { boxShadow: `0 0 0 2px ${ring}` } : undefined}
      >
        {emoji ? (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[22px] leading-none dark:bg-slate-800">
            {emoji}
          </span>
        ) : brand ? (
          <IntegrationLogo
            slug={brand.slug}
            name={brand.label}
            className="h-9 w-9 shrink-0 rounded-lg border border-slate-200 bg-white p-1.5"
          />
        ) : (
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', NODE_TONE[node.type])}>
            <Icon className="h-4 w-4" />
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-tight text-slate-900 dark:text-slate-100">
            {title}
          </span>
          {subtitle && (
            <span className="mt-0.5 block truncate text-[11px] leading-tight text-slate-500 dark:text-slate-400">
              {subtitle}
            </span>
          )}
          {bodyCount !== undefined && (
            <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-wide text-fg-muted">
              {bodyCount} step{bodyCount === 1 ? '' : 's'}
            </span>
          )}
          {/* A step's note explains why it exists — the thing someone reading
              the flow six months later most needs. It was editable in the panel
              and rendered nowhere, so it only ever reached a reader who already
              knew to open that step. n8n calls this notesInFlow. */}
          {note && (
            <span className="mt-1 block max-w-full truncate text-[10px] italic leading-4 text-fg-muted" title={note}>
              {note}
            </span>
          )}
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1">
          {status && <span className={cn('h-2.5 w-2.5 rounded-full', STATUS_DOT[status])} aria-label={status} />}
          {node.disabled && <Ban className="h-3.5 w-3.5 text-fg-muted" aria-label="Disabled" />}
          {(errorCount > 0 || warningCount > 0) && (
            <span
              className={cn(
                'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                errorCount > 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700',
              )}
              title={`${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'}`}
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              {errorCount > 0 ? errorCount : warningCount}
            </span>
          )}
        </span>
      </div>

      {handles.map((handle, index) => {
        const isConnected = connectedSet.has(handle.id)
        const isError = handle.tone === 'error'
        const showPlus = !isConnected && !readOnly
        return (
          <span key={handle.id}>
            <Handle
              type="source"
              position={Position.Right}
              id={handle.id}
              style={{ top: offsets[index] }}
              className={cn('!h-3 !w-3 !border-2 !border-white', isError ? '!bg-amber-500' : '!bg-slate-400')}
            />
            {handle.label && (
              // Sits ABOVE the `+` stub, which shares the same anchor point.
              <span
                className={cn(
                  'pointer-events-none absolute max-w-[140px] -translate-y-[150%] truncate whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide',
                  isError ? 'text-amber-600' : 'text-fg-muted',
                )}
                style={{ top: offsets[index], left: showPlus ? 'calc(100% + 28px)' : 'calc(100% + 10px)' }}
              >
                {handle.label}
              </span>
            )}
            {showPlus && (
              <>
                {/* Leader wire holding the `+` off the card, so the stub reads
                    as the start of the next connection rather than a badge. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none absolute h-px w-[22px] -translate-y-1/2',
                    isError ? 'bg-amber-300' : 'bg-slate-300 dark:bg-slate-600',
                  )}
                  style={{ top: offsets[index], left: 'calc(100% + 6px)' }}
                />
                {/* A real source handle wearing the `+`: click opens the insert
                    picker, press-and-drag draws a connection to another step.
                    Its id maps back to the branch via baseHandleId, and it
                    unmounts once the branch has an edge — so edges only ever
                    anchor to the plain handle above. */}
                <Handle
                  type="source"
                  position={Position.Right}
                  id={plusHandleId(handle.id)}
                  isConnectableEnd={false}
                  role="button"
                  aria-label={handle.label ? `Add step on ${handle.label}` : 'Add step'}
                  data-testid="step-add-handle"
                  title={
                    handle.label
                      ? `Add step on ${handle.label} — click to pick, or drag to connect to another step`
                      : 'Add step — click to pick, or drag to connect to another step'
                  }
                  onMouseDown={(event) => {
                    pressOrigin.current = { x: event.clientX, y: event.clientY }
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    const origin = pressOrigin.current
                    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 5) return
                    onAddFrom(node.id, handle.branch)
                  }}
                  className={cn(
                    'nodrag flex !h-5 !w-5 items-center justify-center !rounded-full !border !border-dashed !bg-white text-fg-muted transition-colors duration-fast hover:!border-blue-400 hover:text-blue-600 dark:!bg-slate-900',
                    isError ? '!border-amber-300' : '!border-slate-300 dark:!border-slate-600',
                  )}
                  style={{ top: offsets[index], left: 'calc(100% + 28px)', transform: 'translateY(-50%)' }}
                >
                  <Plus className="pointer-events-none h-3 w-3" />
                </Handle>
              </>
            )}
          </span>
        )
      })}
      </div>

      {node.type === 'agent' && <AgentSubNodes node={node} />}
    </div>
  )
}

export const StepNode = memo(StepNodeComponent)
