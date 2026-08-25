'use client'

import { useState, type ReactNode } from 'react'
import { Plus, X, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import {
  addableOptions,
  addedOptions,
  optionPatch,
  strandedOptions,
  type NodeOption,
} from '@/lib/flows/node-options'

/**
 * One `Options` control per step, holding everything optional.
 *
 * Replaces four differently-named disclosure mechanisms — two `<details>`, an
 * "Advanced parameters" panel, and a per-item section that opened above the
 * step's own parameters. Four lids of different shapes is why a panel with a
 * quarter of n8n's configuration read as the busier one.
 *
 * The rule is n8n's: a parameter does not exist on screen until you add it, and
 * an option that cannot do anything is not offered rather than greyed out.
 */

const controlClass =
  'h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors hover:border-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100'

function OptionControl({
  option,
  node,
  onPatch,
  renderCustom,
}: {
  option: NodeOption
  node: FlowNode
  onPatch: (patch: Record<string, unknown>) => void
  renderCustom?: (option: NodeOption) => ReactNode
}) {
  const data = node.data as Record<string, unknown>
  const value = data[option.key]

  if (option.control.kind === 'custom') {
    return <>{renderCustom?.(option) ?? null}</>
  }

  if (option.control.kind === 'select') {
    return (
      <select
        className={controlClass}
        value={typeof value === 'string' ? value : ''}
        aria-label={option.label}
        onChange={(event) => onPatch({ [option.key]: event.target.value })}
      >
        {option.control.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>{choice.label}</option>
        ))}
      </select>
    )
  }

  if (option.control.kind === 'boolean') {
    const { onLabel, offLabel } = option.control
    return (
      <select
        className={controlClass}
        value={value === false ? 'false' : 'true'}
        aria-label={option.label}
        onChange={(event) => onPatch({ [option.key]: event.target.value === 'true' })}
      >
        <option value="true">{onLabel}</option>
        <option value="false">{offLabel}</option>
      </select>
    )
  }

  if (option.control.kind === 'text') {
    return (
      <input
        className={controlClass}
        value={typeof value === 'string' ? value : ''}
        placeholder={option.control.placeholder}
        aria-label={option.label}
        onChange={(event) => onPatch({ [option.key]: event.target.value })}
      />
    )
  }

  // number — stored in ms for durations, shown in seconds, because nobody
  // reasons about a timeout in milliseconds.
  const { min, max, unit } = option.control
  const inSeconds = unit === 'seconds'
  const shown = typeof value === 'number' ? (inSeconds ? Math.round(value / 1000) : value) : ''
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        className={cn(controlClass, 'w-28')}
        min={min}
        max={max}
        value={shown}
        aria-label={option.label}
        onChange={(event) => {
          if (event.target.value === '') return
          const raw = Number(event.target.value)
          if (!Number.isFinite(raw)) return
          const clamped = Math.max(min ?? 0, Math.min(max ?? Number.MAX_SAFE_INTEGER, raw))
          onPatch({ [option.key]: inSeconds ? clamped * 1000 : clamped })
        }}
      />
      {inSeconds && <span className="text-xs text-muted-foreground">seconds</span>}
    </div>
  )
}

export function NodeOptions({
  node,
  onChange,
  renderCustom,
}: {
  node: FlowNode
  onChange: (node: FlowNode) => void
  /** Nested editors the collection only shows and hides (pagination, per-item). */
  renderCustom?: (option: NodeOption) => ReactNode
}) {
  const [picking, setPicking] = useState(false)
  const added = addedOptions(node)
  const addable = addableOptions(node)
  const stranded = strandedOptions(node)

  const patch = (values: Record<string, unknown>) =>
    onChange({ ...node, data: { ...node.data, ...values } } as FlowNode)

  if (!added.length && !addable.length && !stranded.length) return null

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <p className="text-sm font-semibold">Options</p>

      {added.map((option) => (
        <div key={option.key} className="rounded-lg border border-border/70 p-2.5">
          <div className="mb-1.5 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">{option.label}</p>
              {option.description && (
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{option.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => patch(optionPatch(option, 'remove'))}
              aria-label={`Remove ${option.label}`}
              title={`Remove ${option.label}`}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <OptionControl option={option} node={node} onPatch={patch} renderCustom={renderCustom} />
        </div>
      ))}

      {/* A value the panel would otherwise hold in force without showing it —
          the case n8n leaves silent. Saying so beats acting on it invisibly. */}
      {stranded.map((option) => (
        <div key={option.key} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-amber-800">
              <span className="font-medium">{option.label}</span> is set but no longer applies to this step.
            </p>
            <button
              type="button"
              onClick={() => patch(optionPatch(option, 'remove'))}
              className="mt-1 text-[11px] font-medium text-amber-800 underline hover:text-amber-900"
            >
              Clear it
            </button>
          </div>
        </div>
      ))}

      {addable.length > 0 && (
        picking ? (
          <select
            className={controlClass}
            defaultValue=""
            autoFocus
            aria-label="Add an option"
            onBlur={() => setPicking(false)}
            onChange={(event) => {
              const option = addable.find((entry) => entry.key === event.target.value)
              if (option) patch(optionPatch(option, 'add'))
              setPicking(false)
            }}
          >
            <option value="" disabled>Choose an option…</option>
            {addable.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add option
          </button>
        )
      )}
    </div>
  )
}
