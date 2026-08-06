'use client'

import { useContext, useEffect, useRef, useState } from 'react'
import { Brain, Plus, Sparkles, Wrench, X } from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { AGENT_STEP_MODELS } from '@/components/flows/step-drawer'
import type { FlowNode } from '@/lib/flows/graph'
import { CanvasActionsContext } from './step-node'

type AgentNode = Extract<FlowNode, { type: 'agent' }>
type MemoryStore = NonNullable<AgentNode['data']['memory']>['store']

const MEMORY_STORES: { value: MemoryStore; label: string }[] = [
  { value: 'postgres', label: 'Postgres' },
  { value: 'redis', label: 'Redis' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'xata', label: 'Xata' },
]

const memoryLabel = (store: MemoryStore | undefined) =>
  MEMORY_STORES.find((entry) => entry.value === (store ?? 'postgres'))?.label ?? 'Postgres'

/**
 * n8n-style sub-node ports under an agent step: Chat Model, Memory, and Tool
 * attachment points with `+` stubs. Attaching writes the SAME step fields the
 * drawer's "Model, memory & tools" section edits (model / memory /
 * toolConnectionIds) — this is a canvas affordance, not a second data model.
 */
export function AgentSubNodes({ node }: { node: AgentNode }) {
  const { onChangeNode, toolConnections = [], readOnly } = useContext(CanvasActionsContext)
  const [menu, setMenu] = useState<'model' | 'memory' | 'tool' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menu])

  if (!onChangeNode) return null

  const update = (data: Partial<AgentNode['data']>) => onChangeNode({ ...node, data: { ...node.data, ...data } })
  const grantedIds = node.data.toolConnectionIds ?? []
  const grantable = toolConnections.filter((connection) => !grantedIds.includes(connection.id))
  const modelChoices = node.data.model && !AGENT_STEP_MODELS.includes(node.data.model)
    ? [node.data.model, ...AGENT_STEP_MODELS]
    : AGENT_STEP_MODELS

  const chipClass =
    'nodrag flex max-w-[120px] items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[10px] font-semibold text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
  const removeClass = 'shrink-0 text-slate-300 transition-colors hover:text-red-500'
  const addClass =
    'nodrag flex h-5 w-5 items-center justify-center rounded-md border border-dashed border-slate-300 bg-white text-slate-400 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-slate-600 dark:bg-slate-900'
  const menuClass =
    'nodrag absolute top-full z-50 mt-1 max-h-44 w-44 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 text-left shadow-lg dark:border-slate-700 dark:bg-slate-900'
  const menuItemClass =
    'flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-slate-700 hover:bg-blue-50 hover:text-blue-800 dark:text-slate-200 dark:hover:bg-slate-800'

  const port = (
    key: 'model' | 'memory' | 'tool',
    label: string,
    attached: React.ReactNode,
    menuBody: React.ReactNode,
    showAdd: boolean,
  ) => (
    <div className="relative flex min-w-0 flex-1 flex-col items-center">
      {/* Diamond connector on the card's bottom edge, n8n-style. */}
      <span className="-mt-[5px] h-2 w-2 rotate-45 border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900" />
      <span className="mt-0.5 max-w-full truncate text-[9px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className="h-2.5 w-px bg-slate-300 dark:bg-slate-600" />
      <div className="flex flex-col items-center gap-1">
        {attached}
        {showAdd && !readOnly && (
          <button
            type="button"
            aria-label={`Add ${label.toLowerCase()}`}
            title={`Add ${label.toLowerCase()}`}
            onClick={(event) => {
              event.stopPropagation()
              setMenu(menu === key ? null : key)
            }}
            className={addClass}
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
      </div>
      {menu === key && <div className={menuClass}>{menuBody}</div>}
    </div>
  )

  return (
    <div ref={rootRef} className="flex items-start px-2" onDoubleClick={(event) => event.stopPropagation()}>
      {port(
        'model',
        'Chat Model',
        node.data.model ? (
          <span className={chipClass} title={node.data.model}>
            <Sparkles className="h-3 w-3 shrink-0 text-indigo-500" />
            <span className="truncate">{node.data.model}</span>
            {!readOnly && (
              <button
                type="button"
                aria-label="Use the agent's default model"
                onClick={(event) => {
                  event.stopPropagation()
                  update({ model: undefined })
                }}
                className={removeClass}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ) : null,
        <>
          {modelChoices.map((model) => (
            <button
              key={model}
              type="button"
              className={menuItemClass}
              onClick={(event) => {
                event.stopPropagation()
                update({ model })
                setMenu(null)
              }}
            >
              <Sparkles className="h-3 w-3 shrink-0 text-indigo-500" /> {model}
            </button>
          ))}
        </>,
        !node.data.model,
      )}
      {port(
        'memory',
        'Memory',
        node.data.memory ? (
          <span className={chipClass} title={`Remembers past runs (${memoryLabel(node.data.memory.store)})`}>
            <Brain className="h-3 w-3 shrink-0 text-rose-500" />
            <span className="truncate">{memoryLabel(node.data.memory.store)}</span>
            {!readOnly && (
              <button
                type="button"
                aria-label="Remove memory"
                onClick={(event) => {
                  event.stopPropagation()
                  update({ memory: undefined })
                }}
                className={removeClass}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ) : null,
        <>
          {MEMORY_STORES.map((store) => (
            <button
              key={store.value}
              type="button"
              className={menuItemClass}
              onClick={(event) => {
                event.stopPropagation()
                update({ memory: { store: store.value } })
                setMenu(null)
              }}
            >
              <Brain className="h-3 w-3 shrink-0 text-rose-500" /> {store.label}
            </button>
          ))}
        </>,
        !node.data.memory,
      )}
      {port(
        'tool',
        'Tool',
        grantedIds.length ? (
          <>
            {grantedIds.map((connectionId) => {
              const connection = toolConnections.find((entry) => entry.id === connectionId)
              return (
                <span key={connectionId} className={chipClass} title={connection?.name ?? connectionId}>
                  {connection ? (
                    <IntegrationLogo slug={connection.slug} name={connection.name} className="h-3 w-3 shrink-0" />
                  ) : (
                    <Wrench className="h-3 w-3 shrink-0 text-orange-500" />
                  )}
                  <span className="truncate">{connection?.name ?? 'Connection'}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Remove ${connection?.name ?? 'tool'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        const next = grantedIds.filter((id) => id !== connectionId)
                        update({ toolConnectionIds: next.length ? next : undefined })
                      }}
                      className={removeClass}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              )
            })}
          </>
        ) : null,
        grantable.length ? (
          <>
            {grantable.map((connection) => (
              <button
                key={connection.id}
                type="button"
                className={menuItemClass}
                onClick={(event) => {
                  event.stopPropagation()
                  update({ toolConnectionIds: [...grantedIds, connection.id] })
                  setMenu(null)
                }}
              >
                <IntegrationLogo slug={connection.slug} name={connection.name} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{connection.name}</span>
              </button>
            ))}
          </>
        ) : (
          <p className="px-2.5 py-1.5 text-[11px] text-slate-500">
            {toolConnections.length ? 'Every connection is already granted.' : 'Connect an integration to grant its tools.'}
          </p>
        ),
        true,
      )}
    </div>
  )
}
