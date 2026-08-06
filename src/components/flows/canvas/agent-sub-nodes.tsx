'use client'

import { useContext, useEffect, useRef, useState } from 'react'
import { Brain, Plus, Sparkles, Wrench, X } from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { TokenTextEditor } from '@/components/flows/token-text-editor'
import { AGENT_STEP_MODELS } from '@/components/flows/step-drawer'
import type { FlowNode } from '@/lib/flows/graph'
import { CanvasActionsContext } from './step-node'

type AgentNode = Extract<FlowNode, { type: 'agent' }>
type MemoryStore = NonNullable<AgentNode['data']['memory']>['store']

const MEMORY_STORES: { value: MemoryStore; label: string }[] = [
  { value: 'postgres', label: 'Built-in' },
  { value: 'redis', label: 'Redis' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'xata', label: 'Xata' },
]

const memoryLabel = (store: MemoryStore | undefined) =>
  MEMORY_STORES.find((entry) => entry.value === (store ?? 'postgres'))?.label ?? 'Built-in'

/**
 * n8n-style sub-nodes under an agent step: Chat Model, Memory, and Tool
 * attachments rendered as their OWN small nodes, each opening its own config
 * panel — model choice, memory store/session/window, tool grants — so none of
 * this lives in the main step drawer. Attaching writes the same step fields as
 * ever (model / memory / toolConnectionIds): a canvas surface, not a second
 * data model.
 */
export function AgentSubNodes({ node }: { node: AgentNode }) {
  const { onChangeNode, toolConnections = [], labelCtx, readOnly } = useContext(CanvasActionsContext)
  // 'model' | 'memory' | 'tool-add' | `tool:<connectionId>`
  const [panel, setPanel] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!panel) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPanel(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [panel])

  if (!onChangeNode) return null

  const update = (data: Partial<AgentNode['data']>) => onChangeNode({ ...node, data: { ...node.data, ...data } })
  const grantedIds = node.data.toolConnectionIds ?? []
  const grantable = toolConnections.filter((connection) => !grantedIds.includes(connection.id))
  const modelChoices = node.data.model && !AGENT_STEP_MODELS.includes(node.data.model)
    ? [node.data.model, ...AGENT_STEP_MODELS]
    : AGENT_STEP_MODELS

  const circleClass =
    'nodrag relative flex h-10 w-10 items-center justify-center rounded-full border-2 border-slate-300 bg-white shadow-sm transition-colors hover:border-blue-400 dark:border-slate-600 dark:bg-slate-900'
  const stubClass =
    'nodrag flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-slate-300 bg-white text-slate-400 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-slate-600 dark:bg-slate-900'
  const captionClass = 'mt-1 max-w-[72px] truncate text-center text-[9px] font-medium leading-tight text-slate-500 dark:text-slate-400'
  const panelClass =
    'nodrag absolute top-full z-50 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-2.5 text-left shadow-lg dark:border-slate-700 dark:bg-slate-900'
  const panelLabelClass = 'mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400'
  const panelFieldClass =
    'w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200'
  const menuItemClass =
    'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] font-medium text-slate-700 hover:bg-blue-50 hover:text-blue-800 dark:text-slate-200 dark:hover:bg-slate-800'
  const removeBadgeClass =
    'nodrag absolute -right-1.5 -top-1.5 z-10 hidden h-4 w-4 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-sm hover:text-red-500 group-hover/sub:flex dark:border-slate-600 dark:bg-slate-900'

  /** One attachment: dashed drop-line, the sub-node circle, its caption, and (open) its config panel. */
  const subNode = (opts: {
    key: string
    caption: string
    icon: React.ReactNode
    title: string
    onRemove?: () => void
    panelBody: React.ReactNode
  }) => (
    <div key={opts.key} className="group/sub relative flex flex-col items-center">
      <button
        type="button"
        title={opts.title}
        aria-label={`Configure ${opts.title}`}
        aria-expanded={panel === opts.key}
        className={circleClass}
        onClick={(event) => {
          event.stopPropagation()
          setPanel(panel === opts.key ? null : opts.key)
        }}
      >
        {opts.icon}
      </button>
      {!readOnly && opts.onRemove && (
        <button
          type="button"
          aria-label={`Remove ${opts.title}`}
          className={removeBadgeClass}
          onClick={(event) => {
            event.stopPropagation()
            setPanel(null)
            opts.onRemove!()
          }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      <span className={captionClass}>{opts.caption}</span>
      {panel === opts.key && (
        <div className={panelClass} onClick={(event) => event.stopPropagation()}>
          {opts.panelBody}
        </div>
      )}
    </div>
  )

  const addStub = (key: string, label: string, menuBody: React.ReactNode) => (
    <div key={key} className="relative flex flex-col items-center">
      <button
        type="button"
        aria-label={label}
        title={label}
        className={stubClass}
        onClick={(event) => {
          event.stopPropagation()
          setPanel(panel === key ? null : key)
        }}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {panel === key && (
        <div className={panelClass} onClick={(event) => event.stopPropagation()}>
          {menuBody}
        </div>
      )}
    </div>
  )

  /** Port column: diamond on the card's bottom edge + dashed line into the attachments. */
  const port = (label: string, body: React.ReactNode) => (
    <div className="relative flex min-w-0 flex-1 flex-col items-center">
      <span className="-mt-[5px] h-2 w-2 rotate-45 border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900" />
      <span className="mt-0.5 max-w-full truncate text-[9px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className="h-3 w-px border-l border-dashed border-slate-300 dark:border-slate-600" />
      <div className="flex flex-col items-center gap-1.5">{body}</div>
    </div>
  )

  const memory = node.data.memory

  return (
    <div ref={rootRef} className="flex items-start px-2 pb-1" onDoubleClick={(event) => event.stopPropagation()}>
      {port(
        'Chat Model',
        node.data.model
          ? subNode({
              key: 'model',
              caption: node.data.model,
              title: `Chat model: ${node.data.model}`,
              icon: <Sparkles className="h-4 w-4 text-indigo-500" />,
              onRemove: () => update({ model: undefined }),
              panelBody: (
                <div>
                  <label className={panelLabelClass}>Chat model for this step</label>
                  <select
                    className={panelFieldClass}
                    value={node.data.model ?? ''}
                    disabled={readOnly}
                    onChange={(event) => update({ model: event.target.value || undefined })}
                  >
                    <option value="">Agent default</option>
                    {modelChoices.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[10px] leading-4 text-slate-500">Only this step runs on it — the agent keeps its own model elsewhere.</p>
                </div>
              ),
            })
          : !readOnly &&
              addStub(
                'model',
                'Add chat model',
                <>
                  <label className={panelLabelClass}>Chat model for this step</label>
                  {modelChoices.map((model) => (
                    <button
                      key={model}
                      type="button"
                      className={menuItemClass}
                      onClick={(event) => {
                        event.stopPropagation()
                        update({ model })
                        setPanel(null)
                      }}
                    >
                      <Sparkles className="h-3 w-3 shrink-0 text-indigo-500" /> {model}
                    </button>
                  ))}
                </>,
              ),
      )}
      {port(
        'Memory',
        memory
          ? subNode({
              key: 'memory',
              caption: memoryLabel(memory.store),
              title: `Memory: ${memoryLabel(memory.store)}`,
              icon: <Brain className="h-4 w-4 text-rose-500" />,
              onRemove: () => update({ memory: undefined }),
              panelBody: (
                <div className="space-y-2">
                  <div>
                    <label className={panelLabelClass}>Store</label>
                    <select
                      className={panelFieldClass}
                      value={memory.store ?? 'postgres'}
                      disabled={readOnly}
                      onChange={(event) => update({ memory: { ...memory, store: event.target.value as MemoryStore } })}
                    >
                      {MEMORY_STORES.map((store) => (
                        <option key={store.value} value={store.value}>
                          {store.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={panelLabelClass}>Session key</label>
                    <TokenTextEditor
                      value={memory.sessionKey ?? ''}
                      labelCtx={labelCtx ?? { stepLabels: {} }}
                      placeholder="Optional — e.g. one thread per account"
                      onChange={(sessionKey) => update({ memory: { ...memory, sessionKey: sessionKey || undefined } })}
                      ariaLabel="Memory session key"
                      className="!px-2 !py-1.5 !text-[11px]"
                    />
                    <p className="mt-1 text-[10px] leading-4 text-slate-500">Runs with the same key share one conversation thread.</p>
                  </div>
                  <div>
                    <label className={panelLabelClass}>Replay window</label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      className={panelFieldClass}
                      value={memory.window ?? ''}
                      placeholder="6"
                      disabled={readOnly}
                      onChange={(event) => {
                        const raw = Number(event.target.value)
                        const window = Number.isFinite(raw) && event.target.value !== '' ? Math.max(1, Math.min(20, Math.round(raw))) : undefined
                        update({ memory: { ...memory, window } })
                      }}
                      aria-label="Past exchanges to replay"
                    />
                    <p className="mt-1 text-[10px] leading-4 text-slate-500">How many past exchanges feed into each run.</p>
                  </div>
                </div>
              ),
            })
          : !readOnly &&
              addStub(
                'memory',
                'Add memory',
                <>
                  <label className={panelLabelClass}>Remember past runs</label>
                  {MEMORY_STORES.map((store) => (
                    <button
                      key={store.value}
                      type="button"
                      className={menuItemClass}
                      onClick={(event) => {
                        event.stopPropagation()
                        update({ memory: { store: store.value } })
                        setPanel('memory')
                      }}
                    >
                      <Brain className="h-3 w-3 shrink-0 text-rose-500" /> {store.label}
                    </button>
                  ))}
                </>,
              ),
      )}
      {port(
        'Tool',
        <>
          {grantedIds.map((connectionId) => {
            const connection = toolConnections.find((entry) => entry.id === connectionId)
            return subNode({
              key: `tool:${connectionId}`,
              caption: connection?.name ?? 'Connection',
              title: connection?.name ?? connectionId,
              icon: connection ? (
                <IntegrationLogo slug={connection.slug} name={connection.name} className="h-4 w-4" />
              ) : (
                <Wrench className="h-4 w-4 text-orange-500" />
              ),
              onRemove: () => {
                const next = grantedIds.filter((id) => id !== connectionId)
                update({ toolConnectionIds: next.length ? next : undefined })
              },
              panelBody: (
                <div>
                  <label className={panelLabelClass}>Tool connection</label>
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-200">
                    {connection ? (
                      <IntegrationLogo slug={connection.slug} name={connection.name} className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Wrench className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                    )}
                    <span className="truncate">{connection?.name ?? 'This connection is no longer available.'}</span>
                  </p>
                  <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
                    Granted to the agent for this step only, on top of the tools it already owns. Manage the connection itself under Integrations.
                  </p>
                  {!readOnly && (
                    <button
                      type="button"
                      className="mt-2 w-full rounded-md border border-red-200 px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:hover:bg-red-950/40"
                      onClick={(event) => {
                        event.stopPropagation()
                        setPanel(null)
                        const next = grantedIds.filter((id) => id !== connectionId)
                        update({ toolConnectionIds: next.length ? next : undefined })
                      }}
                    >
                      Remove from this step
                    </button>
                  )}
                </div>
              ),
            })
          })}
          {!readOnly &&
            addStub(
              'tool-add',
              'Grant a tool connection',
              grantable.length ? (
                <>
                  <label className={panelLabelClass}>Grant for this step</label>
                  {grantable.map((connection) => (
                    <button
                      key={connection.id}
                      type="button"
                      className={menuItemClass}
                      onClick={(event) => {
                        event.stopPropagation()
                        update({ toolConnectionIds: [...grantedIds, connection.id] })
                        setPanel(null)
                      }}
                    >
                      <IntegrationLogo slug={connection.slug} name={connection.name} className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{connection.name}</span>
                    </button>
                  ))}
                </>
              ) : (
                <p className="px-1 py-0.5 text-[11px] text-slate-500">
                  {toolConnections.length ? 'Every connection is already granted.' : 'Connect an integration to grant its tools.'}
                </p>
              ),
            )}
        </>,
      )}
    </div>
  )
}
