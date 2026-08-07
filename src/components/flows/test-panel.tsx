'use client'

import { Play, X } from 'lucide-react'
import { indentOnTab } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { TypewriterStatus } from '@/components/ui/typewriter-status'
import type { TriggerInputField } from '@/lib/flows/graph'
import { fieldValuesFromFlowInput, flowInputFromFieldValues } from '@/lib/flows/test-input'
import { fieldClass, inputForField, labelClass } from './test-input-panel'
import type { StepStatus } from './step-card'

const STATUS_DOT: Record<StepStatus, string> = {
  queued: 'bg-gray-300',
  running: 'bg-amber-400 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-blue-500 animate-pulse',
  skipped: 'bg-gray-300',
  stopped: 'bg-slate-500',
  resumed: 'bg-gray-300',
}

const STATUS_TEXT: Record<StepStatus, string> = {
  queued: 'text-gray-400',
  running: 'text-amber-600',
  succeeded: 'text-emerald-600',
  failed: 'text-red-600',
  waiting: 'text-blue-600',
  skipped: 'text-gray-400',
  stopped: 'text-slate-500',
  resumed: 'text-gray-400',
}

export type TestStep = { nodeId: string; status: StepStatus }

export function TestPanel({
  fields,
  value,
  onChange,
  onRun,
  running,
  steps,
  labelForNode,
  onInspect,
  onClose,
}: {
  fields: TriggerInputField[]
  value: string
  onChange: (value: string) => void
  onRun: () => void
  running: boolean
  steps: TestStep[]
  labelForNode: (nodeId: string) => string
  onInspect: () => void
  onClose: () => void
}) {
  const usableFields = fields.filter((field) => field.name.trim())
  const values = fieldValuesFromFlowInput(value, usableFields)

  const setField = (name: string, nextValue: string) => {
    onChange(flowInputFromFieldValues(usableFields, { ...values, [name]: nextValue }))
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Test</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-3 border-b border-border p-3">
          {usableFields.length > 0 ? (
            <>
              {usableFields.map((field) => {
                const name = field.name.trim()
                return (
                  <div key={name}>
                    <label className={labelClass}>
                      <span className="font-mono">{name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">{field.type}</span>
                      {field.required && <span className="text-red-500" title="Required">*</span>}
                    </label>
                    {field.description && <p className="mb-1.5 text-[11px] leading-4 text-muted-foreground">{field.description}</p>}
                    {inputForField({ field, value: values[name] ?? '', onChange: (next) => setField(name, next) })}
                  </div>
                )
              })}
              <div className="border-t border-border pt-3">
                <label className={labelClass}>Raw payload</label>
                <textarea
                  rows={6}
                  onKeyDown={indentOnTab}
                  className={`${fieldClass} min-h-[120px] resize-y font-mono text-xs`}
                  value={value}
                  placeholder='{"account":"Acme","priority":"high"}'
                  onChange={(event) => onChange(event.target.value)}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">Advanced: edit the JSON sent to the flow directly.</p>
              </div>
            </>
          ) : (
            <div>
              <label className={labelClass}>Run input</label>
              <textarea
                rows={6}
                onKeyDown={indentOnTab}
                className={`${fieldClass} min-h-[120px] resize-y font-mono text-xs`}
                value={value}
                placeholder="Text, JSON, or a list"
                onChange={(event) => onChange(event.target.value)}
              />
            </div>
          )}
          <Button size="sm" className="w-full" onClick={onRun} loading={running} disabled={running}>
            <Play className="mr-1.5 h-4 w-4" /> Run test
          </Button>
        </div>

        <div>
          {steps.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Run the flow to see step-by-step results here.</p>
          ) : (
            steps.map((step, i) => (
              <div key={`${step.nodeId}-${i}`} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-0">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[step.status])} />
                <span className="flex-1 truncate text-sm">{labelForNode(step.nodeId)}</span>
                <span className={cn('text-xs font-medium capitalize', STATUS_TEXT[step.status])}>
                  {step.status === 'running' ? <TypewriterStatus seed={step.nodeId.length ? step.nodeId.charCodeAt(step.nodeId.length - 1) : 0} /> : step.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="border-t border-border p-3">
        <button type="button" onClick={onInspect} className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
          Open full run inspector →
        </button>
      </div>
    </div>
  )
}
