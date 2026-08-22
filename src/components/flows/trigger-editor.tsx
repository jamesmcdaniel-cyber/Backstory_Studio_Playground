'use client'

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { Link2, RefreshCw, Copy, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { CONDITION_OPS, CONDITION_OP_LABELS, type ConditionOp, type ConditionClause, type TriggerInputField } from '@/lib/flows/graph'
import { ACTIVITY_KINDS_CLIENT, ACTIVITY_KIND_LABELS, KNOWN_SIGNALS, KNOWN_SIGNAL_LABELS } from '@/lib/flows/trigger'
import { nextOccurrence, type AgentSchedule } from '@/lib/scheduling/due'
import {
  DAY_LABELS,
  cadenceOf,
  cronToTime,
  daysFromCron,
  dowCron,
  isPickerCron,
  scheduleForCadence,
  todayKey,
  type Cadence,
} from '@/lib/scheduling/cadence'
import { DataTree } from '@/components/flows/data-tree'
import { buildDataTree } from '@/lib/flows/datatree'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'

export type TriggerData = {
  type?: 'manual' | 'schedule' | 'webhook' | 'signal' | 'poll' | 'activity' | 'slack'
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
  // Activity trigger: which app + event types to watch, config shape from
  // src/lib/flows/trigger.ts's doc comment on FLOW_TRIGGER_TYPES.
  source?: string
  kinds?: string[]
  filters?: { channelId?: string; actorExternalId?: string }
  // Slack trigger: channelId + threadOnly narrow which Slack messages fire it;
  // shared with the activity trigger's own channelId-shaped filter above only
  // in spirit — the slack trigger keeps its own top-level fields (see
  // FLOW_TRIGGER_TYPES's doc comment: `{ type: 'slack', channelId?, threadOnly? }`).
  channelId?: string
  threadOnly?: boolean
}

/** One connected-app chip from GET /api/integrations/available, as far as the
 *  trigger editor needs it. */
type AvailableTool = { key: string; label: string; connected: boolean }

/**
 * Map a connected tool's registry key to the `source` string an activity
 * trigger stores and `normalizeNangoForward`/`normalizeSlackEvent`
 * (src/lib/activity/normalize.ts) actually produce: 'slack' and 'salesforce'
 * are literal matches, everything else falls to Nango's generic
 * `nango:<provider>` source the same way an unmapped provider does there.
 * Keeping this in lockstep with normalize.ts's own mapping is what makes the
 * source picker honest — it only ever lists a source some connected app can
 * actually emit, never an aspirational one.
 */
function activitySourceForToolKey(key: string): string {
  const k = key.toLowerCase()
  if (k === 'slack' || k === 'salesforce') return k
  return `nango:${k}`
}

/** Minimal tool catalog shape the poll picker needs (no step-drawer dependency). */
export type TriggerToolCatalog = { id: string; name?: string; tools?: { name: string }[] }[]

export type TriggerEditorClasses = { field: string; label: string; smallField: string }

// No step precedes the trigger, so its condition can only reference the run's
// own input — not other steps' output — hence an empty step-label map.
const TRIGGER_LABEL_CTX: TokenLabelContext = { stepLabels: {} }

/** Plain-English cadences the schedule editor offers — raw cron is never
 *  shown or accepted; day-of-week and sub-hourly cadences are stored as crons
 *  invisibly (src/lib/scheduling/cadence.ts). */
const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'every15min', label: 'Every 15 minutes' },
  { value: 'every30min', label: 'Every 30 minutes' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'daysofweek', label: 'Days of week' },
  { value: 'once', label: 'Once (specific date)' },
]

// Defaults for the classes prop — copied from the drawer's local class
// strings (not imported, so this component has no compile-time dependency on
// step-drawer.tsx).
const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'
const smallFieldDefault =
  'rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'

/** Weekday toggle chip for the "days of week" cadence. */
function DayToggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={
        on
          ? 'h-8 w-10 rounded-md border border-indigo-500 bg-indigo-500 text-xs font-medium text-white transition-colors'
          : 'h-8 w-10 rounded-md border border-border bg-transparent text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground'
      }
    >
      {label}
    </button>
  )
}

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
  const uid = useId()
  const [webhook, setWebhook] = useState<{ url: string; secret: string | null; hasSecret: boolean } | null>(null)
  const [minting, setMinting] = useState(false)
  const [availableTools, setAvailableTools] = useState<AvailableTool[]>([])
  const type = trigger.type ?? 'manual'
  const schedule = trigger.schedule ?? { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true }
  const sampleWebhookBody = JSON.stringify({ input: { account: 'Acme', priority: 'high' } }, null, 2)
  const webhookHeader = webhook?.secret ? `x-trigger-secret: ${webhook.secret}` : 'x-trigger-secret: <secret>'
  const curlExample = webhook
    ? `curl -X POST '${webhook.url}' \\\n  -H 'content-type: application/json' \\\n  -H '${webhookHeader}' \\\n  -H 'x-trigger-delivery-id: evt_123_unique' \\\n  -H "x-trigger-timestamp: $(date +%s)" \\\n  --data '${JSON.stringify({ input: { account: 'Acme', priority: 'high' } })}'`
    : ''

  // Auto-load the webhook's status (URL + whether a secret already exists) —
  // GET never returns the secret itself, only hasSecret. When no secret exists
  // yet, mint one automatically so the webhook is ready without a button click;
  // the ref guards against double-minting from Strict Mode's twin effect runs.
  const autoMintStarted = useRef(false)
  useEffect(() => {
    if (!flowId) return
    if (type !== 'webhook') return
    let alive = true
    fetch(`/api/flows/${flowId}/trigger-secret`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.success) return
        // Never clobber a mint that finished while this GET was in flight —
        // the plaintext secret is shown exactly once and is unrecoverable.
        setWebhook((prev) => (prev?.secret ? prev : { url: d.url, secret: null, hasSecret: d.hasSecret }))
        if (!d.hasSecret && !autoMintStarted.current) {
          autoMintStarted.current = true
          void mintWebhook(false, { auto: true })
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, flowId])

  // Which apps this workspace has actually connected — feeds the activity
  // trigger's source picker and the slack trigger's "connect Slack" hint. Only
  // fetched for the two event-trigger types; every other type never needs it.
  useEffect(() => {
    if (type !== 'activity' && type !== 'slack') return
    let alive = true
    fetch('/api/integrations/available', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.success) return
        setAvailableTools(Array.isArray(d.tools) ? d.tools : [])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [type])

  const slackConnected = availableTools.some((tool) => tool.key.toLowerCase() === 'slack' && tool.connected)
  const connectedSources = availableTools
    .filter((tool) => tool.connected)
    .map((tool) => ({ value: activitySourceForToolKey(tool.key), label: tool.label }))
  const selectedKinds = new Set((trigger.kinds ?? []).filter((kind) => kind.trim()))
  const toggleKind = (kind: string) => {
    const next = new Set(selectedKinds)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    onChange({ ...trigger, kinds: Array.from(next) })
  }
  const activityFilters = trigger.filters ?? {}
  const setActivityFilters = (patch: Partial<NonNullable<TriggerData['filters']>>) =>
    onChange({ ...trigger, filters: { ...activityFilters, ...patch } })

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

  // Keep the trigger's own type: the poll editor shares this schedule state,
  // and forcing 'schedule' here silently converted a poll into a plain
  // scheduled trigger the moment its cadence was edited.
  const setSchedule = (patch: Partial<NonNullable<TriggerData['schedule']>>) =>
    onChange({ ...trigger, type: type === 'poll' ? 'poll' : 'schedule', schedule: { ...schedule, ...patch, isActive: true } })

  // Plain-English cadence view over the stored schedule (cron never surfaces).
  const cadence = cadenceOf(schedule)
  const scheduleTime = schedule.type === 'cron' ? cronToTime(schedule.cron ?? '') : (schedule.time ?? '09:00')
  const selectedDays = cadence === 'daysofweek' ? daysFromCron(schedule.cron) : []

  const setCadence = (next: Cadence) =>
    setSchedule(
      scheduleForCadence(next, schedule, {
        time: scheduleTime,
        timezone: schedule.timezone || 'UTC',
        runAt: todayKey(),
        days: selectedDays,
      }),
    )

  const setTime = (time: string) =>
    cadence === 'daysofweek' ? setSchedule({ time, cron: dowCron(time, selectedDays) }) : setSchedule({ time })

  const toggleDay = (day: number) => {
    const next = selectedDays.includes(day) ? selectedDays.filter((d) => d !== day) : [...selectedDays, day]
    // Never allow zero days — keep at least the toggled one.
    setSchedule({ type: 'cron', cron: dowCron(scheduleTime, next.length ? next : [day]) })
  }

  // "Next run" preview for the schedule editor. IMPORTANT: nextOccurrence's cron
  // path does a minute-by-minute scan and has measured up to ~13s worst case on
  // arbitrary crons — so it only runs for the fast schedule types and for the
  // cron shapes our pickers generate (bounded within days); a legacy arbitrary
  // cron gets a static label below instead.
  const nextRunLabel = useMemo(() => {
    if (schedule.type === 'cron' && !isPickerCron(schedule.cron)) return null
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

  const mintWebhook = async (rotate: boolean, { auto = false } = {}) => {
    if (!flowId) {
      // Without an id the POST would hit /api/flows//trigger-secret and 404 —
      // say so instead of silently doing nothing.
      if (!auto) toast.error('Save the flow first, then create the webhook.')
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
        // The auto-mint is best-effort (e.g. the flow may not be editable);
        // surface errors only for an explicit user action.
        if (!auto) toast.error(data.error || 'Could not create the webhook URL.')
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
            const next = e.target.value as 'manual' | 'schedule' | 'webhook' | 'signal' | 'poll' | 'activity' | 'slack'
            onChange(next === 'schedule' || next === 'poll' ? { ...trigger, type: next, schedule: { ...schedule, isActive: true } } : { ...trigger, type: next })
          }}
        >
          <option value="manual">Manual / on run</option>
          <option value="schedule">Schedule</option>
          <option value="poll">When new items appear in an app (check on a schedule)</option>
          <option value="webhook">When an HTTP request is received</option>
          <option value="signal">Signal (in-platform event)</option>
          <option value="slack">When someone posts in Slack</option>
          <option value="activity">When something happens in a connected app</option>
        </select>
      </div>

      {children}

      {type === 'schedule' && (
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor={`${uid}-frequency`}>Frequency</label>
            <select id={`${uid}-frequency`} className={field} value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {CADENCES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {cadence === 'daysofweek' && (
            <div>
              <span id={`${uid}-repeat-on`} className={label}>Repeat on</span>
              <div role="group" aria-labelledby={`${uid}-repeat-on`} className="flex flex-wrap gap-1.5">
                {DAY_LABELS.map((dayLabel, day) => (
                  <DayToggle key={day} label={dayLabel} on={selectedDays.includes(day)} onToggle={() => toggleDay(day)} />
                ))}
              </div>
            </div>
          )}
          {['daily', 'daysofweek', 'once'].includes(cadence) && (
            <div>
              <label className={label} htmlFor={`${uid}-time`}>Time (HH:MM)</label>
              <input id={`${uid}-time`} className={field} value={scheduleTime} placeholder="09:00" onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          {cadence === 'once' && (
            <div>
              <label className={label} htmlFor={`${uid}-date`}>Date (YYYY-MM-DD)</label>
              <input id={`${uid}-date`} className={field} value={schedule.runAt ?? ''} placeholder="2026-07-15" onChange={(e) => setSchedule({ runAt: e.target.value })} />
            </div>
          )}
          <div>
            <label className={label} htmlFor={`${uid}-timezone`}>Timezone</label>
            <input id={`${uid}-timezone`} className={field} value={schedule.timezone ?? 'UTC'} placeholder="America/Denver" onChange={(e) => setSchedule({ timezone: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor={`${uid}-run-input`}>Run input for scheduled runs (optional)</label>
            <textarea id={`${uid}-run-input`} rows={2} onKeyDown={indentOnTab} className={field} value={trigger.input ?? ''} placeholder="Text or JSON passed to the flow each time it runs" onChange={(e) => onChange({ ...trigger, input: e.target.value || undefined })} />
          </div>
          <p className="text-xs text-muted-foreground">
            {nextRunLabel ? `Next run: ${nextRunLabel}` : 'Next run: on this flow’s saved custom schedule'}
          </p>
          <p className="text-xs text-muted-foreground">Scheduled runs execute the <strong>published</strong> version — publish the flow to arm the schedule.</p>
        </div>
      )}

      {type === 'poll' && (
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor={`${uid}-poll-connection`}>Check this app</label>
            <select
              id={`${uid}-poll-connection`}
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
            <label className={label} htmlFor={`${uid}-poll-tool`}>For new items from</label>
            <select
              id={`${uid}-poll-tool`}
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
              <label className={label} htmlFor={`${uid}-dedupe-key`}>New-item id field</label>
              <input id={`${uid}-dedupe-key`} className={field} value={trigger.dedupeKey ?? ''} placeholder="id" onChange={(e) => onChange({ ...trigger, dedupeKey: e.target.value || undefined })} />
            </div>
            <div>
              <label className={label} htmlFor={`${uid}-items-path`}>List field (optional)</label>
              <input id={`${uid}-items-path`} className={field} value={trigger.itemsPath ?? ''} placeholder="data" onChange={(e) => onChange({ ...trigger, itemsPath: e.target.value || undefined })} />
            </div>
          </div>
          <div>
            <label className={label} htmlFor={`${uid}-emit`}>Start the flow</label>
            <select id={`${uid}-emit`} className={field} value={trigger.emit ?? 'perItem'} onChange={(e) => onChange({ ...trigger, emit: e.target.value as 'perItem' | 'batch' })}>
              <option value="perItem">Once per new item</option>
              <option value="batch">Once with all new items</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor={`${uid}-poll-cadence`}>Check every</label>
            {/* A one-time check makes no sense for a poll, so 'once' is omitted. */}
            <select id={`${uid}-poll-cadence`} className={field} value={cadence === 'once' ? 'hourly' : cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {CADENCES.filter((f) => f.value !== 'once').map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
          {cadence === 'daysofweek' && (
            <div>
              <span id={`${uid}-check-on`} className={label}>Check on</span>
              <div role="group" aria-labelledby={`${uid}-check-on`} className="flex flex-wrap gap-1.5">
                {DAY_LABELS.map((dayLabel, day) => (
                  <DayToggle key={day} label={dayLabel} on={selectedDays.includes(day)} onToggle={() => toggleDay(day)} />
                ))}
              </div>
            </div>
          )}
          {['daily', 'daysofweek'].includes(cadence) && (
            <div>
              <label className={label} htmlFor={`${uid}-poll-time`}>Time (HH:MM)</label>
              <input id={`${uid}-poll-time`} className={field} value={scheduleTime} placeholder="09:00" onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">Polls the <strong>published</strong> version. The first check just learns what already exists; new items after that start the flow.</p>
        </div>
      )}

      {type === 'slack' && (
        <div className="space-y-3">
          {!slackConnected && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-300">
              Connect Slack in{' '}
              <a href="/credentials" className="font-medium underline underline-offset-2">
                workspace credentials
              </a>{' '}
              to arm this trigger.
            </p>
          )}
          <div>
            <label className={label} htmlFor={`${uid}-slack-channel`}>Channel (optional)</label>
            <input
              id={`${uid}-slack-channel`}
              className={field}
              value={trigger.channelId ?? ''}
              placeholder="#revenue or C0123456"
              onChange={(e) => onChange({ ...trigger, channelId: e.target.value || undefined })}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">Leave blank to fire for any channel in the connected workspace.</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={trigger.threadOnly === true}
              onChange={(e) => onChange({ ...trigger, threadOnly: e.target.checked || undefined })}
            />
            Only replies in threads
          </label>
          <p className="text-xs text-muted-foreground">Fires as soon as a matching message posts. Runs the <strong>published</strong> version.</p>
        </div>
      )}

      {type === 'activity' && (
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor={`${uid}-activity-source`}>Watch this app</label>
            <select
              id={`${uid}-activity-source`}
              className={field}
              value={trigger.source ?? ''}
              onChange={(e) => onChange({ ...trigger, source: e.target.value || undefined })}
            >
              <option value="">Select a connected app…</option>
              {connectedSources.map((source) => (
                <option key={source.value} value={source.value}>{source.label}</option>
              ))}
            </select>
            {connectedSources.length === 0 && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Connect an app in{' '}
                <a href="/credentials" className="font-medium underline underline-offset-2">workspace credentials</a>{' '}
                before picking a source.
              </p>
            )}
          </div>
          <div>
            <span className={label}>Event types</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Event types">
              {ACTIVITY_KINDS_CLIENT.map((kind) => {
                const on = selectedKinds.has(kind)
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleKind(kind)}
                    className={
                      on
                        ? 'rounded-full border border-indigo-500 bg-indigo-500 px-3 py-1 text-xs font-medium text-white transition-colors'
                        : 'rounded-full border border-border bg-transparent px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground'
                    }
                  >
                    {ACTIVITY_KIND_LABELS[kind]}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={label} htmlFor={`${uid}-activity-channel`}>Channel filter (optional)</label>
              <input
                id={`${uid}-activity-channel`}
                className={field}
                value={activityFilters.channelId ?? ''}
                placeholder="#revenue"
                onChange={(e) => setActivityFilters({ channelId: e.target.value || undefined })}
              />
            </div>
            <div>
              <label className={label} htmlFor={`${uid}-activity-actor`}>Actor filter (optional)</label>
              <input
                id={`${uid}-activity-actor`}
                className={field}
                value={activityFilters.actorExternalId ?? ''}
                placeholder="Who triggered it"
                onChange={(e) => setActivityFilters({ actorExternalId: e.target.value || undefined })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Fires as soon as the app reports a matching event. Runs the <strong>published</strong> version.</p>
        </div>
      )}

      {type === 'signal' && (
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor={`${uid}-signal`}>Signal name</label>
            <input
              id={`${uid}-signal`}
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
          {!webhook && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link2 className="h-3.5 w-3.5" /> {flowId ? 'Preparing the webhook URL…' : 'Save the flow to get its webhook URL.'}
            </p>
          )}
          {webhook && (
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
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
                      onClick={() => mintWebhook(true)}
                      disabled={minting}
                      title="Rotate the secret (invalidates the old one)"
                    >
                      <RefreshCw className={`h-3 w-3 ${minting ? 'animate-spin' : ''}`} /> Rotate
                    </button>
                    <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(webhookHeader, 'Auth header')}>
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                </div>
                <p className="break-all rounded bg-background px-2 py-1.5 font-mono text-[11px] text-amber-700 dark:text-amber-400">{webhookHeader}</p>
                {!webhook.secret && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {webhook.hasSecret
                      ? 'A secret already exists. Rotate to mint and display a new one.'
                      : 'Creating the webhook secret…'}
                  </p>
                )}
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
                <label className={label} htmlFor={`${uid}-match`}>Match</label>
                <select
                  id={`${uid}-match`}
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
