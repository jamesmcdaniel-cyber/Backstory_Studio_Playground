'use client'

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link2, RefreshCw, Copy, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CONDITION_OPS, CONDITION_OP_LABELS, type ConditionOp, type ConditionClause, type TriggerInputField } from '@/lib/flows/graph'
import { KNOWN_SIGNALS, KNOWN_SIGNAL_LABELS } from '@/lib/flows/trigger'
import { nextOccurrence, type AgentSchedule } from '@/lib/scheduling/due'
import { DataTree } from '@/components/flows/data-tree'
import { buildDataTree } from '@/lib/flows/datatree'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'

export type TriggerData = {
  type?: 'manual' | 'schedule' | 'webhook' | 'signal' | 'poll'
  schedule?: { type?: string; time?: string; cron?: string; timezone?: string; runAt?: string; isActive?: boolean }
  input?: string
  inputFields?: TriggerInputField[]
  signal?: string
  /**
   * Webhook reply mode. 'whenFinished' (the default) holds the caller's request
   * open until the run finishes and answers with its result; 'immediately'
   * acknowledges and runs in the background. Read by the trigger route.
   */
  responseMode?: 'whenFinished' | 'immediately'
  condition?: { match?: 'all' | 'any'; clauses?: ConditionClause[] }
  // Poll trigger: which read-tool to call and how to detect new items.
  connectionId?: string
  toolName?: string
  args?: string
  itemsPath?: string
  dedupeKey?: string
  emit?: 'perItem' | 'batch'
}

/** Minimal tool catalog shape the poll picker needs (no step-drawer dependency). */
export type TriggerToolCatalog = { id: string; name?: string; tools?: { name: string }[] }[]

export type TriggerEditorClasses = { field: string; label: string; smallField: string }

// No step precedes the trigger, so its condition can only reference the run's
// own input — not other steps' output — hence an empty step-label map.
const TRIGGER_LABEL_CTX: TokenLabelContext = { stepLabels: {} }

/** Frequencies the schedule editor offers (matches AgentSchedule types). */
const FREQUENCIES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Cron expression' },
  { value: 'once', label: 'Once' },
] as const

// Defaults for the classes prop — copied from the drawer's local class
// strings (not imported, so this component has no compile-time dependency on
// step-drawer.tsx).
const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'
const smallFieldDefault =
  'rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'

function clausesOf(data: { clauses?: ConditionClause[]; left?: string; op?: ConditionOp; right?: string }): ConditionClause[] {
  if (data.clauses && data.clauses.length) return data.clauses
  if (data.left !== undefined || data.right !== undefined)
    return [{ left: data.left ?? '', op: data.op ?? 'contains', right: data.right ?? '' }]
  return [{ left: '', op: 'contains', right: '' }]
}

/** The trigger node's editor: manual, a real schedule, or an inbound webhook. */
export function TriggerEditor({
  flowId,
  trigger,
  onChange,
  published,
  classes,
  children,
  toolCatalog = [],
  onPersisted,
}: {
  flowId: string
  trigger: TriggerData
  onChange: (trigger: TriggerData) => void
  published?: boolean
  classes?: Partial<TriggerEditorClasses>
  children?: ReactNode
  toolCatalog?: TriggerToolCatalog
  /** A secret rotation persists Flow.trigger outside the graph autosave path. */
  onPersisted?: (updatedAt: string) => void
}) {
  const { field, label, smallField } = { field: fieldClass, label: labelClass, smallField: smallFieldDefault, ...classes }
  const typeSelectId = useId()
  const replyModeSelectId = useId()
  const [webhook, setWebhook] = useState<{ url: string; secret: string | null; hasSecret: boolean } | null>(null)
  const [minting, setMinting] = useState(false)
  const type = trigger.type ?? 'manual'
  const schedule = trigger.schedule ?? { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true }
  const sampleWebhookBody = JSON.stringify({ input: { account: 'Acme', priority: 'high' } }, null, 2)
  const webhookHeader = webhook?.secret ? `x-trigger-secret: ${webhook.secret}` : 'x-trigger-secret: <secret>'
  const curlExample = webhook
    ? `curl -X POST '${webhook.url}' \\\n  -H 'content-type: application/json' \\\n  -H '${webhookHeader}' \\\n  -H 'x-trigger-delivery-id: evt_123_unique' \\\n  -H "x-trigger-timestamp: $(date +%s)" \\\n  --data '${JSON.stringify({ input: { account: 'Acme', priority: 'high' } })}'`
    : ''

  // Auto-load the webhook's status (URL + whether a secret already exists)
  // instead of requiring a manual mint click just to see it — GET never
  // returns the secret itself, only hasSecret.
  useEffect(() => {
    if (!flowId) return
    if (type !== 'webhook') return
    let alive = true
    fetch(`/api/flows/${flowId}/trigger-secret`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Never clobber a mint that finished while this GET was in flight —
        // the plaintext secret is shown exactly once and is unrecoverable.
        if (alive && d?.success) setWebhook((prev) => (prev?.secret ? prev : { url: d.url, secret: null, hasSecret: d.hasSecret }))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [type, flowId])

  // Chip-editor handles for the "only run when…" condition rows — the same
  // register/focus/insert pattern StepDrawer uses for step fields, scoped
  // locally since the trigger editor lives outside that component.
  const conditionEditorHandles = useRef<Map<string, TokenTextEditorHandle | null>>(new Map())
  const activeConditionField = useRef<string | null>(null)
  const registerConditionEditor = (key: string) => (handle: TokenTextEditorHandle | null) => {
    conditionEditorHandles.current.set(key, handle)
  }
  const focusConditionEditor = (key: string) => () => {
    activeConditionField.current = key
  }
  const insertConditionToken = (token: string) => {
    const path = token.startsWith('{{') && token.endsWith('}}') ? token.slice(2, -2).trim() : token
    const key = activeConditionField.current ?? 'trig.0.left'
    conditionEditorHandles.current.get(key)?.insertToken(path)
  }
  // Only the trigger's own declared input fields are pickable here — nothing
  // precedes the trigger, so there is no upstream step data to offer.
  const conditionDataFields = useMemo(
    () => buildDataTree({ upstream: [], inputFields: trigger.inputFields ?? [], context: false }),
    [trigger.inputFields],
  )
  const conditionClauses = clausesOf(trigger.condition ?? {})
  const updateConditionClauses = (next: ConditionClause[]) =>
    onChange({ ...trigger, condition: { ...trigger.condition, clauses: next } })

  const setSchedule = (patch: Partial<NonNullable<TriggerData['schedule']>>) =>
    onChange({ ...trigger, type: 'schedule', schedule: { ...schedule, ...patch, isActive: true } })

  // "Next run" preview for the schedule editor. IMPORTANT: nextOccurrence's cron
  // path does a minute-by-minute scan and has measured up to ~13s worst case —
  // far too slow to call on every render/keystroke. So this memo only ever
  // calls nextOccurrence for the fast schedule types (hourly/daily/weekly/once);
  // cron gets a static, non-computed label below instead.
  const nextRunLabel = useMemo(() => {
    if (schedule.type === 'cron') return null
    const merged: AgentSchedule = {
      type: (schedule.type as AgentSchedule['type']) ?? 'daily',
      time: schedule.time ?? '09:00',
      cron: schedule.cron ?? '',
      timezone: schedule.timezone ?? 'UTC',
      runAt: schedule.runAt,
      isActive: true,
    }
    const next = nextOccurrence(merged, new Date())
    return next ? next.toLocaleString() : 'Not scheduled'
  }, [schedule.type, schedule.time, schedule.timezone, schedule.runAt, schedule.cron])

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied.`)
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}.`)
    }
  }

  const mintWebhook = async (rotate: boolean) => {
    if (!flowId) {
      // Without an id the POST would hit /api/flows//trigger-secret and 404 —
      // say so instead of silently doing nothing.
      toast.error('Save the flow first, then create the webhook.')
      return
    }
    setMinting(true)
    try {
      const response = await fetch(`/api/flows/${flowId}/trigger-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotate }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not create the webhook URL.')
        return
      }
      setWebhook({ url: data.url, secret: data.secret, hasSecret: true })
      if (typeof data.updatedAt === 'string') onPersisted?.(data.updatedAt)
      if (data.secret) toast.success('Webhook secret created — copy it now; it is shown only once.')
    } finally {
      setMinting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className={label} htmlFor={typeSelectId}>Trigger type</label>
        <select
          id={typeSelectId}
          className={field}
          value={type}
          onChange={(e) => {
            const next = e.target.value as 'manual' | 'schedule' | 'webhook' | 'signal' | 'poll'
            onChange(next === 'schedule' || next === 'poll' ? { ...trigger, type: next, schedule: { ...schedule, isActive: true } } : { ...trigger, type: next })
          }}
        >
          <option value="manual">Manual / on run</option>
          <option value="schedule">Schedule</option>
          <option value="poll">When new items appear in an app (check on a schedule)</option>
          <option value="webhook">When an HTTP request is received</option>
          <option value="signal">Signal (in-platform event)</option>
        </select>
      </div>

      {children}

      {type === 'schedule' && (
        <div className="space-y-3">
          <div>
            <label className={label}>Frequency</label>
            <select className={field} value={schedule.type ?? 'daily'} onChange={(e) => setSchedule({ type: e.target.value })}>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {['daily', 'weekly', 'once'].includes(schedule.type ?? 'daily') && (
            <div>
              <label className={label}>Time (HH:MM)</label>
              <input className={field} value={schedule.time ?? '09:00'} placeholder="09:00" onChange={(e) => setSchedule({ time: e.target.value })} />
            </div>
          )}
          {schedule.type === 'once' && (
            <div>
              <label className={label}>Date (YYYY-MM-DD)</label>
              <input className={field} value={schedule.runAt ?? ''} placeholder="2026-07-15" onChange={(e) => setSchedule({ runAt: e.target.value })} />
            </div>
          )}
          {schedule.type === 'cron' && (
            <div>
              <label className={label}>Cron expression</label>
              <input className={`${field} font-mono`} value={schedule.cron ?? ''} placeholder="0 9 * * 1-5" onChange={(e) => setSchedule({ cron: e.target.value })} />
            </div>
          )}
          <div>
            <label className={label}>Timezone</label>
            <input className={field} value={schedule.timezone ?? 'UTC'} placeholder="America/Denver" onChange={(e) => setSchedule({ timezone: e.target.value })} />
          </div>
          <div>
            <label className={label}>Run input for scheduled runs (optional)</label>
            <textarea rows={2} className={field} value={trigger.input ?? ''} placeholder="Text or JSON passed to the flow each time it runs" onChange={(e) => onChange({ ...trigger, input: e.target.value || undefined })} />
          </div>
          <p className="text-xs text-muted-foreground">
            {schedule.type === 'cron' ? `Next run: per cron "${schedule.cron ?? ''}"` : `Next run: ${nextRunLabel}`}
          </p>
          <p className="text-xs text-muted-foreground">Scheduled runs execute the <strong>published</strong> version — publish the flow to arm the schedule.</p>
        </div>
      )}

      {type === 'poll' && (
        <div className="space-y-3">
          <div>
            <label className={label}>Check this app</label>
            <select
              className={field}
              value={trigger.connectionId ?? ''}
              onChange={(e) => onChange({ ...trigger, connectionId: e.target.value || undefined, toolName: undefined })}
            >
              <option value="">Select a connection…</option>
              {toolCatalog.map((conn) => (
                <option key={conn.id} value={conn.id}>{conn.name || conn.id}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>For new items from</label>
            <select
              className={field}
              value={trigger.toolName ?? ''}
              onChange={(e) => onChange({ ...trigger, toolName: e.target.value || undefined })}
              disabled={!trigger.connectionId}
            >
              <option value="">Select a read action…</option>
              {(toolCatalog.find((c) => c.id === trigger.connectionId)?.tools ?? []).map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">Pick a read action (e.g. list records). It runs on the schedule below; only items you haven&apos;t seen before start the flow.</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={label}>New-item id field</label>
              <input className={field} value={trigger.dedupeKey ?? ''} placeholder="id" onChange={(e) => onChange({ ...trigger, dedupeKey: e.target.value || undefined })} />
            </div>
            <div>
              <label className={label}>List field (optional)</label>
              <input className={field} value={trigger.itemsPath ?? ''} placeholder="data" onChange={(e) => onChange({ ...trigger, itemsPath: e.target.value || undefined })} />
            </div>
          </div>
          <div>
            <label className={label}>Start the flow</label>
            <select className={field} value={trigger.emit ?? 'perItem'} onChange={(e) => onChange({ ...trigger, emit: e.target.value as 'perItem' | 'batch' })}>
              <option value="perItem">Once per new item</option>
              <option value="batch">Once with all new items</option>
            </select>
          </div>
          <div>
            <label className={label}>Check every</label>
            <select className={field} value={schedule.type ?? 'hourly'} onChange={(e) => setSchedule({ type: e.target.value })}>
              {FREQUENCIES.filter((f) => f.value !== 'once').map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
          {['daily', 'weekly'].includes(schedule.type ?? 'hourly') && (
            <div>
              <label className={label}>Time (HH:MM)</label>
              <input className={field} value={schedule.time ?? '09:00'} placeholder="09:00" onChange={(e) => setSchedule({ time: e.target.value })} />
            </div>
          )}
          {schedule.type === 'cron' && (
            <div>
              <label className={label}>Cron expression</label>
              <input className={`${field} font-mono`} value={schedule.cron ?? ''} placeholder="*/15 * * * *" onChange={(e) => setSchedule({ cron: e.target.value })} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">Polls the <strong>published</strong> version. The first check just learns what already exists; new items after that start the flow.</p>
        </div>
      )}

      {type === 'signal' && (
        <div className="space-y-3">
          <div>
            <label className={label}>Signal name</label>
            <input
              className={field}
              list="known-signals"
              value={trigger.signal ?? ''}
              placeholder="flow.completed"
              onChange={(e) => onChange({ ...trigger, signal: e.target.value || undefined })}
            />
            <datalist id="known-signals">
              {KNOWN_SIGNALS.map((signal) => (
                <option key={signal} value={signal} label={KNOWN_SIGNAL_LABELS[signal]} />
              ))}
            </datalist>
          </div>
          <p className="text-xs text-muted-foreground">
            Fires when this signal is emitted anywhere in your workspace. The signal payload arrives as the Run input. Runs the published version.
            Besides the built-in names, integration events arrive as <code className="font-mono">provider.&lt;app&gt;</code> (e.g. <code className="font-mono">provider.salesforce</code>) and People.ai events as <code className="font-mono">people-ai.&lt;event-type&gt;</code>.
          </p>
          <p className="text-xs text-muted-foreground">
            Tip: use <code className="rounded bg-muted px-1">provider.&lt;app&gt;</code> (e.g. <code className="rounded bg-muted px-1">provider.github</code>) to fire when a connected app forwards new items through Nango.
          </p>
        </div>
      )}

      {type === 'webhook' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => mintWebhook(false)} loading={minting}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" /> {webhook && !webhook.hasSecret ? 'Create webhook secret' : 'Get webhook URL'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => mintWebhook(true)} title="Rotate the secret (invalidates the old one)">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          {webhook?.hasSecret && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-2.5">
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Webhook URL</p>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(webhook.url, 'Webhook URL')}>
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <p className="break-all rounded bg-background px-2 py-1.5 font-mono text-[11px]">{webhook.url}</p>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Auth header</p>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(webhookHeader, 'Auth header')}>
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <p className="break-all rounded bg-background px-2 py-1.5 font-mono text-[11px] text-amber-700 dark:text-amber-400">{webhookHeader}</p>
                {!webhook.secret && <p className="mt-1 text-[11px] text-muted-foreground">A secret already exists. Rotate to mint and display a new one.</p>}
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Example JSON body</p>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(sampleWebhookBody, 'Example JSON body')}>
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <pre className="max-h-32 overflow-auto rounded bg-background px-2 py-1.5 text-[11px]">{sampleWebhookBody}</pre>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">cURL</p>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(curlExample, 'cURL example')}>
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <pre className="max-h-36 overflow-auto rounded bg-background px-2 py-1.5 text-[11px]">{curlExample}</pre>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            POST to the URL with the <code className="font-mono">x-trigger-secret</code> header; the JSON body, or its <code className="font-mono">input</code> field, becomes the flow input.
            The <code className="font-mono">x-trigger-delivery-id</code> / <code className="font-mono">x-trigger-timestamp</code> headers are optional — include them (as in the cURL) and repeated deliveries of the same event are deduplicated.{' '}
            {published === false ? (
              'Webhook calls run the published version — publish this flow to arm the webhook.'
            ) : published ? (
              'Armed — calls to this URL start a run.'
            ) : (
              <>Runs the <strong>published</strong> version.</>
            )}
          </p>
          <div>
            <label className={label} htmlFor={replyModeSelectId}>What the caller gets back</label>
            <select
              id={replyModeSelectId}
              className={field}
              value={trigger.responseMode ?? 'whenFinished'}
              onChange={(e) => onChange({ ...trigger, responseMode: e.target.value as TriggerData['responseMode'] })}
            >
              <option value="whenFinished">Wait for the run, reply with its result</option>
              <option value="immediately">Reply right away, run in the background</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {trigger.responseMode === 'immediately'
                ? 'The call is acknowledged as soon as the run starts. Use this for senders that time out, or for fire-and-forget hooks.'
                : 'The call stays open until the run finishes and answers with its output. Senders that give up early should use the other mode.'}
            </p>
          </div>
        </div>
      )}

      {type !== 'manual' && (
        <div className="space-y-3 border-t border-border pt-4">
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <input
              type="checkbox"
              checked={Boolean(trigger.condition)}
              onChange={(e) =>
                onChange({
                  ...trigger,
                  condition: e.target.checked ? { match: 'all', clauses: [{ left: '', op: 'contains', right: '' }] } : undefined,
                })
              }
            />
            Only run when…
          </label>
          {trigger.condition && (
            <div className="space-y-3">
              <div>
                <label className={label}>Match</label>
                <select
                  className={field}
                  value={trigger.condition.match ?? 'all'}
                  onChange={(e) => onChange({ ...trigger, condition: { ...trigger.condition, match: e.target.value as 'all' | 'any' } })}
                >
                  <option value="all">All conditions (AND)</option>
                  <option value="any">Any condition (OR)</option>
                </select>
              </div>
              {conditionClauses.map((clause, i) => (
                <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                  <TokenTextEditor
                    ref={registerConditionEditor(`trig.${i}.left`)}
                    className="px-2 py-1.5"
                    value={clause.left}
                    labelCtx={TRIGGER_LABEL_CTX}
                    placeholder="Choose data from below"
                    onFocus={focusConditionEditor(`trig.${i}.left`)}
                    onChange={(left) => updateConditionClauses(conditionClauses.map((c, j) => (j === i ? { ...c, left } : c)))}
                    ariaLabel={`Condition ${i + 1} value`}
                  />
                  <div className="flex gap-1.5">
                    <select
                      className={smallField}
                      value={clause.op}
                      onChange={(e) => updateConditionClauses(conditionClauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}
                    >
                      {CONDITION_OPS.map((op) => (
                        <option key={op} value={op}>
                          {CONDITION_OP_LABELS[op]}
                        </option>
                      ))}
                    </select>
                    <TokenTextEditor
                      ref={registerConditionEditor(`trig.${i}.right`)}
                      className="min-w-0 flex-1 px-2 py-1.5"
                      value={clause.right}
                      labelCtx={TRIGGER_LABEL_CTX}
                      placeholder="urgent"
                      onFocus={focusConditionEditor(`trig.${i}.right`)}
                      onChange={(right) => updateConditionClauses(conditionClauses.map((c, j) => (j === i ? { ...c, right } : c)))}
                      ariaLabel={`Condition ${i + 1} comparison value`}
                    />
                    {conditionClauses.length > 1 && (
                      <button
                        type="button"
                        onClick={() => updateConditionClauses(conditionClauses.filter((_, j) => j !== i))}
                        className="px-1 text-red-500 hover:text-red-700"
                        aria-label="Remove condition"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => updateConditionClauses([...conditionClauses, { left: '', op: 'contains', right: '' }])}
                className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
              >
                <Plus className="h-3.5 w-3.5" /> Add condition
              </button>
              <DataTree fields={conditionDataFields} onInsert={insertConditionToken} />
              <p className="text-xs text-muted-foreground">When this doesn&apos;t match, the run is skipped entirely — no history is recorded.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
