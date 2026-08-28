'use client'

import { useId } from 'react'
import { useRef, useState } from 'react'
import { AgentInlineCreate } from '../agent-inline-create'
import { useWorkspaceFlows } from '../use-workspace-flows'
import { CodeAssist } from '@/components/flows/code-assist'
import { CodeEditor } from '@/components/flows/code-editor'
import { DataTree } from '@/components/flows/data-tree'
import { PanelNotice } from '@/components/flows/panel-notice'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import { ToolArgsEditor, schemaFields } from '@/components/flows/tool-args-editor'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { Button } from '@/components/ui/button'
import { indentOnTab } from '@/components/ui/textarea'
import { type FlowContext } from '@/features/flows/context'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { operatorsForField } from '@/lib/flows/condition-ops'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { type DataField } from '@/lib/flows/datatree'
import { AI_OPS, AI_OP_LABELS, type AiOp, CONDITION_OP_LABELS, type ConditionClause, type ConditionOp, DATA_OPS, type DataOp, FIELD_TYPES, type FieldType, type FlowNode, type OutputField, type TriggerInputField, UNARY_CONDITION_OPS, VARIABLE_OPS, VARIABLE_OP_LABELS, VARIABLE_TYPES, VARIABLE_TYPE_LABELS, type VariableOp, type VariableType } from '@/lib/flows/graph'
import { type FieldIssue } from '@/lib/flows/issue-fields'
import { pruneArgLabels } from '@/lib/flows/resource-locator'
import { DATA_OP_HELPER, DATA_OP_INPUT_PLACEHOLDER, SUMMARIZE_OPS, SUMMARIZE_OP_LABELS, VARIABLE_VALUE_PLACEHOLDER, variableValueOptional } from '@/lib/flows/step-copy'
import { type TokenLabelContext } from '@/lib/flows/token-text'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { groupToolConnections, selectedToolPresentation, toolActionChoices } from '@/lib/flows/tool-presentation'
import { Plus, Trash2 } from 'lucide-react'
import {
  type EditableType,
  FieldIssues,
  NODE_TYPES,
  type OrgMember,
  type TokenEditorPlumbing,
  type ToolCatalog,
  areaClass,
  fieldClass,
  labelClass,
  orgMemberLabel,
  smallField,
} from './shared'
import { HttpStepFields } from './http-step-fields'

/**
 * The per-step-kind fields: one flat branch per node type, exactly as they
 * appeared in the drawer.
 *
 * This is the drawer's content; StepDrawer is now its chrome — the header,
 * the tabs, the input/output panels, the run controls, the footer. That split
 * was invisible while both lived in one 2,437-line component, and the shape of
 * this file is the argument for it: twenty-one sibling branches that share a
 * context and nothing else. A new step kind is one branch here, not another
 * hundred lines in the middle of the drawer.
 *
 * HTTP is the exception and has its own module — it carried seven state hooks
 * and two dialogs of its own, which is what made it worth separating rather
 * than merely indenting.
 */

type Props = {
  node: FlowNode
  onChange: (node: FlowNode) => void
  onAddStep?: (type: EditableType) => void
  issueFor: (field: string) => FieldIssue[] | undefined
  flowId: string
  agents: { id: string; title: string }[]
  members?: OrgMember[]
  toolCatalog: ToolCatalog
  variableNames?: string[]
  previewCtx?: FlowContext
  rawInput?: unknown
  onRefreshAgents?: () => void
} & TokenEditorPlumbing

export function StepFields({
  node,
  onChange,
  onAddStep,
  issueFor,
  flowId,
  agents,
  members,
  toolCatalog,
  variableNames,
  previewCtx,
  rawInput,
  onRefreshAgents,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: Props) {
  const uid = useId()
  return (
    <>
    {node.type === 'agent' && (
      <>
        <div>
          <label className={labelClass} htmlFor={`${uid}-agent`}>Agent</label>
          <select id={`${uid}-agent`} className={fieldClass} value={node.data.agentId} onChange={(e) => onChange({ ...node, data: { ...node.data, agentId: e.target.value } })}>
            <option value="">Select an agent…</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
          <FieldIssues issues={issueFor('agentId')} />
        </div>
        {!node.data.agentId && (
          <AgentInlineCreate
            onCreated={(agent) => {
              onChange({ ...node, data: { ...node.data, agentId: agent.id } })
              onRefreshAgents?.()
            }}
          />
        )}
        <div>
          <span className={labelClass}>Message to agent</span>
          <TokenTextEditor
            ref={registerEditor('agent.input')}
            previewCtx={previewCtx}
            multiline
            rows={6}
            value={node.data.input ?? ''}
            labelCtx={labelCtx}
            placeholder="Tell the agent what to do. Add flow data from the picker below when needed."
            onFocus={focusEditor('agent.input')}
            onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
            ariaLabel="Message to agent"
          />
          <FieldIssues issues={issueFor('input')} />
          <div className="mt-2">
            <DataTree fields={dataFields} onInsert={insertToken} />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-upstream`}>Data from earlier steps</label>
          <select
            id={`${uid}-upstream`}
            className={fieldClass}
            value={node.data.includeUpstreamContext === true ? 'on' : 'off'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, includeUpstreamContext: e.target.value === 'on' } })}
          >
            <option value="on">Include every earlier step&apos;s data (recommended)</option>
            <option value="off">Only what the message references</option>
          </select>
          <p className="mt-1.5 text-xs text-muted-foreground">
            When on, the data captured by the API and other steps before this one is added to the
            agent&apos;s context automatically — so it has everything it needs without wiring each token.
          </p>
        </div>
        {/* Chat model, memory, and tool grants are n8n-style sub-nodes ON
            THE CANVAS, under the step — each opens its own config panel.
            Keeping them out of this drawer keeps agent + message the whole
            story here, and gives every attachment one obvious home. */}
        <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
          Chat model, memory, and extra tools attach <span className="font-medium text-foreground">under this step on the canvas</span> — click an
          attachment there to configure it.
        </p>

        <div>
          <label className={labelClass} htmlFor={`${uid}-tool-policy`}>Tools this step may use</label>
          <select
            id={`${uid}-tool-policy`}
            className={fieldClass}
            value={node.data.toolPolicy?.mode ?? 'inherit'}
            onChange={(e) => {
              const mode = e.target.value as 'inherit' | 'readonly' | 'none'
              onChange({
                ...node,
                data: { ...node.data, toolPolicy: mode === 'inherit' ? undefined : { mode } },
              })
            }}
          >
            <option value="inherit">Everything the agent has</option>
            <option value="readonly">Read-only — no sending, creating, or deleting</option>
            <option value="none">No tools — reasoning only</option>
          </select>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Read-only is the safe choice for steps that summarize or analyze: even if the content this
            step reads tries to steer the agent, there is nothing here that can send or change data.
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-human-assist`}>Human assistance</label>
          <select
            id={`${uid}-human-assist`}
            className={fieldClass}
            value={node.data.humanAssistance === false ? 'off' : 'on'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, humanAssistance: e.target.value === 'off' ? false : undefined } })}
          >
            <option value="on">Pause and ask when unsure</option>
            <option value="off">Never ask — fail instead</option>
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-response-format`}>Agent response</label>
          <select
            id={`${uid}-response-format`}
            className={fieldClass}
            value={node.data.responseFormat ?? 'text'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, responseFormat: e.target.value === 'structured' ? 'structured' : undefined } })}
          >
            <option value="text">Text only</option>
            <option value="structured">Structured (JSON matching output fields)</option>
          </select>
          {node.data.responseFormat === 'structured' && !(node.data.outputFields ?? []).some((f) => f.name.trim()) && (
            <PanelNotice tone="warning" className="mt-1.5">Add at least one output field below to define the JSON shape.</PanelNotice>
          )}
        </div>
        <OutputFieldsEditor
          fields={node.data.outputFields ?? []}
          onChange={(outputFields) => onChange({ ...node, data: { ...node.data, outputFields: outputFields.length ? outputFields : undefined } })}
          blockActive={blockActive}
          unblockActive={unblockActive}
        />
      </>
    )}

    {node.type === 'ai' && (
      <>
        <div>
          <label className={labelClass} htmlFor={`${uid}-ai-op`}>Operation</label>
          <select id={`${uid}-ai-op`} className={fieldClass} value={node.data.aiOp} onChange={(e) => onChange({ ...node, data: { ...node.data, aiOp: e.target.value as AiOp } })}>
            {AI_OPS.map((op) => (
              <option key={op} value={op}>
                {AI_OP_LABELS[op]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>{node.data.aiOp === 'ask' ? 'Prompt' : 'Guidance (optional)'}</label>
          <TokenTextEditor
            ref={registerEditor('ai.instructions')}
            multiline
            rows={4}
            value={node.data.instructions ?? ''}
            labelCtx={labelCtx}
            placeholder={node.data.aiOp === 'ask' ? 'Tell AI what to do with the input.' : 'Optional extra direction for this operation.'}
            onFocus={focusEditor('ai.instructions')}
            onChange={(instructions) => onChange({ ...node, data: { ...node.data, instructions } })}
            ariaLabel="AI instructions"
          />
        </div>
        <div>
          <span className={labelClass}>Input</span>
          <TokenTextEditor
            ref={registerEditor('ai.input')}
            previewCtx={previewCtx}
            multiline
            rows={3}
            value={node.data.input ?? ''}
            labelCtx={labelCtx}
            placeholder="The content to work on — pick flow data from below."
            onFocus={focusEditor('ai.input')}
            onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
            ariaLabel="AI input"
          />
          <FieldIssues issues={issueFor('aiInput')} />
          <div className="mt-2">
            <DataTree fields={dataFields} onInsert={insertToken} />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-ai-model`}>Model</label>
          <select
            id={`${uid}-ai-model`}
            className={fieldClass}
            value={node.data.model ?? 'fast'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, model: e.target.value === 'smart' ? 'smart' : undefined } })}
          >
            <option value="fast">Fast (default)</option>
            <option value="smart">Smart (higher quality, slower)</option>
          </select>
        </div>
        {node.data.aiOp === 'extract' && (
          <OutputFieldsEditor
            fields={node.data.outputFields ?? []}
            onChange={(outputFields) => onChange({ ...node, data: { ...node.data, outputFields: outputFields.length ? outputFields : undefined } })}
            blockActive={blockActive}
            unblockActive={unblockActive}
          />
        )}
        {node.data.aiOp === 'categorize' && (
          <div>
            <span className={labelClass}>Categories</span>
            <div className="space-y-1.5">
              {(node.data.categories ?? []).map((category, i) => (
                <div key={i} className="flex gap-1.5">
                  <input
                    className={`${smallField} min-w-0 flex-1`}
                    value={category}
                    placeholder="e.g. Urgent"
                    onChange={(e) => onChange({ ...node, data: { ...node.data, categories: (node.data.categories ?? []).map((c, j) => (j === i ? e.target.value : c)) } })}
                    aria-label={`Category ${i + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => onChange({ ...node, data: { ...node.data, categories: (node.data.categories ?? []).filter((_, j) => j !== i) } })}
                    className="px-1 text-red-500 hover:text-red-700"
                    aria-label="Remove category"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onChange({ ...node, data: { ...node.data, categories: [...(node.data.categories ?? []), ''] } })}
              className="mt-1.5 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add category
            </button>
          </div>
        )}
        {node.data.aiOp === 'score' && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass} htmlFor={`${uid}-score-min`}>Lowest score</label>
              <input
                id={`${uid}-score-min`}
                type="number"
                className={fieldClass}
                value={node.data.scoreMin ?? 1}
                onChange={(e) => onChange({ ...node, data: { ...node.data, scoreMin: Number(e.target.value) } })}
                aria-label="Lowest score"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-score-max`}>Highest score</label>
              <input
                id={`${uid}-score-max`}
                type="number"
                className={fieldClass}
                value={node.data.scoreMax ?? 10}
                onChange={(e) => onChange({ ...node, data: { ...node.data, scoreMax: Number(e.target.value) } })}
                aria-label="Highest score"
              />
            </div>
          </div>
        )}

      </>
    )}

    {node.type === 'knowledge' && (
      <>
        <div>
          <span className={labelClass}>What to look for</span>
          <TokenTextEditor
            ref={registerEditor('knowledge.query')}
            multiline
            rows={3}
            value={node.data.query ?? ''}
            labelCtx={labelCtx}
            placeholder="Describe what you need — add flow data from below."
            onFocus={focusEditor('knowledge.query')}
            onChange={(query) => onChange({ ...node, data: { ...node.data, query } })}
            ariaLabel="Knowledge search query"
          />
          <FieldIssues issues={issueFor('query')} />
          <div className="mt-2">
            <DataTree fields={dataFields} onInsert={insertToken} />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-topk`}>How many passages</label>
          <input
            id={`${uid}-topk`}
            type="number"
            min={1}
            max={20}
            className={fieldClass}
            value={node.data.topK ?? 5}
            onChange={(e) => onChange({ ...node, data: { ...node.data, topK: Number(e.target.value) || undefined } })}
            aria-label="How many passages"
          />
        </div>
        <p className="text-xs text-muted-foreground">Searches the documents uploaded to your workspace and outputs the best-matching passages as a list.</p>
      </>
    )}

    {node.type === 'subflow' && (
      <SubflowDrawerSection node={node} onChange={onChange} flowId={flowId} labelCtx={labelCtx} registerEditor={registerEditor} focusEditor={focusEditor} dataFields={dataFields} insertToken={insertToken} issueFor={issueFor} />
    )}

    {node.type === 'condition' && (
      <div className="space-y-3">
        <div>
          <label className={labelClass} htmlFor={`${uid}-cond-match`}>Conditions</label>
          <select
            id={`${uid}-cond-match`}
            className={fieldClass}
            value={node.data.match ?? 'all'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value as 'all' | 'any', clauses: clausesOf(node.data), left: undefined, op: undefined, right: undefined } })}
          >
            <option value="all">All conditions (AND)</option>
            <option value="any">Any condition (OR)</option>
          </select>
        </div>
        {clausesOf(node.data).map((clause, i) => {
          const clauses = clausesOf(node.data)
          const update = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next, left: undefined, op: undefined, right: undefined } })
          return (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <TokenTextEditor
                ref={registerEditor(`cond.${i}.left`)}
                className="px-2 py-1.5"
                value={clause.left}
                labelCtx={labelCtx}
                placeholder="Choose data from below"
                onFocus={focusEditor(`cond.${i}.left`)}
                onChange={(left) => update(clauses.map((c, j) => (j === i ? { ...c, left } : c)))}
                ariaLabel={`Condition ${i + 1} value`}
              />
              <div className="flex gap-1.5">
                <select className={smallField} value={clause.op} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                  {operatorsForField(clause.left, dataFields, clause.op).map((op) => (
                    <option key={op} value={op}>
                      {CONDITION_OP_LABELS[op]}
                    </option>
                  ))}
                </select>
                <TokenTextEditor
                  ref={registerEditor(`cond.${i}.right`)}
                  className="min-w-0 flex-1 px-2 py-1.5"
                  value={clause.right}
                  labelCtx={labelCtx}
                  placeholder="80"
                  onFocus={focusEditor(`cond.${i}.right`)}
                  onChange={(right) => update(clauses.map((c, j) => (j === i ? { ...c, right } : c)))}
                  ariaLabel={`Condition ${i + 1} comparison value`}
                />
                {clauses.length > 1 && (
                  <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove Condition">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {/* n8n exposes Ignore Case on If, Filter AND Switch. Our
                  schema and evaluator have honoured it on all three since
                  it was added; only the Filter panel ever offered the
                  control, so on the other two it was a stored, working
                  setting nobody could reach. */}
              {!UNARY_CONDITION_OPS.has(clause.op) && (
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={clause.ignoreCase === true}
                    onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, ignoreCase: e.target.checked || undefined } : c)))}
                  />
                  Ignore upper/lower case
                </label>
              )}
            </div>
          )
        })}
        <button
          type="button"
          onClick={() => onChange({ ...node, data: { ...node.data, clauses: [...clausesOf(node.data), { left: '', op: 'contains', right: '' }], left: undefined, op: undefined, right: undefined } })}
          className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add Condition
        </button>
        <FieldIssues issues={issueFor('clauses')} />
        <div>
          <DataTree fields={dataFields} onInsert={insertToken} />
        </div>
      </div>
    )}

    {node.type === 'loop' && (
      <div className="space-y-3">
        <div>
          <span className={labelClass}>Items to process</span>
          <TokenTextEditor
            ref={registerEditor('loop.over')}
            value={node.data.over}
            labelCtx={labelCtx}
            placeholder="Choose a list from the available data below"
            onFocus={focusEditor('loop.over')}
            onChange={(over) => onChange({ ...node, data: { ...node.data, over } })}
            ariaLabel="Items to process"
          />
          <FieldIssues issues={issueFor('loopSource')} />
          <div className="mt-2">
            <DataTree fields={dataFields} onInsert={insertToken} />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">Accepts a JSON list, a newline list, or a comma-separated list. Nested steps run once for each item.</p>
        </div>
        {/* "At a time" is an option now — a loop runs one at a time until
            someone says otherwise, and the control was on the page whether
            or not anyone wanted it. It reads its stored value unchanged. */}
        <div>
          <label className={labelClass} htmlFor={`${uid}-loop-item-error`}>If an item fails</label>
          <select
            id={`${uid}-loop-item-error`}
            className={fieldClass}
            value={node.data.itemError ?? 'fail'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, itemError: e.target.value === 'fail' ? undefined : (e.target.value as 'skip' | 'collect') } })}
          >
            <option value="fail">Stop the whole loop</option>
            <option value="skip">Skip that item, keep the rest</option>
            <option value="collect">Keep going, record the error in its place</option>
          </select>
        </div>
        {onAddStep && (
          <AddNestedStepMenu label="Add step to loop" onPick={onAddStep} />
        )}
      </div>
    )}

    {node.type === 'parallel' && (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Runs {node.data.branches.length} branch{node.data.branches.length === 1 ? '' : 'es'} at once and merges their outputs. Click an indented card to edit a branch step.
        </p>
        {onAddStep && (
          <AddNestedStepMenu label="Add parallel branch" onPick={onAddStep} />
        )}
      </div>
    )}

    {node.type === 'tool' && (
      <ToolConfigurationSection
        node={node}
        toolCatalog={toolCatalog}
        dataFields={dataFields}
        labelCtx={labelCtx}
        issueFor={issueFor}
        onChange={onChange}
      />
    )}

    {node.type === 'http' && (
      <HttpStepFields
        node={node}
        onChange={onChange}
        issueFor={issueFor}
        previewCtx={previewCtx}
        toolCatalog={toolCatalog}
        dataFields={dataFields}
        labelCtx={labelCtx}
        registerEditor={registerEditor}
        focusEditor={focusEditor}
        insertToken={insertToken}
        blockActive={blockActive}
        unblockActive={unblockActive}
      />
    )}

    {node.type === 'transform' && (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Create named fields for later steps to use.</p>
        {node.data.fields.map((field, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
            <div className="flex gap-1.5">
              <input
                className={`${smallField} flex-1`}
                value={field.name}
                placeholder="fieldName"
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => onChange({ ...node, data: { ...node.data, fields: node.data.fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)) } })}
              />
              <select
                className={`${smallField} w-24`}
                value={field.type ?? 'any'}
                aria-label={`Type for field ${field.name || i + 1}`}
                onChange={(e) => onChange({ ...node, data: { ...node.data, fields: node.data.fields.map((f, j) => (j === i ? { ...f, type: e.target.value === 'any' ? undefined : (e.target.value as FieldType) } : f)) } })}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{t === 'any' ? 'As-is' : t}</option>
                ))}
              </select>
              <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, fields: node.data.fields.filter((_, j) => j !== i) } })} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove field">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <TokenTextEditor
              ref={registerEditor(`xf.${i}`)}
              className="px-2 py-1.5"
              value={field.value}
              labelCtx={labelCtx}
              placeholder="Value for this field"
              onFocus={focusEditor(`xf.${i}`)}
              onChange={(value) => onChange({ ...node, data: { ...node.data, fields: node.data.fields.map((f, j) => (j === i ? { ...f, value } : f)) } })}
              ariaLabel={`Value for field ${field.name || i + 1}`}
            />
          </div>
        ))}
        <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, fields: [...node.data.fields, { name: '', value: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
          <Plus className="h-3.5 w-3.5" /> Add Field
        </button>
        <FieldIssues issues={issueFor('fields')} />
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={node.data.includeOtherFields === true}
            onChange={(e) => onChange({ ...node, data: { ...node.data, includeOtherFields: e.target.checked || undefined } })}
          />
          Include Other Input Fields
        </label>
        {/* WHICH ones, not just whether. All-or-nothing forces a choice
            between dragging an entire upstream record downstream or
            re-mapping every field you wanted to keep. */}
        {node.data.includeOtherFields === true && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-set-include-mode`}>Include in Output</label>
            <select
              id={`${uid}-set-include-mode`}
              className={fieldClass}
              value={node.data.includeMode ?? 'all'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, includeMode: e.target.value === 'all' ? undefined : (e.target.value as 'selected' | 'except') } })}
            >
              <option value="all">All Input Fields</option>
              <option value="selected">Selected Input Fields</option>
              <option value="except">All Input Fields Except</option>
            </select>
            {node.data.includeMode !== undefined && node.data.includeMode !== 'all' && (
              <input
                className={`${fieldClass} mt-1.5`}
                value={(node.data.includeFields ?? []).join(', ')}
                placeholder="id, name, owner"
                aria-label={node.data.includeMode === 'selected' ? 'Fields to Include' : 'Fields to Exclude'}
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => onChange({
                  ...node,
                  data: {
                    ...node.data,
                    includeFields: e.target.value.split(',').map((field) => field.trim()).filter(Boolean),
                  },
                })}
              />
            )}
          </div>
        )}
        <div>
          <DataTree fields={dataFields} onInsert={insertToken} />
        </div>
      </div>
    )}

    {node.type === 'filter' && (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Continue only when this passes. Inside a For-each, a failing item is dropped from the results.</p>
        <select className={fieldClass} value={node.data.match ?? 'all'} onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value as 'all' | 'any', clauses: clausesOf(node.data) } })}>
          <option value="all">Match all (AND)</option>
          <option value="any">Match any (OR)</option>
        </select>
        {clausesOf(node.data).map((clause, i) => {
          const clauses = clausesOf(node.data)
          const update = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next } })
          return (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <TokenTextEditor ref={registerEditor(`filt.${i}.left`)} className="px-2 py-1.5" value={clause.left} labelCtx={labelCtx} placeholder="Choose data from below" onFocus={focusEditor(`filt.${i}.left`)} onChange={(left) => update(clauses.map((c, j) => (j === i ? { ...c, left } : c)))} ariaLabel={`Filter ${i + 1} value`} />
              <div className="flex gap-1.5">
                <select className={smallField} value={clause.op} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                  {operatorsForField(clause.left, dataFields, clause.op).map((op) => <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>)}
                </select>
                {!UNARY_CONDITION_OPS.has(clause.op) && (
                  <TokenTextEditor ref={registerEditor(`filt.${i}.right`)} className="min-w-0 flex-1 px-2 py-1.5" value={clause.right} labelCtx={labelCtx} placeholder="80" onFocus={focusEditor(`filt.${i}.right`)} onChange={(right) => update(clauses.map((c, j) => (j === i ? { ...c, right } : c)))} ariaLabel={`Filter ${i + 1} comparison value`} />
                )}
                {clauses.length > 1 && (
                  <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove Condition"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <input type="checkbox" checked={clause.ignoreCase === true} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, ignoreCase: e.target.checked || undefined } : c)))} />
                Ignore upper/lower case
              </label>
            </div>
          )
        })}
        <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, clauses: [...clausesOf(node.data), { left: '', op: 'contains', right: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
          <Plus className="h-3.5 w-3.5" /> Add Condition
        </button>
        <FieldIssues issues={issueFor('clauses')} />
        <div><DataTree fields={dataFields} onInsert={insertToken} /></div>
      </div>
    )}

    {node.type === 'switch' && (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">The first matching case routes the flow; anything unmatched follows the <strong>default</strong> branch on the canvas.</p>
        {node.data.cases.map((c, i) => (
          <div key={c.id} className="space-y-1.5 rounded-lg border border-border/70 p-2">
            <div className="flex gap-1.5">
              <input className={`${smallField} flex-1`} value={c.label ?? ''} placeholder={`Case ${i + 1} label`} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} />
              {node.data.cases.length > 1 && (
                <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, cases: node.data.cases.filter((_, j) => j !== i) } })} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove Routing Rule"><Trash2 className="h-4 w-4" /></button>
              )}
            </div>
            <TokenTextEditor ref={registerEditor(`sw.${i}.left`)} className="px-2 py-1.5" value={c.left} labelCtx={labelCtx} placeholder="Choose data from below" onFocus={focusEditor(`sw.${i}.left`)} onChange={(left) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, left } : x)) } })} ariaLabel={`Case ${i + 1} value`} />
            <div className="flex gap-1.5">
              <select className={smallField} value={c.op} onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, op: e.target.value as ConditionOp } : x)) } })}>
                {operatorsForField(c.left, dataFields, c.op).map((op) => <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>)}
              </select>
              <TokenTextEditor ref={registerEditor(`sw.${i}.right`)} className="min-w-0 flex-1 px-2 py-1.5" value={c.right} labelCtx={labelCtx} placeholder="enterprise" onFocus={focusEditor(`sw.${i}.right`)} onChange={(right) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, right } : x)) } })} ariaLabel={`Case ${i + 1} comparison value`} />
            </div>
            {!UNARY_CONDITION_OPS.has(c.op) && (
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={c.ignoreCase === true}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, ignoreCase: e.target.checked || undefined } : x)) } })}
                />
                Ignore upper/lower case
              </label>
            )}
          </div>
        ))}
        <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, cases: [...node.data.cases, { id: `case${node.data.cases.length + 1}-${Math.random().toString(36).slice(2, 6)}`, left: '', op: 'contains', right: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
          <Plus className="h-3.5 w-3.5" /> Add Routing Rule
        </button>
        <FieldIssues issues={issueFor('cases')} />
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={node.data.allMatches === true}
            onChange={(e) => onChange({ ...node, data: { ...node.data, allMatches: e.target.checked || undefined } })}
          />
          Send data to all matching outputs
        </label>
        <div><DataTree fields={dataFields} onInsert={insertToken} /></div>
      </div>
    )}

    {node.type === 'stop' && (
      <div className="space-y-3">
        <div>
          <label className={labelClass} htmlFor={`${uid}-stop-error-type`}>Error Type</label>
          <select
            id={`${uid}-stop-error-type`}
            className={fieldClass}
            value={node.data.errorType ?? 'none'}
            onChange={(e) => {
              const value = e.target.value
              onChange({
                ...node,
                data: {
                  ...node.data,
                  errorType: value === 'none' ? undefined : (value as 'errorMessage' | 'errorObject'),
                },
              })
            }}
          >
            {/* Ours has a third state n8n does not: end the run without
                failing it. It is what every flow saved before this does, so
                it stays the default — "we are done here" and "this is
                wrong" are different endings and both are worth having. */}
            <option value="none">Stop without an error</option>
            <option value="errorMessage">Error Message</option>
            <option value="errorObject">Error Object</option>
          </select>
        </div>

        {node.data.errorType === undefined && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-stop-reason`}>Reason</label>
            <input
              id={`${uid}-stop-reason`}
              className={fieldClass}
              value={node.data.reason ?? ''}
              placeholder="Why the flow stops here"
              onChange={(e) => onChange({ ...node, data: { ...node.data, reason: e.target.value } })}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">Ends the flow early; later steps are skipped and the run is not a failure.</p>
          </div>
        )}

        {node.data.errorType === 'errorMessage' && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-stop-error-message`}>Error Message</label>
            <input
              id={`${uid}-stop-error-message`}
              className={fieldClass}
              value={node.data.errorMessage ?? ''}
              placeholder="An error occurred!"
              onChange={(e) => onChange({ ...node, data: { ...node.data, errorMessage: e.target.value } })}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">The run fails here, and this is what it reports.</p>
          </div>
        )}

        {node.data.errorType === 'errorObject' && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-stop-error-object`}>Error Object</label>
            <textarea
              id={`${uid}-stop-error-object`}
              rows={4}
              className={areaClass}
              onKeyDown={indentOnTab}
              value={node.data.errorObject ?? ''}
              placeholder={'{ "message": "Quota exceeded", "code": 429 }'}
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, errorObject: e.target.value } })}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">The run fails here. A <code>message</code> inside the object is what it reports; the whole object travels with it.</p>
          </div>
        )}
      </div>
    )}

    {node.type === 'variable' && (
      <VariableEditor
        node={node}
        variableNames={variableNames ?? []}
        issueFor={issueFor}
        onChange={onChange}
        dataFields={dataFields}
        labelCtx={labelCtx}
        registerEditor={registerEditor}
        focusEditor={focusEditor}
        insertToken={insertToken}
        blockActive={blockActive}
        unblockActive={unblockActive}
      />
    )}

    {node.type === 'data' && (
      <DataEditor
        node={node}
        issueFor={issueFor}
        onChange={onChange}
        dataFields={dataFields}
        labelCtx={labelCtx}
        registerEditor={registerEditor}
        focusEditor={focusEditor}
        insertToken={insertToken}
        blockActive={blockActive}
        unblockActive={unblockActive}
      />
    )}

    {node.type === 'humanReview' && (
      <div className="space-y-3">
        <div>
          <span className={labelClass}>Message</span>
          <TokenTextEditor
            ref={registerEditor('hr.message')}
            multiline
            rows={5}
            value={node.data.message}
            labelCtx={labelCtx}
            placeholder="What should the person be asked? Their reply becomes this step's output."
            onFocus={focusEditor('hr.message')}
            onChange={(message) => onChange({ ...node, data: { ...node.data, message } })}
            ariaLabel="Message"
          />
          <FieldIssues issues={issueFor('reviewMessage')} />
          <div className="mt-2">
            <DataTree fields={dataFields} onInsert={insertToken} />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-hr-assignee`}>Assign to (optional)</label>
          {/* Empty value = engine default (the run owner is asked). A stored
              assignee missing from the roster (departed member) stays selected
              as "Former member" so opening the editor never rewrites data. */}
          <select
            id={`${uid}-hr-assignee`}
            className={fieldClass}
            value={node.data.assigneeUserId ?? ''}
            onChange={(e) => onChange({ ...node, data: { ...node.data, assigneeUserId: e.target.value || undefined } })}
          >
            <option value="">Flow owner (default)</option>
            {(members ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {orgMemberLabel(member)}
              </option>
            ))}
            {node.data.assigneeUserId && !(members ?? []).some((member) => member.id === node.data.assigneeUserId) && (
              <option value={node.data.assigneeUserId}>Former member</option>
            )}
          </select>
          <p className="mt-1.5 text-xs text-muted-foreground">They&apos;ll be notified when the flow pauses here.</p>
        </div>
      </div>
    )}

    {node.type === 'output' && (
      <OutputEditor
        node={node}
        issueFor={issueFor}
        onChange={onChange}
        dataFields={dataFields}
        labelCtx={labelCtx}
        registerEditor={registerEditor}
        focusEditor={focusEditor}
        insertToken={insertToken}
        blockActive={blockActive}
        unblockActive={unblockActive}
      />
    )}

    {node.type === 'code' && (
      <>
        <div>
          <label className={labelClass} htmlFor={`${uid}-code-mode`}>Mode</label>
          <select id={`${uid}-code-mode`} className={fieldClass} value={node.data.mode} onChange={(e) => onChange({ ...node, data: { ...node.data, mode: e.target.value === 'each' ? 'each' : 'all' } })}>
            <option value="all">Run once for all input</option>
            <option value="each">Run once for each item</option>
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-code-language`}>Language</label>
          <select
            id={`${uid}-code-language`}
            className={fieldClass}
            value={node.data.language}
            onChange={(e) => {
              const language = e.target.value === 'python' ? 'python' : 'javascript'
              const wasDefault = node.data.code.trim() === 'return input;' || node.data.code.trim() === 'return input'
              onChange({ ...node, data: { ...node.data, language, code: wasDefault ? (language === 'python' ? 'return input' : 'return input;') : node.data.code } })
            }}
          >
            <option value="javascript">JavaScript</option>
            <option value="python">Python</option>
          </select>
        </div>
        <div>
          <span className={labelClass}>Input</span>
          <TokenTextEditor
            ref={registerEditor('code.input')}
            multiline
            rows={3}
            value={node.data.input ?? ''}
            labelCtx={labelCtx}
            placeholder="Choose the data made available as input."
            onFocus={focusEditor('code.input')}
            onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
            ariaLabel="Code input"
          />
          <div className="mt-2">
            <DataTree fields={dataFields} onInsert={insertToken} />
          </div>
        </div>
        <CodeAssist
          language={node.data.language === 'python' ? 'python' : 'javascript'}
          mode={node.data.mode === 'each' ? 'each' : 'all'}
          inputSample={rawInput !== undefined ? JSON.stringify(rawInput, null, 2).slice(0, 4000) : undefined}
          onGenerated={(code) => onChange({ ...node, data: { ...node.data, code } })}
        />
        <div>
          <label className={labelClass}>{node.data.language === 'python' ? 'Python' : 'JavaScript'}</label>
          <CodeEditor
            value={node.data.code}
            language={node.data.language === 'python' ? 'python' : 'javascript'}
            ariaLabel={node.data.language === 'python' ? 'Python code' : 'JavaScript code'}
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(code) => onChange({ ...node, data: { ...node.data, code } })}
          />
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Return a JSON-compatible value. Use <code>input</code> for this step&apos;s data and <code>context</code> for trigger, steps, variables, time, and run metadata. Imports, files, network calls, and child processes are unavailable.
          </p>
          <FieldIssues issues={issueFor('code')} />
        </div>

      </>
    )}

    {node.type === 'note' && (
      <div className="space-y-3">
        <div>
          <label className={labelClass} htmlFor={`${uid}-note-text`}>Note</label>
          <textarea
            id={`${uid}-note-text`}
            rows={6}
            className={areaClass}
            onKeyDown={indentOnTab}
            value={node.data.text}
            placeholder="Document this part of the flow — what it does, gotchas, links…"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, text: e.target.value } })}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-note-color`}>Color</label>
          <select id={`${uid}-note-color`} className={fieldClass} value={node.data.color ?? 'yellow'} onChange={(e) => onChange({ ...node, data: { ...node.data, color: e.target.value as 'yellow' | 'blue' | 'green' | 'pink' } })}>
            <option value="yellow">Yellow</option>
            <option value="blue">Blue</option>
            <option value="green">Green</option>
            <option value="pink">Pink</option>
          </select>
        </div>
        <p className="text-xs text-muted-foreground">A note never runs — it just documents the flow in place.</p>
      </div>
    )}

    {node.type === 'wait' && (
      <div className="space-y-3">
        <div>
          <label className={labelClass} htmlFor={`${uid}-wait-mode`}>Wait for</label>
          <select
            id={`${uid}-wait-mode`}
            className={fieldClass}
            value={node.data.mode ?? 'duration'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, mode: e.target.value as 'duration' | 'until' | 'webhook' } })}
          >
            <option value="duration">A set amount of time</option>
            <option value="until">Until a specific date/time</option>
            <option value="webhook">An external system to call back</option>
          </select>
        </div>
        {(node.data.mode ?? 'duration') === 'duration' && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className={labelClass}>Amount</span>
              <TokenTextEditor
                ref={registerEditor('wait.amount')}
                value={node.data.amount ?? ''}
                labelCtx={labelCtx}
                placeholder="e.g. 3"
                onFocus={focusEditor('wait.amount')}
                onChange={(amount) => onChange({ ...node, data: { ...node.data, amount } })}
                ariaLabel="Amount to wait"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-wait-unit`}>Unit</label>
              <select
                id={`${uid}-wait-unit`}
                className={fieldClass}
                value={node.data.unit ?? 'minutes'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, unit: e.target.value as 'seconds' | 'minutes' | 'hours' | 'days' } })}
              >
                <option value="seconds">Seconds</option>
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </div>
          </div>
        )}
        {node.data.mode === 'until' && (
          <div>
            <span className={labelClass}>Wait until</span>
            <TokenTextEditor
              ref={registerEditor('wait.until')}
              value={node.data.until ?? ''}
              labelCtx={labelCtx}
              placeholder="e.g. 2026-08-01T09:00:00Z or pick a date value below"
              onFocus={focusEditor('wait.until')}
              onChange={(until) => onChange({ ...node, data: { ...node.data, until } })}
              ariaLabel="Wait until"
            />
            <FieldIssues issues={issueFor('wait')} />
            <div className="mt-2">
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
          </div>
        )}
        {node.data.mode === 'webhook' && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              The run pauses until an external system POSTs to its resume URL. Use the <span className="font-medium">Run resume link</span> value (from the data menu) in a step before this one to hand the URL to that system. The callback body becomes this step&apos;s output.
            </p>
            <div>
              <label className={labelClass} htmlFor={`${uid}-wait-timeout`}>Give up after (minutes, optional)</label>
              <input
                id={`${uid}-wait-timeout`}
                type="number"
                min={1}
                className={fieldClass}
                placeholder="Wait indefinitely"
                value={node.data.timeoutMinutes ?? ''}
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  onChange({ ...node, data: { ...node.data, timeoutMinutes: n > 0 ? Math.floor(n) : undefined } })
                }}
              />
            </div>
          </div>
        )}
      </div>
    )}

    {node.type === 'join' && (
      <div className="space-y-3">
        <div>
          <label className={labelClass} htmlFor={`${uid}-join-mode`}>Mode</label>
          <select
            id={`${uid}-join-mode`}
            className={fieldClass}
            value={node.data.mode ?? 'passthrough'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, mode: e.target.value === 'passthrough' ? undefined : (e.target.value as 'append' | 'combineByKey' | 'combineByPosition' | 'allCombinations') } })}
          >
            <option value="passthrough">Continue on whichever branch ran (merge paths)</option>
            <option value="append">Combine every branch&apos;s items into one list</option>
            <option value="combineByKey">Combine records from every branch by a matching field</option>
            <option value="combineByPosition">Pair up branches item by item, in order</option>
            <option value="allCombinations">Every combination of one item from each branch</option>
          </select>
        </div>
        {(node.data.mode === 'combineByKey' || node.data.mode === 'combineByPosition') && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={node.data.mode === 'combineByPosition' ? node.data.includeUnpaired === true : node.data.includeUnpaired !== false}
              onChange={(e) => onChange({ ...node, data: { ...node.data, includeUnpaired: e.target.checked } })}
            />
            Include Any Unpaired Items
          </label>
        )}
        {node.data.mode === 'combineByKey' && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-join-key`}>Matching field</label>
            <input
              id={`${uid}-join-key`}
              className={fieldClass}
              value={node.data.key ?? ''}
              placeholder="e.g. email"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, key: e.target.value || undefined } })}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">Records from each branch that share this field are merged into one.</p>
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={node.data.keyRight !== undefined}
                onChange={(e) => onChange({ ...node, data: { ...node.data, keyRight: e.target.checked ? (node.data.key ?? '') : undefined } })}
              />
              Fields To Match Have Different Names
            </label>
            {node.data.keyRight !== undefined && (
              <input
                className={`${fieldClass} mt-1.5`}
                value={node.data.keyRight}
                placeholder="The field name on the other branch, e.g. emailAddress"
                aria-label="Input 2 Field"
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => onChange({ ...node, data: { ...node.data, keyRight: e.target.value } })}
              />
            )}
          </div>
        )}
        {node.data.mode === 'combineByKey' && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-join-output-type`}>Output Type</label>
            <select
              id={`${uid}-join-output-type`}
              className={fieldClass}
              value={node.data.joinMode ?? (node.data.includeUnpaired === false ? 'keepMatches' : 'keepEverything')}
              onChange={(e) => onChange({ ...node, data: { ...node.data, joinMode: e.target.value as 'keepMatches' | 'keepNonMatches' | 'keepEverything' | 'enrichInput1' | 'enrichInput2' } })}
            >
              <option value="keepMatches">Keep Matches</option>
              <option value="keepNonMatches">Keep Non-Matches</option>
              <option value="keepEverything">Keep Everything</option>
              <option value="enrichInput1">Enrich Input 1</option>
              <option value="enrichInput2">Enrich Input 2</option>
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Enrich Input 1 keeps every record of the first branch and adds the second&apos;s where they match.
              Keep Non-Matches answers the opposite question — what found no partner.
            </p>
          </div>
        )}
        {node.data.mode === 'combineByKey' && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-join-clash`}>Clash Handling</label>
            <select
              id={`${uid}-join-clash`}
              className={fieldClass}
              value={node.data.clash ?? 'preferLast'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, clash: e.target.value as 'preferLast' | 'preferFirst' | 'deepMerge' } })}
            >
              <option value="preferLast">Prefer the later branch</option>
              <option value="preferFirst">Prefer the first branch</option>
              <option value="deepMerge">Merge nested objects together</option>
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">Which value wins when both branches carry the same field.</p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Point the ends of different branches at this step so the steps after it run once. In &quot;merge paths&quot; mode only the branch that ran continues; the combine modes gather every branch that produced data.
        </p>
      </div>
    )}
    </>
  )
}

// The individual step-kind editors, moved here with the branches that use them.
export function AddNestedStepMenu({
  label,
  onPick,
}: {
  label: string
  onPick: (type: EditableType) => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The drawer sits inside a backdrop-blur overlay, which is a containing block
  // for fixed children — the backdrop this used to render stopped at the
  // overlay's padding instead of the viewport edge.
  useDismissOnOutsidePointer(open, () => setOpen(false), [menuRef])
  return (
    <div className="relative" ref={menuRef}>
      <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen((value) => !value)}>
        <Plus className="mr-1.5 h-4 w-4" /> {label}
      </Button>
      {open && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-border bg-card p-1 shadow-popover">
            {NODE_TYPES.map((type) => (
              <button
                key={type.value}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onPick(type.value)
                }}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                {type.label}
              </button>
            ))}
          </div>
      )}
    </div>
  )
}

export function ToolConfigurationSection({
  node,
  toolCatalog,
  dataFields,
  labelCtx,
  issueFor,
  onChange,
}: {
  node: Extract<FlowNode, { type: 'tool' }>
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  /** The step's findings, looked up by the field each control owns. */
  issueFor: (field: string) => FieldIssue[] | undefined
  onChange: (node: FlowNode) => void
}) {
  const uid = useId()
  const { connection, tool, brand, actionLabel } = selectedToolPresentation(
    toolCatalog,
    node.data.connectionId,
    node.data.toolName,
  )
  // An MCP connection is a SERVER exposing TOOLS — n8n's words, and the ones
  // the schema and the protocol use. "Connector / Action / Arguments" is our
  // vocabulary for app integrations, and reading it on a step that calls an MCP
  // server makes the same call look like a different kind of thing.
  const plane = node.data.connectionId ? parseFlowToolConnectionId(node.data.connectionId).plane : null
  const isMcp = plane === 'mcp' || plane === 'people_ai'
  const vocab = isMcp
    ? { picker: 'Server', action: 'Tool', args: 'Values to send', change: 'Change server' }
    : { picker: 'Connector', action: 'Action', args: 'Arguments', change: 'Change app' }
  const providerGroups = groupToolConnections(toolCatalog)
  // Every MCP-plane connection, for the Credential picker; and how this one
  // authenticates, read off the connection rather than asked for again.
  const mcpConnections = toolCatalog.filter((entry) => {
    const entryPlane = parseFlowToolConnectionId(entry.id).plane
    return entryPlane === 'mcp' || entryPlane === 'people_ai'
  })
  const mcpAuthLabel = plane === 'people_ai' ? 'MCP OAuth2' : 'Connected server credential'
  const actions = connection ? toolActionChoices(toolCatalog, connection) : []
  const selectedAction = actions.find(
    (choice) => choice.connectionId === node.data.connectionId && choice.tool.name === node.data.toolName,
  )
  return (
    <div className="space-y-3">
      {!connection ? (
        <div>
          <label className={labelClass} htmlFor={`${uid}-connector`}>Connector</label>
          <select
            id={`${uid}-connector`}
            className={fieldClass}
            value=""
            onChange={(event) => {
              const group = providerGroups.find((entry) => entry.brand.key === event.target.value)
              const first = group?.connections.find((entry) => entry.tools.length > 0)
              onChange({
                ...node,
                data: {
                  ...node.data,
                  connectionId: first?.id ?? '',
                  toolName: first?.tools[0]?.name ?? '',
                  args: '{}',
                },
              })
            }}
          >
            <option value="">Choose a connected app…</option>
            {providerGroups.map((entry) => (
              <option key={entry.brand.key} value={entry.brand.key}>
                {entry.brand.label}
              </option>
            ))}
          </select>
          <FieldIssues issues={issueFor('connectionId')} />
        </div>
      ) : (
        <>
          {isMcp ? (
            /* n8n's MCP panel, row for row: Server Transport, MCP Endpoint URL,
               Authentication, Credential, then Tool / Input Mode / Values to
               Send below. The first three are properties of the connection
               rather than of this step, so they are shown and not edited — you
               change them where the connection is configured, and seeing them
               here beats leaving the panel to find out which endpoint a step
               talks to. */
            <>
              <div>
                <label className={labelClass} htmlFor={`${uid}-mcp-transport`}>Server Transport</label>
                <select id={`${uid}-mcp-transport`} className={fieldClass} value="httpStreamable" disabled>
                  <option value="httpStreamable">HTTP Streamable</option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-mcp-endpoint`}>MCP Endpoint URL</label>
                <input
                  id={`${uid}-mcp-endpoint`}
                  className={`${fieldClass} bg-muted/40`}
                  value={connection.serverUrl ?? ''}
                  readOnly
                  placeholder="Set on the connection"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-mcp-auth`}>Authentication</label>
                <input id={`${uid}-mcp-auth`} className={`${fieldClass} bg-muted/40`} value={mcpAuthLabel} readOnly />
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-mcp-credential`}>Credential for MCP API</label>
                <div className="flex gap-2">
                  <select
                    id={`${uid}-mcp-credential`}
                    className={`${fieldClass} min-w-0 flex-1`}
                    value={node.data.connectionId}
                    onChange={(event) => onChange({ ...node, data: { ...node.data, connectionId: event.target.value, toolName: '', args: '{}' } })}
                  >
                    {mcpConnections.map((entry) => (
                      <option key={entry.id} value={entry.id}>{entry.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => onChange({ ...node, data: { ...node.data, connectionId: '', toolName: '', args: '{}' } })}
                    className="shrink-0 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                  >
                    {vocab.change}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/50 p-3">
              <div className="flex min-w-0 items-center gap-3">
                <IntegrationLogo slug={brand?.slug} name={brand?.label ?? connection.name} className="h-9 w-9 rounded-lg bg-white p-1 shadow-sm" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{brand?.label ?? connection.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{actionLabel || 'Choose an action'}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onChange({ ...node, data: { ...node.data, connectionId: '', toolName: '', args: '{}' } })}
                className="shrink-0 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
              >
                {vocab.change}
              </button>
            </div>
          )}
          <div>
            <label className={labelClass} htmlFor={`${uid}-action`}>{vocab.action}</label>
            <select
              id={`${uid}-action`}
              className={fieldClass}
              value={selectedAction?.key ?? ''}
              onChange={(event) => {
                const next = actions.find((choice) => choice.key === event.target.value)
                if (!next) return
                onChange({
                  ...node,
                  data: {
                    ...node.data,
                    connectionId: next.connectionId,
                    toolName: next.tool.name,
                    args: '{}',
                  },
                })
              }}
            >
              <option value="">Choose an action…</option>
              {actions.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
            <FieldIssues issues={issueFor('toolName')} />
            <FieldIssues issues={issueFor('connectionId')} />
          </div>
          {tool && (
            <>
              {tool.description && <p className="text-xs text-muted-foreground">{tool.description}</p>}
              {isMcp && (
                <div>
                  <label className={labelClass} htmlFor={`${uid}-mcp-input-mode`}>Input Mode</label>
                  <select id={`${uid}-mcp-input-mode`} className={fieldClass} value="manual" disabled>
                    <option value="manual">Manual</option>
                  </select>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Values are filled in below. Letting the step&apos;s agent choose them is what an Agent step is for.
                  </p>
                </div>
              )}
              <ToolArgsEditor
                inputSchema={tool.inputSchema}
                args={node.data.args}
                // Pruned on the way in: switching this step to a different tool
                // leaves labels for fields the new tool does not have, and a
                // kept one would resurface naming a record from another system.
                argLabels={pruneArgLabels(node.data.argLabels, schemaFields(tool.inputSchema))}
                onChange={(args) => onChange({ ...node, data: { ...node.data, args } })}
                onChangeLabels={(argLabels) => onChange({ ...node, data: { ...node.data, argLabels } })}
                dataFields={dataFields}
                labelCtx={labelCtx}
                connectionId={node.data.connectionId}
                pickerTools={Array.from(new Set(actions.map((entry) => entry.tool.name)))}
                argsLabel={vocab.args}
              />
              <FieldIssues issues={issueFor('toolArgs')} />
            </>
          )}
        </>
      )}

      <p className="text-xs text-muted-foreground">Runs this exact connected action with the configured inputs.</p>
    </div>
  )
}

export function VariableEditor({
  node,
  variableNames,
  issueFor,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: {
  node: Extract<FlowNode, { type: 'variable' }>
  variableNames: string[]
  issueFor: (field: string) => FieldIssue[] | undefined
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const uid = useId()
  const isInitialize = node.data.op === 'initialize'
  const currentName = node.data.name.trim()
  // Mutation ops pick from variables initialized earlier; keep a name that is
  // not in that list selectable (it may live in a sibling branch).
  const nameOptions = [...variableNames, ...(currentName && !variableNames.includes(currentName) ? [currentName] : [])]
  const setOp = (op: VariableOp) =>
    onChange({ ...node, data: { ...node.data, op, varType: op === 'initialize' ? node.data.varType ?? 'string' : undefined } })
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`${uid}-var-op`}>Operation</label>
        <select id={`${uid}-var-op`} className={fieldClass} value={node.data.op} onChange={(e) => setOp(e.target.value as VariableOp)}>
          {VARIABLE_OPS.map((op) => (
            <option key={op} value={op}>
              {VARIABLE_OP_LABELS[op]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass} htmlFor={`${uid}-var-name`}>Name</label>
        {isInitialize || nameOptions.length === 0 ? (
          <input
            id={`${uid}-var-name`}
            className={fieldClass}
            value={node.data.name}
            placeholder="Enter variable name"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, name: e.target.value } })}
            aria-label="Variable name"
          />
        ) : (
          <select
            id={`${uid}-var-name`}
            className={fieldClass}
            value={currentName}
            onChange={(e) => onChange({ ...node, data: { ...node.data, name: e.target.value } })}
            aria-label="Variable name"
          >
            <option value="">Choose a variable…</option>
            {nameOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {!isInitialize && nameOptions.length === 0 && (
          <p className="mt-1.5 text-xs text-muted-foreground">No variables are initialized earlier in this flow — add an Initialize variable step first, or type the name it will use.</p>
        )}
        <FieldIssues issues={issueFor('variableName')} />
      </div>
      {isInitialize && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-var-type`}>Type</label>
          <select
            id={`${uid}-var-type`}
            className={fieldClass}
            value={node.data.varType ?? 'string'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, varType: e.target.value as VariableType } })}
          >
            {VARIABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {VARIABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className={labelClass}>Value {variableValueOptional(node.data.op) ? '(optional)' : ''}</label>
        <TokenTextEditor
          ref={registerEditor('var.value')}
          value={node.data.value ?? ''}
          labelCtx={labelCtx}
          placeholder={VARIABLE_VALUE_PLACEHOLDER[node.data.op]}
          onFocus={focusEditor('var.value')}
          onChange={(value) => onChange({ ...node, data: { ...node.data, value } })}
          ariaLabel="Variable value"
        />
        <FieldIssues issues={issueFor('variableValue')} />
        <div className="mt-2">
          <DataTree fields={dataFields} onInsert={insertToken} />
        </div>
      </div>
    </div>
  )
}

export function DataEditor({
  node,
  issueFor,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: {
  node: Extract<FlowNode, { type: 'data' }>
  issueFor: (field: string) => FieldIssue[] | undefined
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const uid = useId()
  const op = node.data.op
  const clauses = node.data.clauses?.length ? node.data.clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]
  const fields = node.data.fields?.length ? node.data.fields : [{ name: '', value: '' }]
  const setOp = (next: DataOp) => {
    // Ops with required list config start with one empty row so the editor
    // opens ready to fill in.
    const nextClauses = next === 'filterArray' && !(node.data.clauses ?? []).length ? [{ left: '', op: 'contains' as ConditionOp, right: '' }] : node.data.clauses
    const nextFields = (next === 'select' || next === 'compose' || next === 'renameKeys') && !(node.data.fields ?? []).length ? [{ name: '', value: '' }] : node.data.fields
    onChange({ ...node, data: { ...node.data, op: next, clauses: nextClauses, fields: nextFields } })
  }
  const setClauses = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next } })
  const setFields = (next: { name: string; value: string }[]) => onChange({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`${uid}-data-op`}>Operation</label>
        <select id={`${uid}-data-op`} className={fieldClass} value={op} onChange={(e) => setOp(e.target.value as DataOp)}>
          {DATA_OPS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_OP_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      {op !== 'totpGenerate' && <div>
        <span className={labelClass}>Input</span>
        <TokenTextEditor
          ref={registerEditor('data.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          placeholder={DATA_OP_INPUT_PLACEHOLDER[op]}
          onFocus={focusEditor('data.input')}
          onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
          ariaLabel="Input"
        />
        <FieldIssues issues={issueFor('dataInput')} />
      </div>}
      {(op === 'join' || op === 'split') && (
        <div>
          <label className={labelClass}>{op === 'join' ? 'Join with (optional)' : 'Split at (optional)'}</label>
          <input
            className={fieldClass}
            value={node.data.separator ?? ''}
            placeholder="Defaults to a comma"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, separator: e.target.value || undefined } })}
            aria-label={op === 'join' ? 'Join with' : 'Split at'}
          />
        </div>
      )}
      {op === 'replace' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass} htmlFor={`${uid}-data-find`}>Find</label>
            <input
              id={`${uid}-data-find`}
              className={fieldClass}
              value={node.data.find ?? ''}
              placeholder="Text to find"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, find: e.target.value || undefined } })}
              aria-label="Find"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${uid}-data-replace`}>Replace with</label>
            <input
              id={`${uid}-data-replace`}
              className={fieldClass}
              value={node.data.replaceWith ?? ''}
              placeholder="Leave empty to remove it"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, replaceWith: e.target.value || undefined } })}
              aria-label="Replace with"
            />
          </div>
        </div>
      )}
      {op === 'getItem' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-data-index`}>Position</label>
          <input
            id={`${uid}-data-index`}
            className={fieldClass}
            value={node.data.index ?? ''}
            placeholder="0 is the first item; -1 is the last"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, index: e.target.value || undefined } })}
            aria-label="Position"
          />
        </div>
      )}
      {op === 'trim' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass} htmlFor={`${uid}-trim-count`}>Items to remove</label>
            <input
              id={`${uid}-trim-count`}
              className={fieldClass}
              value={node.data.count ?? ''}
              placeholder="Defaults to 1"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, count: e.target.value || undefined } })}
              aria-label="Items to remove"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${uid}-trim-from`}>From</label>
            <select
              id={`${uid}-trim-from`}
              className={fieldClass}
              value={node.data.fromEnd ? 'end' : 'start'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, fromEnd: e.target.value === 'end' ? true : undefined } })}
              aria-label="Trim from"
            >
              <option value="start">The start</option>
              <option value="end">The end</option>
            </select>
          </div>
        </div>
      )}
      {op === 'parseJson' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-data-schema`}>Schema (optional)</label>
          <textarea
            id={`${uid}-data-schema`}
            rows={4}
            className={`${areaClass} font-mono text-xs`}
            onKeyDown={indentOnTab}
            value={node.data.schema ?? ''}
            placeholder="A JSON Schema describing the parsed shape"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, schema: e.target.value || undefined } })}
            aria-label="Schema"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">Optional — stored for reference.</p>
        </div>
      )}
      {op === 'filterArray' && (
        <div className="space-y-3">
          <div>
            <label className={labelClass} htmlFor={`${uid}-filter-match`}>Keep items where</label>
            <select
              id={`${uid}-filter-match`}
              className={fieldClass}
              value={node.data.match === 'any' ? 'any' : 'all'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value === 'any' ? 'any' : undefined } })}
              aria-label="How conditions combine"
            >
              <option value="all">Every condition passes</option>
              <option value="any">Any condition passes</option>
            </select>
          </div>
          <span className={labelClass}>Conditions</span>
          {clauses.map((clause, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <TokenTextEditor
                ref={registerEditor(`data.clause.${i}.left`)}
                className="px-2 py-1.5"
                value={clause.left}
                labelCtx={labelCtx}
                placeholder="Item field to check"
                onFocus={focusEditor(`data.clause.${i}.left`)}
                onChange={(left) => setClauses(clauses.map((c, j) => (j === i ? { ...c, left } : c)))}
                ariaLabel={`Condition ${i + 1} value`}
              />
              <div className="flex gap-1.5">
                <select className={smallField} value={clause.op} onChange={(e) => setClauses(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                  {operatorsForField(clause.left, dataFields, clause.op).map((entry) => (
                    <option key={entry} value={entry}>
                      {CONDITION_OP_LABELS[entry]}
                    </option>
                  ))}
                </select>
                <TokenTextEditor
                  ref={registerEditor(`data.clause.${i}.right`)}
                  className="min-w-0 flex-1 px-2 py-1.5"
                  value={clause.right}
                  labelCtx={labelCtx}
                  placeholder="Compare to"
                  onFocus={focusEditor(`data.clause.${i}.right`)}
                  onChange={(right) => setClauses(clauses.map((c, j) => (j === i ? { ...c, right } : c)))}
                  ariaLabel={`Condition ${i + 1} comparison value`}
                />
                {clauses.length > 1 && (
                  <button type="button" onClick={() => setClauses(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove Condition">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setClauses([...clauses, { left: '', op: 'contains', right: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add Condition
          </button>
          <FieldIssues issues={issueFor('clauses')} />
          <p className="text-[11px] text-muted-foreground">Each condition checks one item of the list at a time.</p>
        </div>
      )}
      {(op === 'sort' || op === 'removeDuplicates' || op === 'summarize' || op === 'compareDatasets') && (
        <div>
          <label className={labelClass}>{op === 'summarize' ? 'Group by field(s)' : op === 'compareDatasets' ? 'Match records by field(s)' : 'Field(s)'}</label>
          <input
            className={fieldClass}
            value={node.data.by ?? ''}
            placeholder={op === 'summarize' ? 'Leave empty to summarize the whole list — several fields separate with commas' : op === 'compareDatasets' ? 'id — several fields separate with commas' : 'Leave empty to use the whole item — several fields separate with commas'}
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, by: e.target.value } })}
          />
          {op === 'compareDatasets' && <FieldIssues issues={issueFor('compareKey')} />}
        </div>
      )}
      {op === 'compareDatasets' && (
        <div>
          <span className={labelClass}>Second dataset</span>
          <TokenTextEditor
            ref={registerEditor('data.to')}
            value={node.data.to ?? ''}
            labelCtx={labelCtx}
            placeholder="The other list to compare"
            onFocus={focusEditor('data.to')}
            onChange={(to) => onChange({ ...node, data: { ...node.data, to: to || undefined } })}
            ariaLabel="Second dataset"
          />
          <FieldIssues issues={issueFor('compareDataset')} />
        </div>
      )}
      {(['hash', 'hmac', 'jwtSign', 'jwtVerify', 'totpGenerate', 'totpVerify'] as DataOp[]).includes(op) && (
        <div className="space-y-3 rounded-md border border-border/70 p-3">
          <div>
            <label className={labelClass} htmlFor={`${uid}-security-algorithm`}>Algorithm</label>
            <select
              id={`${uid}-security-algorithm`}
              className={fieldClass}
              value={node.data.algorithm ?? (op.startsWith('jwt') ? 'HS256' : op.startsWith('totp') ? 'sha1' : 'sha256')}
              onChange={(event) => onChange({ ...node, data: { ...node.data, algorithm: event.target.value } })}
            >
              {(op.startsWith('jwt')
                ? [['HS256', 'HS256'], ['HS384', 'HS384'], ['HS512', 'HS512']]
                : op.startsWith('totp')
                  ? [['sha1', 'SHA-1 (TOTP standard)'], ['sha256', 'SHA-256'], ['sha512', 'SHA-512']]
                  : [['sha256', 'SHA-256'], ['sha384', 'SHA-384'], ['sha512', 'SHA-512']]
              ).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {op !== 'hash' && (
            <div>
              <span className={labelClass}>Runtime secret</span>
              <TokenTextEditor
                ref={registerEditor('data.secret')}
                value={node.data.secret ?? ''}
                labelCtx={labelCtx}
                placeholder="Reference a secret-bearing runtime value"
                onFocus={focusEditor('data.secret')}
                onChange={(secret) => onChange({ ...node, data: { ...node.data, secret: secret || undefined } })}
                ariaLabel="Runtime secret"
              />
              <FieldIssues issues={issueFor('dataSecret')} />
              <p className="mt-1 text-[11px] text-muted-foreground">Use a runtime reference. Literal secrets are detected before publish.</p>
            </div>
          )}
          {(op === 'jwtSign' || op === 'jwtVerify') && (
            <div className="grid grid-cols-2 gap-2">
              <input className={fieldClass} value={node.data.issuer ?? ''} placeholder="Issuer (optional)" onChange={(event) => onChange({ ...node, data: { ...node.data, issuer: event.target.value || undefined } })} />
              <input className={fieldClass} value={node.data.audience ?? ''} placeholder="Audience (optional)" onChange={(event) => onChange({ ...node, data: { ...node.data, audience: event.target.value || undefined } })} />
              {op === 'jwtSign' && <input type="number" min={1} max={31536000} className={`${fieldClass} col-span-2`} value={node.data.expiresInSeconds ?? ''} placeholder="Expires in seconds (optional)" onChange={(event) => onChange({ ...node, data: { ...node.data, expiresInSeconds: event.target.value ? Number(event.target.value) : undefined } })} />}
            </div>
          )}
          {(op === 'totpGenerate' || op === 'totpVerify') && (
            <div className="grid grid-cols-2 gap-2">
              <select className={fieldClass} value={node.data.digits ?? 6} onChange={(event) => onChange({ ...node, data: { ...node.data, digits: Number(event.target.value) as 6 | 8 } })}>
                <option value={6}>6 digits</option><option value={8}>8 digits</option>
              </select>
              <input type="number" min={15} max={120} className={fieldClass} value={node.data.period ?? 30} onChange={(event) => onChange({ ...node, data: { ...node.data, period: Number(event.target.value) } })} aria-label="TOTP period seconds" />
            </div>
          )}
        </div>
      )}
      {op === 'flatten' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-flatten-by`}>Field holding the list (optional)</label>
          <input
            id={`${uid}-flatten-by`}
            className={fieldClass}
            value={node.data.by ?? ''}
            placeholder="Leave empty to unnest lists inside lists"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, by: e.target.value || undefined } })}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">With a field, each of its entries becomes its own item, carrying the record&apos;s other fields along.</p>
        </div>
      )}
      {op === 'formatDate' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-date-format`}>Pattern</label>
          <input
            id={`${uid}-date-format`}
            className={fieldClass}
            value={node.data.format ?? ''}
            placeholder="YYYY-MM-DD — tokens: YYYY, MM, DD, HH, mm, ss"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, format: e.target.value || undefined } })}
            aria-label="Date pattern"
          />
        </div>
      )}
      {op === 'dateShift' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass} htmlFor={`${uid}-shift-amount`}>Amount</label>
            <input
              id={`${uid}-shift-amount`}
              className={fieldClass}
              value={node.data.amount ?? ''}
              placeholder="3 — negative subtracts"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, amount: e.target.value || undefined } })}
              aria-label="Amount"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${uid}-shift-unit`}>Unit</label>
            <select
              id={`${uid}-shift-unit`}
              className={fieldClass}
              value={node.data.unit ?? 'days'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, unit: e.target.value } })}
              aria-label="Time unit"
            >
              {['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'].map((unit) => (
                <option key={unit} value={unit}>{unit}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      {op === 'dateDiff' && (
        <>
          <div>
            <span className={labelClass}>End date</span>
            <TokenTextEditor
              ref={registerEditor('data.to')}
              value={node.data.to ?? ''}
              labelCtx={labelCtx}
              placeholder="The date to count up to"
              onFocus={focusEditor('data.to')}
              onChange={(to) => onChange({ ...node, data: { ...node.data, to: to || undefined } })}
              ariaLabel="End date"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${uid}-diff-unit`}>Count in</label>
            <select
              id={`${uid}-diff-unit`}
              className={fieldClass}
              value={node.data.unit ?? 'days'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, unit: e.target.value } })}
              aria-label="Time unit"
            >
              {['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'].map((unit) => (
                <option key={unit} value={unit}>{unit}</option>
              ))}
            </select>
          </div>
        </>
      )}
      {op === 'datePart' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-date-part`}>Part to pick</label>
          <select
            id={`${uid}-date-part`}
            className={fieldClass}
            value={node.data.part ?? 'date'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, part: e.target.value } })}
            aria-label="Date part"
          >
            {[
              ['date', 'Calendar date (YYYY-MM-DD)'],
              ['time', 'Time of day (HH:MM)'],
              ['year', 'Year'],
              ['month', 'Month (1–12)'],
              ['day', 'Day of month'],
              ['weekday', 'Weekday name'],
              ['hour', 'Hour'],
              ['minute', 'Minute'],
              ['second', 'Second'],
            ].map(([value, text]) => (
              <option key={value} value={value}>{text}</option>
            ))}
          </select>
        </div>
      )}
      {op === 'sort' && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={node.data.descending === true}
            onChange={(e) => onChange({ ...node, data: { ...node.data, descending: e.target.checked || undefined } })}
          />
          Highest first
        </label>
      )}
      {op === 'limit' && (
        <>
          <div>
            <label className={labelClass} htmlFor={`${uid}-limit-count`}>How many to keep</label>
            <input
              id={`${uid}-limit-count`}
              className={fieldClass}
              value={node.data.count ?? ''}
              placeholder="10"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, count: e.target.value } })}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={node.data.fromEnd === true}
              onChange={(e) => onChange({ ...node, data: { ...node.data, fromEnd: e.target.checked || undefined } })}
            />
            Take from the end of the list
          </label>
        </>
      )}
      {op === 'aggregate' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-aggregate-by`}>Field to collect</label>
          <input
            id={`${uid}-aggregate-by`}
            className={fieldClass}
            value={node.data.by ?? ''}
            placeholder="Leave empty to keep the whole list as one value"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, by: e.target.value } })}
          />
        </div>
      )}
      {op === 'summarize' && (
        <div className="space-y-2">
          <span className={labelClass}>Calculate</span>
          {(node.data.aggregations ?? [{ field: '', op: 'sum' as const }]).map((entry, i) => {
            const rows = node.data.aggregations ?? [{ field: '', op: 'sum' as const }]
            const setRows = (next: typeof rows) => onChange({ ...node, data: { ...node.data, aggregations: next } })
            return (
              <div key={i} className="flex gap-1.5">
                <select
                  className={`${smallField} w-28`}
                  value={entry.op}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, op: e.target.value as typeof r.op } : r)))}
                >
                  {SUMMARIZE_OPS.map((o) => (
                    <option key={o} value={o}>{SUMMARIZE_OP_LABELS[o]}</option>
                  ))}
                </select>
                <input
                  className={`${smallField} flex-1`}
                  value={entry.field}
                  placeholder="of field"
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)))}
                />
                {rows.length > 1 && (
                  <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove calculation">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            onClick={() => onChange({ ...node, data: { ...node.data, aggregations: [...(node.data.aggregations ?? [{ field: '', op: 'sum' as const }]), { field: '', op: 'sum' as const }] } })}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add calculation
          </button>
        </div>
      )}
      {(op === 'select' || op === 'compose' || op === 'renameKeys') && (
        <div className="space-y-3">
          <label className={labelClass}>{op === 'renameKeys' ? 'Renames' : 'Fields'}</label>
          {fields.map((field, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <div className="flex gap-1.5">
                <input
                  className={`${smallField} flex-1`}
                  value={field.name}
                  placeholder={op === 'renameKeys' ? 'Current field name' : 'Output field'}
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
                />
                {fields.length > 1 && (
                  <button type="button" onClick={() => setFields(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label={op === 'renameKeys' ? 'Remove rename' : 'Remove field'}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {op === 'renameKeys' ? (
                <input
                  className={`${smallField} w-full`}
                  value={field.value}
                  placeholder="New field name"
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, value: e.target.value } : f)))}
                  aria-label={`New name for ${field.name || `rename ${i + 1}`}`}
                />
              ) : (
                <TokenTextEditor
                  ref={registerEditor(`data.field.${i}.value`)}
                  className="px-2 py-1.5"
                  value={field.value}
                  labelCtx={labelCtx}
                  placeholder="Value for this field"
                  onFocus={focusEditor(`data.field.${i}.value`)}
                  onChange={(value) => setFields(fields.map((f, j) => (j === i ? { ...f, value } : f)))}
                  ariaLabel={`Value for field ${field.name || i + 1}`}
                />
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFields([...fields, { name: '', value: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> {op === 'renameKeys' ? 'Add rename' : 'Add field'}
          </button>
          <FieldIssues issues={issueFor('fields')} />
        </div>
      )}
      <div>
        <DataTree fields={dataFields} onInsert={insertToken} />
      </div>
      <p className="text-xs text-muted-foreground">{DATA_OP_HELPER[op]}</p>
    </div>
  )
}

export function OutputEditor({
  node,
  issueFor,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: {
  node: Extract<FlowNode, { type: 'output' }>
  issueFor: (field: string) => FieldIssue[] | undefined
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const outputs: OutputRow[] = node.data.outputs.length ? node.data.outputs : [{ name: 'output', value: '', type: 'any' }]
  const setOutputs = (next: OutputRow[]) => onChange({ ...node, data: { ...node.data, outputs: next } })
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Return one or more named results to whatever called this flow — the webhook response, the completion signal, or a parent flow.</p>
      {outputs.map((row, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
          <div className="flex gap-1.5">
            <input
              className={`${smallField} flex-1`}
              value={row.name}
              placeholder="resultName"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => setOutputs(outputs.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
              aria-label="Output name"
            />
            <select
              className={smallField}
              value={row.type ?? 'any'}
              onChange={(e) => setOutputs(outputs.map((r, j) => (j === i ? { ...r, type: e.target.value as OutputRow['type'] } : r)))}
              aria-label="Output type"
            >
              {OUTPUT_VALUE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {outputs.length > 1 && (
              <button type="button" onClick={() => setOutputs(outputs.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove output">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          <TokenTextEditor
            ref={registerEditor(`out.${i}.value`)}
            className="px-2 py-1.5"
            value={row.value}
            labelCtx={labelCtx}
            placeholder="Value to return — choose data from below"
            onFocus={focusEditor(`out.${i}.value`)}
            onChange={(value) => setOutputs(outputs.map((r, j) => (j === i ? { ...r, value } : r)))}
            ariaLabel={`Value for output ${row.name || i + 1}`}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => setOutputs([...outputs, { name: '', value: '', type: 'any' }])}
        className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add output
      </button>
      <FieldIssues issues={issueFor('outputFields')} />
      <div>
        <DataTree fields={dataFields} onInsert={insertToken} />
      </div>
    </div>
  )
}

export function OutputFieldsEditor({
  fields,
  onChange,
  blockActive,
  unblockActive,
}: {
  fields: OutputField[]
  onChange: (fields: OutputField[]) => void
  blockActive: () => void
  unblockActive: () => void
}) {
  return (
    <div>
      <span className={labelClass}>Output fields (optional)</span>
      <p className="-mt-1 mb-2 text-[11px] text-muted-foreground">Declare what this step returns so later steps can map its fields. Fields also appear once the step has run.</p>
      <div className="space-y-1.5">
        {fields.map((field, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              className={`${smallField} flex-1`}
              value={field.name}
              placeholder="fieldName"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
            />
            <select className={smallField} value={field.type} onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, type: e.target.value as OutputField['type'] } : f)))}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove field">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...fields, { name: '', type: 'any' }])} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
        <Plus className="h-3.5 w-3.5" /> Add Field
      </button>
    </div>
  )
}

export function SubflowDrawerSection({
  node,
  onChange,
  flowId,
  labelCtx,
  registerEditor,
  focusEditor,
  dataFields,
  insertToken,
  issueFor,
}: {
  node: Extract<FlowNode, { type: 'subflow' }>
  onChange: (node: FlowNode) => void
  flowId: string
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  dataFields: DataField[]
  insertToken: (token: string) => void
  issueFor: (field: string) => FieldIssue[] | undefined
}) {
  const uid = useId()
  const { flows, loading } = useWorkspaceFlows()
  const selectable = flows.filter((flow) => flow.id !== flowId)
  const selected = flows.find((flow) => flow.id === node.data.flowId)
  const childFields = (selected?.inputFields ?? []).filter((field) => field.name.trim())
  const inputs = node.data.inputs ?? {}
  const setInput = (name: string, value: string) => {
    const next = { ...inputs, [name]: value }
    if (!value) delete next[name]
    onChange({ ...node, data: { ...node.data, inputs: Object.keys(next).length ? next : undefined } })
  }
  return (
    <>
      <div>
        <label className={labelClass} htmlFor={`${uid}-subflow-flow`}>Flow to run</label>
        <select
          id={`${uid}-subflow-flow`}
          className={fieldClass}
          value={node.data.flowId}
          onChange={(e) => onChange({ ...node, data: { ...node.data, flowId: e.target.value, inputs: undefined } })}
          aria-label="Flow to run"
        >
          <option value="">{loading ? 'Loading flows…' : 'Choose a flow'}</option>
          {selectable.map((flow) => (
            <option key={flow.id} value={flow.id}>
              {flow.name}
              {flow.published ? '' : ' (not published yet)'}
            </option>
          ))}
        </select>
        {selected && !selected.published && (
          <PanelNotice tone="warning" className="mt-1.5">This flow has never been published — publish it before running it from here.</PanelNotice>
        )}
        <FieldIssues issues={issueFor('flowId')} />
      </div>
      {childFields.length > 0 ? (
        <div className="space-y-2">
          <span className={labelClass}>Inputs it expects</span>
          {childFields.map((field) => (
            <div key={field.name}>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">{field.name}{field.required ? ' (required)' : ''}</p>
              <TokenTextEditor
                ref={registerEditor(`subflow.${field.name}`)}
                className="px-2 py-1.5"
                value={inputs[field.name] ?? ''}
                labelCtx={labelCtx}
                placeholder={field.description || 'Add a value or pick flow data'}
                onFocus={focusEditor(`subflow.${field.name}`)}
                onChange={(value) => setInput(field.name, value)}
                ariaLabel={`Value for ${field.name}`}
              />
            </div>
          ))}
        </div>
      ) : (
        <div>
          <span className={labelClass}>Input to send it</span>
          <TokenTextEditor
            ref={registerEditor('subflow.input')}
            multiline
            rows={3}
            value={node.data.input ?? ''}
            labelCtx={labelCtx}
            placeholder="What the flow receives as its run input."
            onFocus={focusEditor('subflow.input')}
            onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
            ariaLabel="Input to send the flow"
          />
        </div>
      )}
      <div className="mt-2">
        <DataTree fields={dataFields} onInsert={insertToken} />
      </div>
      <p className="text-xs text-muted-foreground">Runs the flow&apos;s <strong>published</strong> version and passes its result to later steps.</p>

    </>
  )
}

export function clausesOf(data: { clauses?: ConditionClause[]; left?: string; op?: ConditionOp; right?: string }): ConditionClause[] {
  if (data.clauses && data.clauses.length) return data.clauses
  if (data.left !== undefined || data.right !== undefined)
    return [{ left: data.left ?? '', op: data.op ?? 'contains', right: data.right ?? '' }]
  return [{ left: '', op: 'contains', right: '' }]
}

export function InputFieldsEditor({ fields, onChange }: { fields: TriggerInputField[]; onChange: (fields: TriggerInputField[]) => void }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
      <span className={labelClass}>Expected input fields</span>
      <p className="-mt-1 mb-2 text-[11px] text-muted-foreground">
        Name the values this flow expects. Downstream steps can pick them as Run input fields instead of typing template paths.
      </p>
      <div className="space-y-2">
        {fields.map((field, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border border-border bg-background p-2">
            <div className="flex gap-1.5">
              <input
                className={`${smallField} min-w-0 flex-1`}
                value={field.name}
                placeholder="account"
                onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
              />
              <select className={smallField} value={field.type} onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, type: e.target.value as OutputField['type'] } : f)))}>
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove input field">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <input
              className={`${smallField} w-full`}
              value={field.description ?? ''}
              placeholder="What should the user or webhook send here?"
              onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, description: e.target.value || undefined } : f)))}
            />
            <input
              className={`${smallField} w-full`}
              value={field.default ?? ''}
              placeholder="Default value if none is provided"
              onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, default: e.target.value || undefined } : f)))}
              aria-label="Default value"
            />
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={field.required === true}
                onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, required: e.target.checked || undefined } : f)))}
                className="h-3.5 w-3.5 rounded border-border"
              />
              Required — the run must supply this value
            </label>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...fields, { name: '', type: 'string' }])} className="mt-2 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
        <Plus className="h-3.5 w-3.5" /> Add input field
      </button>
    </div>
  )
}

export const OUTPUT_VALUE_TYPES: { value: 'text' | 'list' | 'any'; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'text', label: 'Text' },
  { value: 'list', label: 'List' },
]

export type OutputRow = { name: string; value: string; type?: 'text' | 'list' | 'any' }
