'use client'

import { useMemo } from 'react'
import type { FlowGraph } from '@/lib/flows/graph'
import { layoutGraph } from '@/lib/flows/layout'
import { outerEdges, outerNodes, NODE_WIDTH, NODE_HEIGHT } from '@/lib/flows/canvas-model'
import { NODE_ICON, NODE_TONE, titleFor, type PresentationContext } from '@/lib/flows/node-presentation'
import { cn } from '@/lib/utils'

// A template graph carries no live agents/connections — titles fall back to
// the node's own label, which templates always author.
const PREVIEW_CTX: PresentationContext = { agentName: () => '', toolCatalog: [] }

/**
 * Read-only miniature of a flow graph for the template detail page: the same
 * dagre layout the canvas uses (force: true — template nodes carry no manual
 * positions), simple cards, bezier edges. No interaction, no state — the point
 * is letting someone SEE the pipeline's shape (branches, merges, where the
 * human gate sits) before creating anything.
 */
export function FlowGraphPreview({ graph, className }: { graph: FlowGraph; className?: string }) {
  const model = useMemo(() => {
    const positions = layoutGraph(graph, { force: true })
    const nodes = outerNodes(graph).filter((node) => positions.has(node.id))
    const edges = outerEdges(graph).filter((edge) => positions.has(edge.source) && positions.has(edge.target))
    let width = 0
    let height = 0
    for (const node of nodes) {
      const pos = positions.get(node.id)!
      width = Math.max(width, pos.x + NODE_WIDTH)
      height = Math.max(height, pos.y + NODE_HEIGHT)
    }
    return { positions, nodes, edges, width: width + 24, height: height + 24 }
  }, [graph])

  if (model.nodes.length === 0) return null

  return (
    <div className={cn('overflow-x-auto', className)}>
      <div className="relative" style={{ width: model.width, height: model.height }}>
        <svg className="absolute inset-0" width={model.width} height={model.height} aria-hidden>
          {model.edges.map((edge) => {
            const from = model.positions.get(edge.source)!
            const to = model.positions.get(edge.target)!
            const x1 = from.x + NODE_WIDTH
            const y1 = from.y + NODE_HEIGHT / 2
            const x2 = to.x
            const y2 = to.y + NODE_HEIGHT / 2
            const dx = Math.max(32, (x2 - x1) / 2)
            const isError = edge.branch === 'error'
            return (
              <g key={edge.id}>
                <path
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  className={isError ? 'stroke-red-400/70' : 'stroke-border'}
                  strokeWidth={1.5}
                  strokeDasharray={isError ? '4 3' : undefined}
                />
                {edge.branch && edge.branch !== 'error' && (
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 6}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {edge.branch}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {model.nodes.map((node) => {
          const pos = model.positions.get(node.id)!
          const Icon = NODE_ICON[node.type]
          const label = titleFor(node, PREVIEW_CTX)
          return (
            <div
              key={node.id}
              className="absolute flex items-center gap-2 rounded-xl border border-border/70 bg-card px-2.5 shadow-sm"
              style={{ left: pos.x, top: pos.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            >
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', NODE_TONE[node.type])}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 truncate text-xs font-medium leading-snug" title={label}>
                {label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
