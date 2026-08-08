'use client'

import { memo, useContext, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CanvasActionsContext } from './step-node'

/**
 * A connection between two steps. Hovering reveals two affordances: `+` splices
 * a step into the middle of the connection, `×` removes it. During a run the
 * edge reflects what the scheduler did — solid and animated on an active path,
 * dimmed on a branch that went dead — which is the point of the canvas: on a
 * fan-out you watch both paths light up at once.
 */

export type StepEdgeData = {
  /** Amber styling for an `onError: route` connection. */
  isError?: boolean
  /** Scheduler outcome for this connection during the displayed run. */
  state?: 'idle' | 'running' | 'succeeded' | 'failed' | 'dead'
}

export type StepFlowEdge = Edge<StepEdgeData, 'step'>

// One color per edge condition — the stroke and its arrowhead marker derive
// from the same table so they can never disagree. Run-state colors use the
// brand semantic scale (backstory-design.css green/red-500), deliberately
// saturated so success and failure read at a glance across a large canvas.
// Selection wins so a selected edge never disappears into the run coloring.
const EDGE_COLORS = {
  selected: '#3b82f6',
  dead: '#cbd5e1',
  failed: '#e53935',
  succeeded: '#008859',
  running: '#f59e0b',
  error: '#f59e0b',
  idle: '#94a3b8',
} as const

type EdgeVariant = keyof typeof EDGE_COLORS

/**
 * Direction arrowheads, one marker per edge color. SVG markers resolve by
 * document-wide id, so rendering this once anywhere in the canvas wrapper is
 * enough for every edge; sized in userSpaceOnUse units so the arrow stays the
 * same size whether the edge is 1.75px idle or 3px emphasized.
 */
export function FlowEdgeMarkerDefs() {
  return (
    <svg aria-hidden width={0} height={0} style={{ position: 'absolute' }}>
      <defs>
        {(Object.entries(EDGE_COLORS) as [EdgeVariant, string][]).map(([variant, color]) => (
          <marker
            key={variant}
            id={`flow-arrow-${variant}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="12"
            markerHeight="12"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
          </marker>
        ))}
      </defs>
    </svg>
  )
}

function StepEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<StepFlowEdge>) {
  const { onInsertOnEdge, onDeleteEdge, readOnly } = useContext(CanvasActionsContext)
  const [hovered, setHovered] = useState(false)
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const isError = data?.isError
  const state = data?.state ?? 'idle'
  const variant: EdgeVariant = selected
    ? 'selected'
    : state === 'dead' || state === 'failed' || state === 'succeeded' || state === 'running'
      ? state
      : isError
        ? 'error'
        : 'idle'
  const stroke = EDGE_COLORS[variant]
  const emphasized = state === 'succeeded' || state === 'failed' || state === 'running'

  return (
    <>
      {/* Soft halo under a run-colored edge: SVG has no box-shadow, so a wide
          low-opacity twin path is what makes green/red pop against the grid. */}
      {emphasized && !selected && (
        <path d={path} fill="none" stroke={stroke} strokeWidth={9} strokeOpacity={0.16} />
      )}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#flow-arrow-${variant})`}
        className={state === 'running' ? 'flow-edge-running' : undefined}
        style={{
          stroke,
          strokeWidth: selected || emphasized ? 3 : 1.75,
          strokeDasharray: state === 'dead' ? '4 4' : undefined,
          opacity: state === 'dead' ? 0.6 : 1,
        }}
      />
      {/* Invisible wide hit area: a 2px line is far too thin to hover reliably. */}
      <path
        d={path}
        fill="none"
        strokeWidth={18}
        stroke="transparent"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ pointerEvents: 'stroke' }}
      />
      {!readOnly && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              'nodrag nopan absolute flex items-center gap-1 transition-opacity',
              hovered || selected ? 'opacity-100' : 'opacity-0',
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <button
              type="button"
              aria-label="Insert step here"
              title="Insert step here"
              onClick={(event) => {
                event.stopPropagation()
                onInsertOnEdge(id)
              }}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-600"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label="Delete connection"
              title="Delete connection"
              onClick={(event) => {
                event.stopPropagation()
                onDeleteEdge(id)
              }}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-sm transition-colors hover:border-red-400 hover:text-red-600"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const StepEdge = memo(StepEdgeComponent)
