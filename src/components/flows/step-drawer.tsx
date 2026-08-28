'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { X, Trash2, Copy, Database, Settings2, Braces, ChevronLeft, ChevronRight, Play, Pin, ToggleLeft, ToggleRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { type FlowNode } from '@/lib/flows/graph'
import { DataTree } from '@/components/flows/data-tree'
import { StructuredValueView } from '@/components/flows/structured-value-view'
import { type DataField } from '@/lib/flows/datatree'
import { splitIssuesByField, type FieldIssue } from '@/lib/flows/issue-fields'
import { NodeOptions } from '@/components/flows/node-options'
import { PanelNotice } from '@/components/flows/panel-notice'
import type { NodeOption } from '@/lib/flows/node-options'
import { type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import type { FlowContext } from '@/features/flows/context'
import { cn } from '@/lib/utils'
import { TriggerEditor, type TriggerData } from './trigger-editor'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { StepFields, InputFieldsEditor } from './step-drawer/step-fields'
import { AGENT_STEP_MODELS, DEFAULT_EDITOR_KEYS, FieldIssues, NODE_TYPES, NON_TOKEN_FOCUSED, PerItemSection, fieldClass, labelClass, orgMemberLabel, type EditableType, type OrgMember, type ToolCatalog } from './step-drawer/shared'

// Re-exported so the drawer stays the public entry point for the step editor:
// step-card, flow-canvas, graph-canvas and the flow page all import these from
// here, and moving the definitions into ./step-drawer/shared is an internal
// reorganisation those callers should not have to notice.
export { AGENT_STEP_MODELS, orgMemberLabel }
export type { EditableType, OrgMember, ToolCatalog }

export type { TriggerData }

/** Drop an empty AI-optimize config to undefined so a cleared form persists nothing. */

/** Curated chat models for the agent step's per-step override; a free-typed
 * value saved earlier stays selectable. */

/**
 * "Run once per item" control — the list-aware step contract surfaced in the
 * drawer. When on, the step fans out over `over` (a list picked from the data
 * menu), exposing {{item}} in this step's own fields, and collects the per-item
 * outputs into a list. Rendered once for every per-item-capable node type.
 */

/**
 * Multipart FILE fields on an HTTP step: bind a form field name to a file an
 * earlier step produced (a download, an upload on the run input, a subflow
 * result). The source is PICKED from the same data menu the rest of the builder
 * uses — the stored value is a plain path and the user never sees or types
 * token syntax.
 */

// Sentinel for activeFieldRef: a non-token input (raw-JSON textarea, KV key
// names, label/notes, field-name inputs, …) is focused, so datatree inserts
// must be a no-op — falling back to the step's primary field would silently
// write to a field the user is not editing.
/**
 * The validation findings one control owns, rendered directly beneath it.
 *
 * Errors read red and warnings amber, matching the checker, so the same
 * finding looks the same wherever the user meets it.
 */

// Where a datatree click lands when no chip editor has been focused yet: the
// step type's primary token field (mirrors the old default-accessor behavior).

/** Workspace member as returned by GET /api/organizations/members. */

export function StepDrawer({
  node,
  flowId,
  agents,
  members,
  toolCatalog,
  dataFields,
  labelCtx,
  previewCtx,
  variableNames,
  issues,
  published,
  onFlowPersisted,
  rawInput,
  rawInputInferred,
  rawOutput,
  rawLogs,
  mockData,
  layout = 'drawer',
  navigation,
  onNavigate,
  onRefreshAgents,
  onChange,
  onAddStep,
  onDuplicate,
  onDelete,
  onClose,
  onExecuteStep,
  onExecuteOnly,
  onExecutePrevious,
  onSetMockData,
}: {
  node: FlowNode
  flowId: string
  agents: { id: string; title: string }[]
  members?: OrgMember[]
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  previewCtx?: FlowContext
  variableNames?: string[]
  issues?: FieldIssue[]
  published?: boolean
  onFlowPersisted?: (updatedAt: string) => void
  rawInput?: unknown
  /** True when rawInput was inferred (parent outputs / run input) rather than
   * read off the recorded step row — the pane labels it so a debugging user
   * knows they are not looking at ground truth. */
  rawInputInferred?: boolean
  rawOutput?: unknown
  rawLogs?: string[]
  mockData?: unknown
  layout?: 'drawer' | 'workspace'
  /**
   * Where this step sits in the flow, so the header can walk to its neighbours.
   * Testing a flow means opening each step in turn; without this the only way
   * between two steps is close → find on canvas → reopen.
   */
  navigation?: {
    /** 1-based position, for the "3 / 8" readout. */
    index: number
    total: number
    previous?: { id: string; label: string }
    next?: { id: string; label: string }
  }
  onNavigate?: (nodeId: string) => void
  /** Re-fetch the agents list after an inline agent create, so the select shows the new agent's title. */
  onRefreshAgents?: () => void
  onChange: (node: FlowNode) => void
  onChangeType?: (type: EditableType) => void
  onExecuteStep?: () => void
  /** Run ONLY this step, replaying the last run's upstream outputs. */
  onExecuteOnly?: () => void
  onExecutePrevious?: () => void
  onSetMockData?: (value: unknown | undefined) => void
  onAddStep?: (type: EditableType) => void
  onDuplicate?: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const uid = useId()
  const isWorkspace = layout === 'workspace'
  // Findings split into the ones a control owns and the ones that belong to
  // the step as a whole. `issueFor` is what each control calls to claim its own.
  const { byField: fieldIssues, rest: bannerIssues } = useMemo(() => splitIssuesByField(issues), [issues])
  const issueFor = (field: string) => fieldIssues.get(field)
  const issueCount = fieldIssues.size
  const defaultStepName = (() => {
    const base = NODE_TYPES.find((entry) => entry.value === node.type)?.label ?? node.type
    // A tool step bound to an MCP server is an MCP request. Calling it "Tool
    // call" is technically true and tells the reader nothing about which of the
    // two very different things on this canvas they are looking at.
    if (node.type !== 'tool') return base
    const bound = (node.data as { connectionId?: string }).connectionId
    if (!bound) return base
    const { plane } = parseFlowToolConnectionId(bound)
    return plane === 'mcp' || plane === 'people_ai' ? 'MCP request' : base
  })()
  // Connected MCP servers, for spotting an HTTP step that is really an MCP call.
  const [mobileWorkspaceTab, setMobileWorkspaceTab] = useState<'input' | 'configure' | 'output'>('configure')
  const [inputView, setInputView] = useState<'schema' | 'json'>('schema')
  // Editable draft of the pinned mock JSON. Reset from the graph's pinData when
  // the selected node changes; in-node edits are owned by the textarea/handlers.
  const [mockDraft, setMockDraft] = useState('')
  useEffect(() => {
    setMockDraft(mockData === undefined ? '' : JSON.stringify(mockData, null, 2))
    setMobileWorkspaceTab('configure')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  const isTrigger = node.type === 'trigger'
  const trigger = ((node.type === 'trigger' ? node.data.trigger : undefined) as TriggerData | undefined) ?? { type: 'manual' }
  // Chip-editor handles keyed by field, so a datatree click inserts a token
  // chip at the caret of the last-focused editor. Keys are looked up live at
  // insert time — an unmounted editor's map slot is null, so inserts fall back
  // to the step's default field instead of vanishing.
  const editorHandles = useRef<Map<string, TokenTextEditorHandle | null>>(new Map())
  const editorRefCallbacks = useRef<Map<string, (handle: TokenTextEditorHandle | null) => void>>(new Map())
  const activeFieldRef = useRef<string | null>(null)
  const registerEditor = (key: string) => {
    let callback = editorRefCallbacks.current.get(key)
    if (!callback) {
      callback = (handle: TokenTextEditorHandle | null) => {
        editorHandles.current.set(key, handle)
      }
      editorRefCallbacks.current.set(key, callback)
    }
    return callback
  }
  const focusEditor = (key: string) => () => {
    activeFieldRef.current = key
  }
  // While any non-token input is focused, datatree inserts are blocked
  // entirely; blur restores the normal fallback behavior.
  const blockActive = () => {
    activeFieldRef.current = NON_TOKEN_FOCUSED
  }
  const unblockActive = () => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) activeFieldRef.current = null
  }
  useEffect(() => {
    activeFieldRef.current = null
  }, [node.id])
  useEffect(() => {
    if (!isWorkspace) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      // Alt+←/→ walks to the neighbouring step. Skipped while a field has focus
      // so Option+Arrow keeps its word-wise cursor movement inside the editors.
      if (!event.altKey || !onNavigate) return
      const el = event.target as HTMLElement | null
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return
      const target = event.key === 'ArrowLeft' ? navigation?.previous : event.key === 'ArrowRight' ? navigation?.next : undefined
      if (!target) return
      event.preventDefault()
      onNavigate(target.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isWorkspace, onClose, onNavigate, navigation])

  // Insert a token chip at the caret of the last-focused editor; fall back to
  // the step's primary field when nothing has been focused yet. DataTree emits
  // braced `{{token}}`s; the chip editor takes the bare path.
  const insertToken = (token: string) => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) return
    const path = token.startsWith('{{') && token.endsWith('}}') ? token.slice(2, -2).trim() : token
    const active = activeFieldRef.current ? editorHandles.current.get(activeFieldRef.current) : null
    const fallbackKey = DEFAULT_EDITOR_KEYS[node.type]
    const editor = active ?? (fallbackKey ? editorHandles.current.get(fallbackKey) : null)
    editor?.insertToken(path)
  }

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden bg-card',
        isWorkspace ? 'rounded-2xl border border-border shadow-2xl' : 'border-l border-border',
      )}
      data-node-configuration={layout}
    >
      <div className={cn('flex items-center justify-between gap-3 overflow-x-auto border-b border-border', isWorkspace ? 'px-4 py-3 sm:px-6 sm:py-4' : 'px-4 py-3')}>
        <div className="flex min-w-0 items-center gap-3">
          {isWorkspace && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
              <Settings2 className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0">
            {isTrigger ? (
              <h2 className={cn('font-semibold', isWorkspace ? 'text-base' : 'text-sm')}>Configure trigger</h2>
            ) : (
              // Editable in place. The name was settable only from the canvas
              // card's overflow menu, which meant the panel you configure a
              // step in was the one place you could not name it — and a flow of
              // "HTTP request, HTTP request, HTTP request" is unreadable on the
              // canvas and in every run log downstream of it.
              <input
                className={cn(
                  'w-full truncate rounded-md border border-transparent bg-transparent font-semibold outline-none',
                  'hover:border-border focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100',
                  isWorkspace ? '-ml-2 px-2 py-0.5 text-base' : '-ml-1.5 px-1.5 py-0.5 text-sm',
                )}
                value={(node.data as { label?: string }).label ?? ''}
                placeholder={defaultStepName}
                aria-label="Step name"
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(event) => onChange({
                  ...node,
                  data: { ...node.data, label: event.target.value || undefined },
                } as FlowNode)}
              />
            )}
            {isWorkspace && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isTrigger ? 'Trigger settings' : `${defaultStepName} · Parameters`}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {navigation && onNavigate && navigation.total > 1 && (
            <div className="mr-1 flex items-center gap-0.5 border-r border-border pr-2.5">
              <button
                type="button"
                onClick={() => navigation.previous && onNavigate(navigation.previous.id)}
                disabled={!navigation.previous}
                aria-label="Previous step"
                title={navigation.previous ? `Previous step — ${navigation.previous.label} (⌥←)` : 'This is the first step'}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[3rem] text-center font-mono text-xs tabular-nums text-muted-foreground">
                {navigation.index}/{navigation.total}
              </span>
              <button
                type="button"
                onClick={() => navigation.next && onNavigate(navigation.next.id)}
                disabled={!navigation.next}
                aria-label="Next step"
                title={navigation.next ? `Next step — ${navigation.next.label} (⌥→)` : 'This is the last step'}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
          {isWorkspace && !isTrigger && onExecuteOnly && (
            <Button type="button" size="sm" variant="outline" onClick={onExecuteOnly} title="Runs only this step, using the last run's data for the steps before it">
              <Play className="mr-1.5 h-4 w-4" /> Only this step
            </Button>
          )}
          {isWorkspace && !isTrigger && onExecuteStep && (
            <Button type="button" size="sm" onClick={onExecuteStep}>
              <Play className="mr-1.5 h-4 w-4" /> Execute step
            </Button>
          )}
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className={isWorkspace ? 'h-5 w-5' : 'h-4 w-4'} />
          </button>
        </div>
      </div>

      {isWorkspace && (
        <div className="grid shrink-0 grid-cols-3 border-b border-border bg-slate-50/70 p-1 lg:hidden" role="tablist" aria-label="Step workspace">
          {(['input', 'configure', 'output'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mobileWorkspaceTab === tab}
              onClick={() => setMobileWorkspaceTab(tab)}
              className={cn('rounded-md px-2 py-2 text-xs font-semibold capitalize', mobileWorkspaceTab === tab ? 'bg-white text-indigo-700 shadow-1' : 'text-muted-foreground')}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      <div className={cn('min-h-0 flex-1', isWorkspace && 'grid lg:grid-cols-[minmax(250px,0.8fr)_minmax(480px,1.25fr)_minmax(250px,0.8fr)]')}>
        {isWorkspace && (
          <aside className={cn('min-h-0 flex-col border-r border-border bg-slate-50/70', mobileWorkspaceTab === 'input' ? 'flex' : 'hidden', 'lg:flex')}>
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-indigo-600" />
                  <p className="text-sm font-semibold">Input</p>
                </div>
                {/* Schema vs JSON. The configure column hides its inline data
                    picker at this width and hands the job to this pane, so
                    without a schema view the widest layout was the one with no
                    way to put upstream data into a field at all. */}
                <div className="flex rounded-md border border-border bg-white p-0.5" role="tablist" aria-label="Input view">
                  {(['schema', 'json'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      role="tab"
                      aria-selected={inputView === view}
                      onClick={() => setInputView(view)}
                      className={cn(
                        'rounded px-2 py-0.5 text-[11px] font-semibold capitalize transition-colors',
                        inputView === view ? 'bg-indigo-50 text-indigo-700' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {view}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {inputView === 'schema'
                  ? 'The data this step can read. Click a value to add it to the field you are editing.'
                  : 'Raw JSON this step received on the selected run — its resolved input, or the upstream data feeding it.'}
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              {rawInputInferred && rawInput !== undefined && inputView === 'json' && (
                <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  Inferred from upstream outputs — this step did not record an input on the selected run.
                </p>
              )}
              {inputView === 'schema' ? (
                <DataTree
                  fields={dataFields}
                  onInsert={insertToken}
                  title="Available data"
                  emptyMessage="No earlier step data is available yet — run the steps before this one to see what they produce."
                />
              ) : (
                rawInput === undefined ? (
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100">
                    {'No input data yet.\nExecute the previous nodes to inspect their raw output here.'}
                  </pre>
                ) : (
                  <StructuredValueView value={rawInput} maxHeight="max-h-[28rem]" />
                )
              )}
              {!isTrigger && onExecutePrevious && rawInput === undefined && (
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={onExecutePrevious}>
                  <Play className="mr-1.5 h-4 w-4" /> Execute previous nodes
                </Button>
              )}
            </div>
          </aside>
        )}

        <div className={cn('min-h-0 min-w-0 flex-col', !isWorkspace || mobileWorkspaceTab === 'configure' ? 'flex' : 'hidden', 'lg:flex')}>
          <div
            className={cn(
              'flex-1 space-y-5 overflow-y-auto',
              isWorkspace
                ? 'mx-auto w-full max-w-4xl p-6 md:p-8 md:[&_[data-flow-data-tree]]:hidden'
                : 'p-4',
            )}
          >
        {/* A disabled step keeps every setting below and runs none of them.
            Without saying so, the panel for a skipped step looks exactly like
            the panel for a live one — and now that the toggle lives here, that
            silence is right where someone would flip it. */}
        {node.disabled && (
          <PanelNotice tone="warning">
            This step is disabled — the flow skips it and carries on with the value from the step before it.
          </PanelNotice>
        )}
        {/* Only the findings no single control owns. Everything else is
            rendered at its field by <FieldIssues>, so "which box is wrong" is
            answered by looking at the box rather than by matching a sentence
            in a banner to one of a dozen inputs. */}
        {bannerIssues.length > 0 && (
          <div
            className={cn(
              'rounded-md border p-3 text-sm',
              bannerIssues.some((issue) => issue.level === 'error') ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50',
            )}
          >
            <p className="font-semibold text-slate-900">This step needs attention</p>
            <ul className="mt-2 space-y-1.5">
              {[...bannerIssues]
                .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
                .map((issue, issueIndex) => (
                  <li key={issueIndex} className="flex items-start gap-2 text-slate-700">
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', issue.level === 'error' ? 'bg-red-500' : 'bg-amber-500')} />
                    <span className="min-w-0">{issue.message}</span>
                  </li>
                ))}
            </ul>
          </div>
        )}
        {fieldIssues.size > 0 && bannerIssues.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {issueCount === 1 ? 'One field below needs attention.' : `${issueCount} fields below need attention.`}
          </p>
        )}
        {isTrigger && <FieldIssues issues={issueFor('trigger')} />}
        {isTrigger ? (
          <TriggerEditor
            flowId={flowId}
            trigger={trigger}
            onChange={(nextTrigger) => onChange({ ...node, data: { trigger: nextTrigger } })}
            published={published}
            toolCatalog={toolCatalog}
            onPersisted={onFlowPersisted}
          >
            <InputFieldsEditor
              fields={trigger.inputFields ?? []}
              onChange={(inputFields) => onChange({ ...node, data: { trigger: { ...trigger, inputFields: inputFields.length ? inputFields : undefined } } })}
            />
            <FieldIssues issues={issueFor('inputFields')} />
          </TriggerEditor>
        ) : (
          <>
            {/* Step type selector removed — a node's type is fixed once added. */}
            {/* The name lives in the header now — one rename affordance, in the
                place n8n puts it, and HTTP steps get it too instead of being
                the one type you could not name from its own panel. Notes stay
                hidden for HTTP so its Parameters view stays lean. */}
            {node.type !== 'http' && (
              <>
                {typeof (node.data as { note?: string }).note === 'string' ? (
                  <div>
                    <label className={labelClass} htmlFor={`${uid}-step-note`}>Notes</label>
                    <textarea
                      id={`${uid}-step-note`}
                      rows={2}
                      className={fieldClass}
                      onKeyDown={indentOnTab}
                      value={(node.data as { note?: string }).note ?? ''}
                      placeholder="Why this step exists, gotchas, links…"
                      onFocus={blockActive}
                      onBlur={(e) => {
                        unblockActive()
                        // An emptied note disappears back to the "Add a note" link.
                        if (!e.target.value.trim()) onChange({ ...node, data: { ...node.data, note: undefined } } as FlowNode)
                      }}
                      onChange={(e) => onChange({ ...node, data: { ...node.data, note: e.target.value } } as FlowNode)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="self-start text-xs font-semibold text-primary hover:underline"
                    onClick={() => onChange({ ...node, data: { ...node.data, note: '' } } as FlowNode)}
                  >
                    + Add a note
                  </button>
                )}
              </>
            )}
            {/* Per-item fan-out used to render HERE, above Method and URL — the
                first control on every step, and an advanced one. n8n keeps this
                class of setting out of the parameter list entirely; ours now
                sits with the other run-behaviour settings at the bottom, so the
                panel opens on what the step actually does. */}
          </>
        )}

        <StepFields
          node={node}
          onChange={onChange}
          onAddStep={onAddStep}
          issueFor={issueFor}
          flowId={flowId}
          agents={agents}
          members={members}
          toolCatalog={toolCatalog}
          variableNames={variableNames}
          previewCtx={previewCtx}
          rawInput={rawInput}
          onRefreshAgents={onRefreshAgents}
          dataFields={dataFields}
          labelCtx={labelCtx}
          registerEditor={registerEditor}
          focusEditor={focusEditor}
          insertToken={insertToken}
          blockActive={blockActive}
          unblockActive={unblockActive}
        />
            {/* ONE Options collection, at the end of every step's parameters,
                where n8n puts it. Per-item, retries, timeout, on-error and the
                rest are options now — added when you want them, absent when you
                do not — replacing an "Advanced parameters" panel per node type
                and a per-item section that opened above the step's own fields.

                The HTTP step renders its own collection higher up, because it
                is the only type with nested editors (pagination, response
                trimming) that the collection has to show and hide. */}
            {!isTrigger && node.type !== 'http' && (
              <NodeOptions
                node={node}
                onChange={onChange}
                renderCustom={(option: NodeOption) =>
                  option.key === 'perItem' ? (
                    <PerItemSection
                      node={node}
                      onChange={onChange}
                      dataFields={dataFields}
                      labelCtx={labelCtx}
                      registerEditor={registerEditor}
                      focusEditor={focusEditor}
                      insertToken={insertToken}
                    />
                  ) : null
                }
              />
            )}
          </div>

          {!isTrigger && (
            <div className={cn('flex gap-2 border-t border-border', isWorkspace ? 'justify-end bg-slate-50/70 px-6 py-3' : 'p-4')}>
              {/* Disabling is how you take a step out of the run without
                  losing its configuration — it belonged next to Delete, not
                  only in the canvas card's overflow menu. */}
              {node.type !== 'condition' && node.type !== 'switch' && (
                <Button
                  variant="outline"
                  className={cn(isWorkspace ? 'mr-auto' : 'flex-1', node.disabled && 'border-amber-300 text-amber-700')}
                  onClick={() => onChange({ ...node, disabled: node.disabled ? undefined : true } as FlowNode)}
                >
                  {node.disabled ? <ToggleRight className="mr-1.5 h-4 w-4" /> : <ToggleLeft className="mr-1.5 h-4 w-4" />}
                  {node.disabled ? 'Enable step' : 'Disable step'}
                </Button>
              )}
              {onDuplicate && (
                <Button variant="outline" className={isWorkspace ? '' : 'flex-1'} onClick={onDuplicate}>
                  <Copy className="mr-1.5 h-4 w-4" /> Duplicate
                </Button>
              )}
              <Button variant="outline" className={cn('text-red-600 hover:text-red-700', !isWorkspace && 'flex-1')} onClick={onDelete}>
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete
              </Button>
            </div>
          )}
        </div>
        {isWorkspace && (
          <aside className={cn('min-h-0 flex-col border-l border-border bg-slate-50/70', mobileWorkspaceTab === 'output' ? 'flex' : 'hidden', 'lg:flex')}>
            <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <Braces className="h-4 w-4 text-indigo-600" />
                  <p className="text-sm font-semibold">Output</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {mockData !== undefined ? 'Mock data is pinned — this node is not executed.' : 'Raw output from this node’s latest run.'}
                </p>
              </div>
              {!isTrigger && onSetMockData && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => {
                    if (mockData !== undefined) { onSetMockData(undefined); return }
                    const seed = rawOutput !== undefined ? rawOutput : { example: 'value' }
                    onSetMockData(seed)
                    setMockDraft(JSON.stringify(seed, null, 2))
                  }}
                >
                  <Pin className="mr-1 h-3.5 w-3.5" />
                  {mockData !== undefined ? 'Clear mock' : 'Set mock data'}
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {mockData !== undefined ? (
                <div className="space-y-2">
                  <textarea
                    className="min-h-40 w-full resize-y rounded-lg border border-amber-500/40 bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/50"
                    value={mockDraft}
                    spellCheck={false}
                    onKeyDown={indentOnTab}
                    onFocus={blockActive}
                    onBlur={() => {
                      unblockActive()
                      try {
                        onSetMockData?.(JSON.parse(mockDraft))
                      } catch {
                        toast.error('Mock data must be valid JSON.')
                      }
                    }}
                    onChange={(event) => setMockDraft(event.target.value)}
                    aria-label="Mock output data"
                  />
                  <p className="text-[11px] leading-4 text-muted-foreground">Edit the pinned JSON, then click away to save. Downstream nodes use this value until you clear the mock.</p>
                </div>
              ) : (
                <>
                  {/* The same viewer the Runs panel uses: table view for a list
                      of records, search, and a row count. This pane rendered a
                      raw <pre>, so the one place you inspect a step's output
                      while configuring it was the one place you could not read
                      a 200-row response. */}
                  {rawOutput === undefined ? (
                    <pre className="min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100">
                      {'No output data yet.\nExecute this step to inspect its response here.'}
                    </pre>
                  ) : (
                    <StructuredValueView value={rawOutput} maxHeight="max-h-[28rem]" />
                  )}
                  {!isTrigger && onExecuteStep && rawOutput === undefined && (
                    <Button type="button" variant="outline" size="sm" className="w-full" onClick={onExecuteStep}>
                      <Play className="mr-1.5 h-4 w-4" /> Execute step
                    </Button>
                  )}
                </>
              )}
              {rawLogs && rawLogs.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Logs</p>
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-500/30 bg-amber-950/40 p-3 font-mono text-[11px] leading-5 text-amber-100">
                    {rawLogs.join('\n')}
                  </pre>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

