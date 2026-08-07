'use client'

import { Fragment, useRef, useState } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { CONDITION_OP_LABELS, type AiOp, type DataOp, type FlowGraph, type FlowNode, type VariableOp } from '@/lib/flows/graph'
import type { StepType } from '@/lib/flows/mutate'
import type { DataField } from '@/lib/flows/datatree'
import { humanizeTokens, type TokenLabelContext } from '@/lib/flows/token-text'
import { titleFor as titleForNode, subtitleFor as subtitleForNode } from '@/lib/flows/node-presentation'
import { unreachableInlineIds } from '@/lib/flows/canvas-model'
import { StepCard } from './step-card'
import type { StepStatus } from '@/lib/flows/node-presentation'
import { FlowPicker } from './flow-picker'
import type { OrgMember, ToolCatalog } from './step-drawer'

type Agent = { id: string; title: string; icon?: string }

export type FlowInsertSeed = {
  agentId?: string
  connectionId?: string
  toolName?: string
  label?: string
  variableOp?: VariableOp
  dataOp?: DataOp
  aiOp?: AiOp
  codeLanguage?: 'javascript' | 'python'
}

function InsertMenu({
  onPick,
  agents,
  toolCatalog,
  compact,
  tail,
  dropAfterId,
  onDropNode,
  dragging,
}: {
  onPick: (type: StepType, seed?: FlowInsertSeed) => void
  agents: Agent[]
  toolCatalog: ToolCatalog
  compact?: boolean
  tail?: boolean
  dropAfterId?: string
  onDropNode?: (draggedId: string, afterId: string) => void
  dragging?: boolean
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The canvas is inside a `transform: scale(zoom)` wrapper, which makes it the
  // containing block for fixed children: the backdrop this used to render was
  // both confined to the canvas box AND scaled with it, so at any zoom other
  // than 1 it didn't line up with what it appeared to cover.
  useDismissOnOutsidePointer(open, () => setOpen(false), [menuRef])

  return (
    <div
      ref={menuRef}
      className={cn('relative flex flex-col items-center', compact && 'items-start')}
      onClick={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        if (dropAfterId) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }
      }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData('text/flow-node-id')
        if (id && dropAfterId && onDropNode) {
          event.preventDefault()
          onDropNode(id, dropAfterId)
        }
      }}
    >
      {!compact && !tail && <div className="h-6 w-px bg-slate-300" />}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Add step"
        className={cn(
          'group flex items-center justify-center border bg-white text-slate-500 shadow-sm transition-all hover:border-blue-400 hover:text-blue-700 hover:shadow-md',
          compact
            ? 'gap-2 rounded-lg border-dashed px-3 py-2 text-sm font-semibold'
            : 'h-8 w-8 rounded-full border-slate-300',
          dragging && dropAfterId && 'ring-2 ring-indigo-300 rounded-full',
        )}
      >
        <Plus className="h-4 w-4" />
        {compact && 'Add a step'}
      </button>
      {!compact && !tail && (
        <div className="flex flex-col items-center">
          <div className="h-5 w-px bg-slate-300" />
          <svg width="10" height="6" viewBox="0 0 10 6" className="-mt-px text-slate-400" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      {open && (
          <div
            className={cn(
              'absolute z-30 mt-2 flex max-h-[72vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]',
              compact ? 'left-0 top-full w-[min(620px,calc(100vw-4rem))]' : 'left-1/2 top-full w-[min(720px,calc(100vw-4rem))] -translate-x-1/2',
            )}
          >
            <FlowPicker
              mode="action"
              agents={agents}
              toolCatalog={toolCatalog}
              onPick={(type, seed) => {
                setOpen(false)
                onPick(type, seed)
              }}
              onClose={() => setOpen(false)}
            />
          </div>
      )}
    </div>
  )
}

export function FlowCanvas({
  graph,
  agentName,
  agents,
  members,
  toolCatalog,
  dataFields,
  labelCtx,
  variableNames,
  flowId,
  published,
  onFlowPersisted,
  statusByNode,
  issuesByNode,
  highlightIds,
  selectedId,
  onSelect,
  onChangeNode,
  onInsertAfter,
  onAppendBranch,
  onRefreshAgents,
  onDuplicateNode,
  onMakeSubflow,
  onDeleteNode,
  onBackgroundClick,
  onPickTrigger,
  onMoveAfter,
  onReorderContainer,
  remoteSelections,
}: {
  graph: FlowGraph
  agentName: (agentId: string) => string
  agents: Agent[]
  members?: OrgMember[]
  toolCatalog: ToolCatalog
  dataFields?: DataField[]
  labelCtx?: TokenLabelContext
  variableNames?: string[]
  flowId?: string
  published?: boolean
  onFlowPersisted?: (updatedAt: string) => void
  statusByNode: Record<string, StepStatus>
  issuesByNode?: Record<string, { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }>
  highlightIds?: string[]
  selectedId: string | null
  onSelect: (nodeId: string, shiftKey?: boolean) => void
  onChangeNode: (node: FlowNode) => void
  onInsertAfter: (afterId: string, type: StepType, seed?: FlowInsertSeed) => void
  onAppendBranch: (conditionId: string, branch: string, type: StepType, seed?: FlowInsertSeed) => void
  onRefreshAgents?: () => void
  onDuplicateNode?: (id: string) => void
  onMakeSubflow?: (startId: string) => void
  onDeleteNode?: (id: string) => void
  onBackgroundClick?: () => void
  onPickTrigger?: (triggerType: 'manual' | 'schedule' | 'webhook' | 'signal' | 'poll') => void
  onMoveAfter?: (nodeId: string, afterId: string) => void
  onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void
  /** nodeId → remote collaborators with that node selected (editing ring + name chip). */
  remoteSelections?: Record<string, { name: string; color: string }[]>
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  // Branch labels rendered by the canvas itself (outside StepCard) must not
  // leak raw {{token}} syntax — StepCard humanizes its own title/subtitle.
  const humanize = (value: string) => (labelCtx ? humanizeTokens(value, labelCtx) : value)
  const onDropNode = (draggedId: string, afterId: string) => onMoveAfter?.(draggedId, afterId)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const nextOf = (id: string): FlowNode | undefined => {
    const edge = graph.edges.find((e) => e.source === id && !e.branch)
    return edge ? byId.get(edge.target) : undefined
  }
  const branchHead = (conditionId: string, branch: string): FlowNode | undefined => {
    const edge = graph.edges.find((e) => e.source === conditionId && e.branch === branch)
    return edge ? byId.get(edge.target) : undefined
  }
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )

  // Labels come from the shared presentation module so the Inline chain and the
  // Canvas chip can never name the same step differently.
  const presentation = { agentName, toolCatalog, published }
  const titleFor = (node: FlowNode): string => titleForNode(node, presentation)
  const subtitleFor = (node: FlowNode): string | undefined => subtitleForNode(node, presentation)

  const card = (node: FlowNode, index?: number) => {
    const editors = remoteSelections?.[node.id]
    return (
    <div
      data-node-id={node.id}
      className="relative w-full rounded-2xl"
      style={editors?.length ? { boxShadow: `0 0 0 2px ${editors[0].color}` } : undefined}
    >
      {editors && editors.length > 0 && (
        <span
          className="absolute -top-2.5 right-3 z-10 max-w-[200px] truncate rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
          style={{ backgroundColor: editors[0].color }}
        >
          {editors.map((e) => e.name).join(', ')} editing
        </span>
      )}
      <StepCard
        node={node}
        index={index}
        title={titleFor(node)}
        subtitle={subtitleFor(node)}
        status={statusByNode[node.id]}
        issues={issuesByNode?.[node.id]}
        selected={selectedId === node.id}
        highlighted={highlightIds?.includes(node.id)}
        agents={agents}
        members={members}
        toolCatalog={toolCatalog}
        dataFields={selectedId === node.id ? dataFields : undefined}
        labelCtx={labelCtx}
        variableNames={selectedId === node.id ? variableNames : undefined}
        flowId={flowId}
        published={published}
        onFlowPersisted={onFlowPersisted}
        onChange={onChangeNode}
        onClick={(shiftKey) => onSelect(node.id, shiftKey)}
        onRefreshAgents={onRefreshAgents}
        onDuplicate={node.type === 'trigger' ? undefined : onDuplicateNode ? () => onDuplicateNode(node.id) : undefined}
        onMakeSubflow={node.type === 'trigger' || contained.has(node.id) || !onMakeSubflow ? undefined : () => onMakeSubflow(node.id)}
        onDelete={node.type === 'trigger' ? undefined : onDeleteNode ? () => onDeleteNode(node.id) : undefined}
        draggable={node.type !== 'trigger' && node.type !== 'condition' && node.type !== 'switch'}
        onDragStartNode={setDragId}
        onDragEndNode={() => setDragId(null)}
      />
    </div>
    )
  }

  const nestedCards = (node: FlowNode) => {
    const ids = node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : []
    const nodes = ids.map((id) => byId.get(id)).filter((n): n is FlowNode => Boolean(n))
    if (!nodes.length) return null
    // Sibling list a given contained id can be reordered within — the loop
    // body, or (for parallel) whichever single branch array holds it.
    const siblingsOf = (id: string): { list: string[]; branchIndex?: number } => {
      if (node.type === 'loop') return { list: node.data.body }
      if (node.type === 'parallel') {
        const branchIndex = node.data.branches.findIndex((branch) => branch.includes(id))
        return { list: branchIndex >= 0 ? node.data.branches[branchIndex] : [], branchIndex: branchIndex >= 0 ? branchIndex : undefined }
      }
      return { list: [] }
    }
    return (
      <div className="my-3 ml-10 space-y-3 border-l-2 border-dashed border-slate-300 pl-4">
        {nodes.map((body, bodyIndex) => {
          const { list, branchIndex } = siblingsOf(body.id)
          return (
            <div
              key={body.id}
              onDragOver={(event) => {
                if (dragId && dragId !== body.id && list.includes(dragId)) {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }
              }}
              onDrop={(event) => {
                const draggedId = event.dataTransfer.getData('text/flow-node-id')
                if (draggedId && draggedId !== body.id && list.includes(draggedId)) {
                  event.preventDefault()
                  onReorderContainer?.(node.id, list.indexOf(draggedId), list.indexOf(body.id), branchIndex)
                }
              }}
            >
              {card(body, bodyIndex + 1)}
            </div>
          )
        })}
      </div>
    )
  }

  const renderChain = (start: FlowNode | undefined, seen: Set<string>): React.ReactNode => {
    const parts: React.ReactNode[] = []
    let current = start
    while (current && !seen.has(current.id) && !contained.has(current.id)) {
      seen.add(current.id)
      const node = current
      parts.push(
        <Fragment key={node.id}>
          {card(node)}
          {nestedCards(node)}
        </Fragment>,
      )
      // Steps set to route on failure get a distinct, labeled error path — the
      // 'error'-branch edge — rendered like a condition branch but amber-tinted.
      // The step still continues down its normal edge below.
      if ((node.type === 'agent' || node.type === 'tool' || node.type === 'http') && node.data.onError === 'route') {
        parts.push(
          <div key={`${node.id}-error`} className="my-3">
            <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50/70 p-3">
              <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> On error
              </p>
              <div className="space-y-3">
                {renderChain(branchHead(node.id, 'error'), seen)}
                <InsertMenu compact agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onAppendBranch(node.id, 'error', type, seed)} />
              </div>
            </div>
          </div>,
        )
      }
      if (node.type === 'condition') {
        parts.push(
          <div key={`${node.id}-branches`} className="my-3 grid gap-4 md:grid-cols-2">
            {(['true', 'false'] as const).map((branch) => (
              <div key={branch} className="rounded-2xl border border-dashed border-slate-300 bg-white/75 p-3">
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {branch === 'true' ? 'Then' : 'Otherwise'}
                </p>
                <div className="space-y-3">
                  {renderChain(branchHead(node.id, branch), seen)}
                  <InsertMenu compact agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onAppendBranch(node.id, branch, type, seed)} />
                </div>
              </div>
            ))}
          </div>,
        )
        return parts
      }
      if (node.type === 'switch') {
        const branches = [
          ...node.data.cases.map((c) => ({ key: c.id, label: c.label || humanize(`${c.left} ${CONDITION_OP_LABELS[c.op]} ${c.right}`) })),
          { key: 'default', label: 'default' },
        ]
        parts.push(
          <div key={`${node.id}-cases`} className="my-3 grid gap-4 md:grid-cols-2">
            {branches.map((branch) => (
              <div key={branch.key} className="rounded-2xl border border-dashed border-slate-300 bg-white/75 p-3">
                <p className="mb-3 truncate text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{branch.label}</p>
                <div className="space-y-3">
                  {renderChain(branchHead(node.id, branch.key), seen)}
                  <InsertMenu compact agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onAppendBranch(node.id, branch.key, type, seed)} />
                </div>
              </div>
            ))}
          </div>,
        )
        return parts
      }
      const next = nextOf(node.id)
      if (next && !contained.has(next.id) && !seen.has(next.id)) {
        parts.push(
          <InsertMenu
            key={`${node.id}-insert`}
            agents={agents}
            toolCatalog={toolCatalog}
            onPick={(type, seed) => onInsertAfter(node.id, type, seed)}
            dropAfterId={node.id}
            onDropNode={onDropNode}
            dragging={Boolean(dragId)}
          />,
        )
      } else {
        parts.push(
          <div key={`${node.id}-tail`} className="flex flex-col items-center">
            <div className="h-6 w-px bg-slate-300" />
            <InsertMenu
              tail
              agents={agents}
              toolCatalog={toolCatalog}
              onPick={(type, seed) => onInsertAfter(node.id, type, seed)}
              dropAfterId={node.id}
              onDropNode={onDropNode}
              dragging={Boolean(dragId)}
            />
          </div>,
        )
      }
      current = next
    }
    return parts
  }

  const trigger = byId.get('trigger') ?? graph.nodes[0]
  const first = trigger ? nextOf(trigger.id) : undefined
  const seen = new Set<string>(trigger ? [trigger.id] : [])
  // The chain walk follows ONE plain successor per step, so a fan-out leaves
  // whole paths unrendered. Rather than hide them, say so and list them —
  // nothing in the flow is ever invisible or uneditable here.
  const strandedIds = unreachableInlineIds(graph)
  const stranded = strandedIds.map((strandedId) => byId.get(strandedId)).filter((node): node is FlowNode => Boolean(node))

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col items-center py-8" onClick={() => onBackgroundClick?.()}>
      <div className="mb-6 flex items-center gap-2 self-start rounded-full border border-blue-100 bg-white/85 px-3 py-1.5 text-xs font-semibold text-blue-700 shadow-sm">
        <Sparkles className="h-3.5 w-3.5" />
        Designer
      </div>
      {stranded.length > 0 && (
        <div className="mb-6 w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This flow has parallel paths the inline builder can&apos;t draw — switch to Canvas to see how they connect.
        </div>
      )}
      <div className="flex w-full flex-col items-center">
        {trigger && card(trigger)}
        {trigger && !first && (
          <div
            className="mt-4 w-full max-w-[620px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
            onClick={(event) => event.stopPropagation()}
          >
            <FlowPicker mode="trigger" agents={agents} toolCatalog={toolCatalog} onPick={() => {}} onPickTrigger={onPickTrigger} onClose={() => {}} />
          </div>
        )}
        {trigger && !first && (
          <div className="flex flex-col items-center">
            <div className="h-6 w-px bg-slate-300" />
            <InsertMenu
              tail
              agents={agents}
              toolCatalog={toolCatalog}
              onPick={(type, seed) => onInsertAfter(trigger.id, type, seed)}
              dropAfterId={trigger.id}
              onDropNode={onDropNode}
              dragging={Boolean(dragId)}
            />
          </div>
        )}
        {trigger && first && (
          <InsertMenu
            agents={agents}
            toolCatalog={toolCatalog}
            onPick={(type, seed) => onInsertAfter(trigger.id, type, seed)}
            dropAfterId={trigger.id}
            onDropNode={onDropNode}
            dragging={Boolean(dragId)}
          />
        )}
        {renderChain(first, seen)}
      </div>
      {stranded.length > 0 && (
        <div className="mt-8 w-full">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Also in this flow</p>
          <div className="space-y-3">{stranded.map((node) => card(node))}</div>
        </div>
      )}
    </div>
  )
}
