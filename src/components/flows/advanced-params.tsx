'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { advancedParamKeys, advancedParamsSetCount, type AdvancedParamKey } from '@/lib/flows/advanced-params'
import { AGENT_RUN_MAX_DURATION_SECONDS } from '@/lib/agents/timeouts'

const controlClass =
  'h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-950 outline-none transition-colors hover:border-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500'

/**
 * MS-parity "Advanced parameters" section: collapsed summary ("Showing N of
 * M"), Show all / Clear all, and the per-key controls declared by the
 * advanced-params manifest. Shared by the step card and the settings drawer.
 */
export function AdvancedParamsSection({
  node,
  onChange,
  defaultOpen = false,
}: {
  node: FlowNode
  onChange: (node: FlowNode) => void
  defaultOpen?: boolean
}) {
  const keys = advancedParamKeys(node.type)
  const [open, setOpen] = useState(defaultOpen)
  if (!keys.length) return null

  const data = node.data as Record<string, unknown>
  const setCount = advancedParamsSetCount(node)
  const patch = (values: Record<string, unknown>) => onChange({ ...node, data: { ...node.data, ...values } } as FlowNode)
  const clearAll = () => patch(Object.fromEntries(keys.map((key) => [key, undefined])))
  const maxTimeoutSeconds = node.type === 'code'
    ? 30
    : ['agent', 'ai', 'subflow'].includes(node.type)
      ? AGENT_RUN_MAX_DURATION_SECONDS
      : 120

  const control = (key: AdvancedParamKey) => {
    if (key === 'onError') {
      return (
        <select
          className={controlClass}
          value={(data.onError as string | undefined) ?? 'stop'}
          onChange={(event) => patch({ onError: event.target.value })}
        >
          <option value="stop">Stop flow on error</option>
          <option value="continue">Continue on error</option>
          <option value="route">Route failures to an error path</option>
        </select>
      )
    }
    if (key === 'retries') {
      return (
        <input
          type="number"
          min={0}
          max={5}
          className={controlClass}
          value={(data.retries as number | undefined) ?? 0}
          onChange={(event) => patch({ retries: Math.max(0, Math.min(5, Number(event.target.value) || 0)) })}
        />
      )
    }
    if (key === 'timeoutMs') {
      const timeoutMs = data.timeoutMs as number | undefined
      return (
        <input
          type="number"
          min={1}
          max={maxTimeoutSeconds}
          className={controlClass}
          placeholder="No timeout"
          value={timeoutMs ? Math.round(timeoutMs / 1000) : ''}
          onChange={(event) => {
            const secs = Number(event.target.value)
            patch({ timeoutMs: secs > 0 ? Math.max(1, Math.min(maxTimeoutSeconds, secs)) * 1000 : undefined })
          }}
        />
      )
    }
    if (key === 'bodyMode') {
      return (
        <select className={controlClass} value={(data.bodyMode as string | undefined) ?? 'json'} onChange={(event) => patch({ bodyMode: event.target.value })}>
          <option value="json">JSON body</option>
          <option value="text">Text body</option>
          <option value="none">No body</option>
        </select>
      )
    }
    if (key === 'responseType') {
      return (
        <select className={controlClass} value={(data.responseType as string | undefined) ?? 'auto'} onChange={(event) => patch({ responseType: event.target.value })}>
          <option value="auto">Parse response automatically</option>
          <option value="json">Parse response as JSON</option>
          <option value="text">Parse response as text</option>
          <option value="file">Download as a file</option>
        </select>
      )
    }
    if (key === 'failOnHttpError') {
      return (
        <select
          className={controlClass}
          value={data.failOnHttpError === false ? 'false' : 'true'}
          onChange={(event) => patch({ failOnHttpError: event.target.value !== 'false' })}
        >
          <option value="true">Fail on 4xx/5xx</option>
          <option value="false">Return the response</option>
        </select>
      )
    }
    // concurrency
    return (
      <input
        type="number"
        min={1}
        max={20}
        className={controlClass}
        value={(data.concurrency as number | undefined) ?? 3}
        onChange={(event) => patch({ concurrency: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })}
      />
    )
  }

  const LABELS: Record<AdvancedParamKey, string> = {
    onError: 'On error',
    retries: 'Retries',
    timeoutMs: 'Timeout (seconds)',
    bodyMode: 'Body type',
    responseType: 'Parse response as',
    failOnHttpError: 'HTTP errors',
    concurrency: 'At a time',
  }

  return (
    <div className="border-t border-slate-200 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">Advanced parameters</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            {open ? 'Hide all' : `Showing ${setCount} of ${keys.length} — Show all`}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={setCount === 0}
            className="rounded-md px-2 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {keys.map((key) => (
            <div key={key} className="grid gap-1.5">
              <label className={labelClass}>{LABELS[key]}</label>
              {control(key)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
