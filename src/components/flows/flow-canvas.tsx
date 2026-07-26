'use client'

import { Fragment, useState } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { AI_OP_LABELS, CONDITION_OP_LABELS, VARIABLE_OP_LABELS, VARIABLE_TYPE_LABELS, type AiOp, type DataOp, type FlowGraph, type FlowNode, type VariableOp } from '@/lib/flows/graph'
import type { StepType } from '@/lib/flows/mutate'
import type { DataField } from '@/lib/flows/datatree'
import { humanizeTokens, type TokenLabelContext } from '@/lib/flows/token-text'
import { selectedToolPresentation } from '@/lib/flows/tool-presentation'
import { StepCard, type StepStatus } from './step-card'
import { FlowPicker } from './flow-picker'
import type { OrgMember, ToolCatalog } from './step-drawer'

type Agent = { id: string; title: string }

export type FlowInsertSeed = {
  agentId?: string
  connectionId?: string
  toolName?: string
  label?: string
  variableOp?: VariableOp
  dataOp?: DataOp
  aiOp?: AiOp
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

  return (
    <div
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
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            className={cn(
              'absolute z-30 mt-2 max-h-[72vh] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]',
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
        </>
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
  statusByNode: Record<string, StepStatus>
  issuesByNode?: Record<string, { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }>
  highlightIds?: string[]
  selectedId: string | null
  onSelect: (nodeId: string) => void
  onChangeNode: (node: FlowNode) => void
  onInsertAfter: (afterId: string, type: StepType, seed?: FlowInsertSeed) => void
  onAppendBranch: (conditionId: string, branch: string, type: StepType, seed?: FlowInsertSeed) => void
  onRefreshAgents?: () => void
  onDuplicateNode?: (id: string) => void
  onMakeSubflow?: (startId: string) => void
  onDeleteNode?: (id: string) => void
  onBackgroundClick?: () => void
  onPickTrigger?: (triggerType: 'manual' | 'schedule' | 'webhook' | 'signal') => void
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

  const titleFor = (node: FlowNode): string => {
    switch (node.type) {
      case 'trigger': {
        const type = (node.data.trigger as { type?: string } | undefined)?.type ?? 'manual'
        if (type === 'schedule') return 'Schedule trigger'
        if (type === 'webhook') return 'When an HTTP request is received'
        if (type === 'signal') return 'Signal trigger'
        return 'Manually trigger a flow'
      }
      case 'agent':
        return node.data.label || agentName(node.data.agentId) || 'Run an agent'
      case 'condition': {
        const clause = node.data.clauses?.[0] ?? (node.data.left !== undefined ? { left: node.data.left, op: node.data.op, right: node.data.right } : null)
        const extra = (node.data.clauses?.length ?? 1) > 1 ? ` +${node.data.clauses!.length - 1}` : ''
        return node.data.label || (clause?.left ? `If ${clause.left} ${CONDITION_OP_LABELS[clause.op ?? 'eq']} ${clause.right}${extra}` : 'If / else')
      }
      case 'loop':
        return node.data.label || 'For each'
      case 'parallel':
        return node.data.label || 'Parallel branches'
      case 'stop':
        return node.data.label || 'Stop flow'
      case 'tool':
        return (
          node.data.label ||
          selectedToolPresentation(toolCatalog, node.data.connectionId, node.data.toolName).actionLabel ||
          'Run a connected tool'
        )
      case 'http':
        return node.data.label || 'HTTP request'
      case 'transform':
        return node.data.label || 'Set fields'
      case 'filter':
        return node.data.label || 'Filter'
      case 'switch':
        return node.data.label || 'Switch'
      case 'variable': {
        const name = node.data.name.trim()
        return node.data.label || `${VARIABLE_OP_LABELS[node.data.op]}${name ? ` ${name}` : ''}`
      }
      case 'data':
        return node.data.label || DATA_OP_LABELS[node.data.op]
      case 'humanReview':
        return node.data.label || 'Request information'
      case 'output':
        return node.data.label || 'Output'
      case 'join':
        return node.data.label || 'Join paths'
      case 'ai':
        return node.data.label || AI_OP_LABELS[node.data.aiOp]
      case 'subflow':
        return node.data.label || 'Run a flow'
      case 'knowledge':
        return node.data.label || 'Search knowledge'
    }
  }

  const subtitleFor = (node: FlowNode): string | undefined => {
    switch (node.type) {
      case 'trigger': {
        const trigger = (node.data.trigger as
          | { type?: string; schedule?: { type?: string; time?: string; timezone?: string }; signal?: string; inputFields?: unknown[] }
          | undefined) ?? {}
        const type = trigger.type ?? 'manual'
        const inputCount = (trigger.inputFields ?? []).length
        const inputLine = inputCount ? `${inputCount} input${inputCount === 1 ? '' : 's'}` : 'Add fields users fill in before the flow runs.'
        if (type === 'schedule') {
          const schedule = trigger.schedule ?? {}
          return `Runs ${schedule.type ?? 'daily'}${schedule.time ? ` at ${schedule.time}` : ''} (${schedule.timezone || 'UTC'})`
        }
        if (type === 'signal') return `Listens for "${trigger.signal || 'unnamed signal'}"`
        if (type === 'webhook') return published === false ? `${inputLine} · publish to arm` : inputLine
        // manual keeps the original input-count line.
        return inputLine
      }
      case 'agent':
        return agentName(node.data.agentId) || 'Choose an agent'
      case 'loop':
        return node.data.over === '{{trigger.input}}' ? 'Loop over trigger input' : `Loop over ${node.data.over}`
      case 'parallel':
        return `${node.data.branches.length} branch${node.data.branches.length === 1 ? '' : 'es'}`
      case 'stop':
        return node.data.reason || undefined
      case 'tool':
        return (
          selectedToolPresentation(toolCatalog, node.data.connectionId, node.data.toolName).brand?.label ||
          'Choose a connected app and action'
        )
      case 'http':
        return node.data.url ? `${node.data.method} ${node.data.url}` : 'Configure an API request'
      case 'transform':
        return `${node.data.fields.length} field${node.data.fields.length === 1 ? '' : 's'}`
      case 'filter':
        return node.data.note || 'Continue only if a rule matches'
      case 'switch':
        return node.data.note || `${node.data.cases.length} case${node.data.cases.length === 1 ? '' : 's'}`
      // Subtitles run through StepCard's humanize, so {{tokens}} below read as
      // plain-English chips, never raw braces.
      case 'variable': {
        if (node.data.note) return node.data.note
        if (node.data.op === 'initialize') {
          const typeLabel = VARIABLE_TYPE_LABELS[node.data.varType ?? 'string']
          return node.data.value?.trim() ? `${typeLabel} — starts as ${node.data.value}` : `${typeLabel} variable`
        }
        if (node.data.op === 'increment' || node.data.op === 'decrement') {
          return node.data.value?.trim() ? `By ${node.data.value}` : 'By 1'
        }
        return node.data.value?.trim() || 'Choose the value to store'
      }
      case 'data':
        return node.data.note || node.data.input?.trim() || 'Choose the data to work with'
      case 'humanReview':
        return node.data.note || node.data.message.trim() || 'Write the question to ask'
      case 'output': {
        if (node.data.note) return node.data.note
        const names = node.data.outputs.map((o) => o.name.trim()).filter(Boolean)
        if (!names.length) return 'Name the results this flow returns'
        return names.length === 1 ? `Returns ${names[0]}` : `Returns ${names[0]} +${names.length - 1}`
      }
      case 'join':
        return node.data.note || 'Merge branches back into one path'
      case 'ai': {
        if (node.data.note) return node.data.note
        const gist = (node.data.instructions ?? '').trim().split('\n')[0] || (node.data.input ?? '').trim().split('\n')[0]
        return gist || 'Tell AI what to do with the input'
      }
      case 'subflow':
        return node.data.note || (node.data.flowId ? 'Runs another flow and passes back its result' : 'Choose the flow to run')
      case 'knowledge':
        return node.data.note || (node.data.query?.trim() ? undefined : 'Write what to look for')
      default:
        return (node.data as { note?: string }).note || undefined
    }
  }

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
        onChange={onChangeNode}
        onClick={() => onSelect(node.id)}
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

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col items-center py-8" onClick={() => onBackgroundClick?.()}>
      <div className="mb-6 flex items-center gap-2 self-start rounded-full border border-blue-100 bg-white/85 px-3 py-1.5 text-xs font-semibold text-blue-700 shadow-sm">
        <Sparkles className="h-3.5 w-3.5" />
        Designer
      </div>
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
    </div>
  )
}
