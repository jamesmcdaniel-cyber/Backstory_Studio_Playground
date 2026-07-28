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
  state?: 'idle' | 'active' | 'dead'
}

export type StepFlowEdge = Edge<StepEdgeData, 'step'>

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
  const stroke = selected
    ? '#3b82f6'
    : state === 'dead'
      ? '#cbd5e1'
      : isError
        ? '#f59e0b'
        : state === 'active'
          ? '#10b981'
          : '#94a3b8'

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth: selected || state === 'active' ? 2.5 : 1.75,
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
