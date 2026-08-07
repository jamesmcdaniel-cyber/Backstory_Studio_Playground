'use client'

import { useEffect, useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { ChevronRight, Download, Pencil, Play, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Markdown } from '@/components/ui/markdown'
import { HtmlPreview, looksLikeHtml } from '@/components/ui/html-preview'
import { StructuredValueView } from '@/components/flows/structured-value-view'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { agentExecChannel } from '@/lib/flows/run-stream'
import { STATUS_TEXT as SHARED_STATUS_TEXT } from '@/lib/flows/node-presentation'
import { TypewriterStatus } from '@/components/ui/typewriter-status'
import { buildProcessTimeline, processFeedRows, type ProcessFeedRow } from '@/lib/agents/process-feed'
import type { StepStatus } from './step-card'

export type RunStep = {
  nodeId: string
  status: StepStatus
  order: number
  error?: string | null
  input?: unknown
  output?: unknown
  // console.log / print() output captured from a code step (display-only).
  logs?: string[] | null
  startedAt?: string | null
  finishedAt?: string | null
  // Agent steps: the underlying agent execution, linked as soon as it starts,
  // so the panel can show the agent's real live process instead of a spinner.
  agentExecutionId?: string | null
}
export type FlowRunDetail = {
  id: string
  status: string
  startedAt?: string
  finishedAt?: string | null
  input?: unknown
  output?: unknown
  error?: string | null
  trigger?: unknown
  waiting?: { nodeId: string; kind: 'input' | 'approval'; question?: string } | null
  steps: RunStep[]
}

/** Whether the run replayed the last successful run's input (execute-flow marks it). */
function reusedInputOf(trigger: unknown): boolean {
  return Boolean(
    trigger &&
    typeof trigger === 'object' &&
    !Array.isArray(trigger) &&
    (trigger as { reusedInput?: unknown }).reusedInput === true,
  )
}

// Loosened to string keys at the edge: run statuses arrive as plain strings.
const STATUS_TEXT: Record<string, string> = SHARED_STATUS_TEXT

function preview(value: unknown): string {
  if (value == null) return '—'
  // The schema default: rows written before input capture existed (and skip
  // rows) carry a literal {} — render the same em-dash as "nothing recorded".
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0) return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Save a step's output as a local file: objects as .json, text as .txt/.csv/.html by shape. */
function downloadOutput(value: unknown, baseName: string) {
  const isString = typeof value === 'string'
  const body = isString ? (value as string) : JSON.stringify(value, null, 2)
  const trimmed = isString ? (value as string).trim() : ''
  const ext = !isString
    ? 'json'
    : trimmed.startsWith('<table') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')
      ? 'html'
      : /^[^,\n]+(,[^,\n]*)+\n/.test(trimmed)
        ? 'csv'
        : 'txt'
  const mime = ext === 'json' ? 'application/json' : ext === 'html' ? 'text/html' : ext === 'csv' ? 'text/csv' : 'text/plain'
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${baseName.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'step-output'}.${ext}`
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Prose step outputs render as Markdown (HTML reports render live); structured data stays monospaced. */
function OutputView({ value }: { value: unknown }) {
  // The rendered view (Markdown / live HTML) is a derivative — the toggle
  // guarantees the RAW persisted value is always one click away.
  const [showRaw, setShowRaw] = useState(false)
  const isProse =
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.trim()[0] !== '{' &&
    value.trim()[0] !== '['
  if (isProse) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="mb-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          {showRaw ? 'Show rendered' : 'Show raw'}
        </button>
        {showRaw ? (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted px-2 py-1.5 text-xs">{value as string}</pre>
        ) : looksLikeHtml(value as string) ? (
          // A report-format step output (self-contained HTML document) renders
          // as the actual report, matching the assistant panel.
          <HtmlPreview html={value as string} />
        ) : (
          <div className="max-h-56 overflow-auto rounded border border-border/60 bg-background px-2.5 py-2">
            <Markdown className="text-xs [&_p]:leading-5">{value as string}</Markdown>
          </div>
        )}
      </div>
    )
  }
  // Structured output: table (for lists of records) / JSON, with in-panel search.
  return <StructuredValueView value={value} maxHeight="max-h-56" />
}

/**
 * Live process feed for an in-flight agent step: polls the agent execution's
 * real events (thinking, plan, tool calls) every 2 seconds while `active`.
 * The interval is cleared when the step goes terminal or the run selection
 * changes (`active`/`executionId` flip) and on unmount — the panel is only
 * mounted while open, so closing it stops the polling too.
 */
function useAgentProcessFeed(executionId: string | null | undefined, active: boolean, waiting = false): ProcessFeedRow[] {
  const [rows, setRows] = useState<ProcessFeedRow[]>([])
  useEffect(() => {
    setRows([]) // never show a previous execution's feed while the first fetch is in flight
    if (!executionId || !active) return
    let cancelled = false
    const load = () =>
      fetch(`/api/workflows/executions?executionId=${encodeURIComponent(executionId)}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((data) => {
          if (cancelled) return
          const item = data?.items?.[0]
          if (!item) return
          const { items } = buildProcessTimeline(item.events ?? [], item.steps ?? [])
          setRows(processFeedRows(items))
        })
        .catch(() => undefined)
    load()
    // A waiting step's feed is static until the user replies — poll gently so
    // a panel left open on a long-waiting run doesn't hammer the API.
    // Visibility-gated: a panel left open on a backgrounded tab stops polling
    // and catches up the moment it is looked at again.
    const stopPolling = startVisibleInterval(load, waiting ? 15000 : 2000)
    // Live streaming: refetch the instant the agent emits an event (debounced),
    // so thinking / tool-call rows appear near-live instead of on the 2s poll.
    let debounce: ReturnType<typeof setTimeout> | null = null
    const nudge = () => {
      if (debounce) return
      debounce = setTimeout(() => { debounce = null; load() }, 300)
    }
    let supabase: ReturnType<typeof createClient> | null = null
    let channel: RealtimeChannel | null = null
    try {
      supabase = createClient()
      channel = supabase.channel(agentExecChannel(executionId))
      channel.on('broadcast', { event: 'tick' }, nudge).subscribe()
    } catch {
      // No Supabase — the poll fallback covers it.
    }
    return () => {
      cancelled = true
      stopPolling()
      if (debounce) clearTimeout(debounce)
      if (supabase && channel) void supabase.removeChannel(channel)
    }
  }, [executionId, active, waiting])
  return rows
}

function StepRow({ step, label, waitingKind, onRerunFrom, onForkWithEdits }: { step: RunStep; label: string; waitingKind?: 'input' | 'approval'; onRerunFrom?: () => void; onForkWithEdits?: () => void }) {
  const [open, setOpen] = useState(false)
  // An in-flight agent step with a linked execution shows the agent's REAL
  // process (below) instead of the decorative typewriter word. Steps without
  // an execution id (http/tool steps, or an id not yet written) keep the
  // typewriter.
  const live = (step.status === 'running' || step.status === 'waiting') && Boolean(step.agentExecutionId)
  const feed = useAgentProcessFeed(step.agentExecutionId, live, step.status === 'waiting')
  // A paused step reads as what it needs, never the bare status word.
  const statusLabel = waitingKind ? (waitingKind === 'input' ? 'Waiting for your reply' : 'Waiting for approval') : step.status
  return (
    <div className="border-b border-border/60 last:border-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="flex-1 truncate text-sm">{label}</span>
        <span className={cn('text-xs font-medium', !waitingKind && 'capitalize', STATUS_TEXT[step.status] || 'text-muted-foreground')}>{step.status === 'running' && !live ? <TypewriterStatus seed={step.nodeId.length ? step.nodeId.charCodeAt(step.nodeId.length - 1) : 0} /> : statusLabel}</span>
      </button>
      {live && feed.length > 0 && (
        <ul className="space-y-1 px-3 pb-2 pl-8">
          {feed.map((row, i) => (
            <li
              key={row.key}
              className={cn(
                'truncate text-xs',
                i === feed.length - 1 && step.status === 'running' ? 'animate-pulse text-foreground/70' : 'text-muted-foreground',
              )}
            >
              {row.label}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="space-y-2 px-3 pb-3 pl-8">
          {step.error && <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{step.error}</p>}
          <div>
            <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</p>
            <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 text-xs">{preview((step.input as { prompt?: unknown })?.prompt ?? step.input)}</pre>
          </div>
          {/* A waiting step's stored output is the internal pause record — the
              banner explains the pause in plain english; the timing details
              (resume time, webhook timeout) surface here so "what exactly is
              it waiting for" is answerable without reading the database. */}
          {step.status === 'waiting' && (() => {
            const waiting = (step.output as { waiting?: { kind?: string; resumeAt?: string; timeoutAt?: string } } | null)?.waiting
            if (!waiting) return null
            return (
              <p className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                {waiting.kind === 'timer' && waiting.resumeAt
                  ? `Waiting until ${new Date(waiting.resumeAt).toLocaleString()}`
                  : waiting.kind === 'webhook'
                    ? `Waiting for a webhook callback${waiting.timeoutAt ? ` (gives up ${new Date(waiting.timeoutAt).toLocaleString()})` : ''}`
                    : waiting.kind === 'approval'
                      ? 'Waiting for an approval decision'
                      : 'Waiting for a reply'}
              </p>
            )
          })()}
          {Array.isArray(step.logs) && step.logs.length > 0 && (
            <div>
              <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Logs</p>
              <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 text-xs">{(step.logs as unknown[]).map((line) => String(line)).join('\n')}</pre>
            </div>
          )}
          {step.status !== 'waiting' && (
            <div>
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Output</p>
                {onRerunFrom && (
                  <button
                    type="button"
                    onClick={onRerunFrom}
                    className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
                    title="Start a new run that replays everything before this step, then runs from here"
                  >
                    <RotateCcw className="h-3 w-3" /> Re-run from here
                  </button>
                )}
                {onForkWithEdits && (
                  <button
                    type="button"
                    onClick={onForkWithEdits}
                    className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
                    title="Run again with this step's result replaced by a value you choose"
                  >
                    <Pencil className="h-3 w-3" /> Run with edits
                  </button>
                )}
                {step.output != null && (
                  <button
                    type="button"
                    onClick={() => downloadOutput(step.output, step.nodeId)}
                    className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
                    title="Save this output as a file"
                  >
                    <Download className="h-3 w-3" /> Download
                  </button>
                )}
              </div>
              <OutputView value={step.output} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Blue banner shown while a run is paused — carries the reply box for agent questions. */
function WaitingBanner({
  waiting,
  runId,
  onReply,
}: {
  waiting: NonNullable<FlowRunDetail['waiting']>
  runId: string
  onReply?: (flowRunId: string, reply: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const submit = async () => {
    const reply = text.trim()
    if (!reply || sending || !onReply) return
    setSending(true)
    try {
      await onReply(runId, reply)
      setText('')
    } catch {
      // The page already surfaced the error — keep the text for a retry.
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="border-b border-border p-2">
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-900/40 dark:bg-blue-950/40">
        {waiting.kind === 'approval' ? (
          <>
            <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">Waiting for an approval decision</p>
            <p className="mt-1 text-xs text-blue-800 dark:text-blue-300">A step needs an approval before this run can continue.</p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">Waiting for your reply</p>
            {/* Neutral fallback: input pauses come from agent questions AND humanReview steps. */}
            <Markdown className="mt-1 space-y-2 text-xs text-blue-800 dark:text-blue-300 [&_li]:marker:text-blue-600 [&_strong]:text-blue-900 dark:[&_strong]:text-blue-200">
              {waiting.question || 'This flow is waiting on information from you.'}
            </Markdown>
            <textarea
              onKeyDown={indentOnTab}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder="Type your reply…"
              disabled={sending}
              className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-blue-300 dark:focus:border-blue-800"
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" onClick={submit} loading={sending} disabled={!text.trim() || sending}>
                Send reply
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function RunPanel({
  runs,
  selected,
  onSelectRun,
  onClose,
  labelForNode,
  onReply,
  onRerunFrom,
  onForkWithEdits,
}: {
  runs: { id: string; status: string; startedAt?: string }[]
  selected: FlowRunDetail | null
  onSelectRun: (runId: string) => void
  onClose: () => void
  labelForNode: (nodeId: string) => string
  onReply?: (flowRunId: string, reply: string) => Promise<void>
  onRerunFrom?: (runId: string, nodeId: string) => void
  onForkWithEdits?: (runId: string, nodeId: string, recordedOutput: unknown, runFailed: boolean) => void
}) {
  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Runs</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* Radix Select forbids empty item values, and with zero runs the panel
          body already shows the designed empty state — so no runs, no selector. */}
      {runs.length > 0 && (
        <div className="border-b border-border p-2">
          <Select value={selected?.id} onValueChange={onSelectRun}>
            <SelectTrigger className="h-8 w-full text-xs" aria-label="Select a run">
              <SelectValue placeholder="Select a run" />
            </SelectTrigger>
            <SelectContent>
              {runs.map((run) => (
                <SelectItem key={run.id} value={run.id} className="text-xs">
                  {run.status} · {run.startedAt ? new Date(run.startedAt).toLocaleString() : run.id.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <EmptyState
            icon={Play}
            title="No runs yet"
            description="Run the flow and every step's input, output, and timing shows up here."
            className="m-3 py-10"
          />
        ) : (
          <>
            <div className="border-b border-border px-3 py-2">
              <span className={cn('text-xs font-semibold capitalize', STATUS_TEXT[selected.status])}>{selected.status === 'running' ? <TypewriterStatus /> : selected.status}</span>
              {reusedInputOf(selected.trigger) && (
                <p className="mt-1 text-xs text-muted-foreground">Using the input from the last successful run.</p>
              )}
              {selected.error && <p className="mt-1 text-xs text-red-600">{selected.error}</p>}
            </div>
            {selected.status === 'waiting' && selected.waiting && (
              <WaitingBanner key={selected.id} waiting={selected.waiting} runId={selected.id} onReply={onReply} />
            )}
            {selected.steps.length === 0 ? (
              <EmptyState
                title="No steps recorded"
                description="This run ended before any step executed."
                className="m-3 py-8"
              />
            ) : (
              selected.steps.map((step, i) => (
                <StepRow
                  key={`${step.nodeId}-${i}`}
                  step={step}
                  label={labelForNode(step.nodeId)}
                  onRerunFrom={
                    onRerunFrom && (selected.status === 'succeeded' || selected.status === 'failed')
                      ? () => onRerunFrom(selected.id, step.nodeId.split('#')[0])
                      : undefined
                  }
                  onForkWithEdits={
                    onForkWithEdits && (selected.status === 'succeeded' || selected.status === 'failed')
                      ? () =>
                          onForkWithEdits(
                            selected.id,
                            step.nodeId.split('#')[0],
                            step.output,
                            selected.status === 'failed',
                          )
                      : undefined
                  }
                  waitingKind={step.status === 'waiting' && selected.waiting?.nodeId === step.nodeId ? selected.waiting.kind : undefined}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}
