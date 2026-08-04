'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  HelpCircle,
  History,
  Lightbulb,
  Link as LinkIcon,
  ListOrdered,
  Loader2,
  MessageSquareQuote,
  Network,
  Play,
  Send,
  Sparkles,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/ui/markdown'
import { TypewriterStatus } from '@/components/ui/typewriter-status'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { humanizeToolName } from '@/lib/flows/humanize-tool-name'
import { cn } from '@/lib/utils'
import { isCancellableRunStatus, isTerminalRunStatus } from '@/lib/agents/run-status'
import {
  buildProcessTimeline,
  type ContextFact,
  type ProcessToolStep,
  type SuggestionItem,
} from '@/lib/agents/process-feed'
import type { Activity, Agent } from '@/lib/types'

/**
 * Activity log for the selected agent: runs grouped by status, each row
 * expandable in place to its conversation, output, tool calls and errors.
 * Reuses the existing execution-detail endpoint and follow-up reply plumbing.
 */

export type RunStep = ProcessToolStep

type RunDetails = {
  execution: Activity
  steps: RunStep[]
  events: Array<{ id: string; kind: string; payload?: any; ts: string }>
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>
}

export const groupOrder = ['running', 'cancelling', 'waiting_for_input', 'waiting_for_approval', 'failed', 'cancelled', 'completed'] as const
type ActivityGroup = (typeof groupOrder)[number]

// Keep the initial HQ view inside the available pane height. Counts remain
// visible in each group header and older runs can be revealed deliberately.
const INITIAL_RUNS_PER_GROUP = 1

export const groupLabels: Record<string, string> = {
  running: 'Running',
  cancelling: 'Cancelling',
  waiting_for_input: 'Needs input',
  waiting_for_approval: 'Needs approval',
  failed: 'Error',
  cancelled: 'Cancelled',
  completed: 'Success',
}

function activityStatus(activity: Activity) {
  return activity.status.toLowerCase()
}

/** Per-run outcome icon: green check for success, red X for a failed run, and
 *  distinct marks for in-progress / needs-input, so every row reads at a glance. */
function runStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-label="Success" />
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-label="Failed" />
    case 'running':
    case 'pending':
      return <CircleDashed className="h-4 w-4 shrink-0 animate-spin text-blue-600" aria-label="Running" />
    case 'cancelling':
      return <CircleDashed className="h-4 w-4 shrink-0 animate-spin text-gray-400" aria-label="Cancelling" />
    case 'waiting_for_input':
    case 'waiting_for_approval':
      return <HelpCircle className="h-4 w-4 shrink-0 text-amber-500" aria-label="Needs input" />
    case 'cancelled':
      return <XCircle className="h-4 w-4 shrink-0 text-gray-400" aria-label="Cancelled" />
    default:
      return <AlertCircle className="h-4 w-4 shrink-0 text-gray-400" aria-label={status} />
  }
}

export function resultText(activity?: Activity | null) {
  if (!activity) return ''
  if (activity.error) return activity.error
  const value = activity.output?.summary ?? activity.output?.response ?? activity.output
  // A still-running (or output-less) run has no result yet — return '' so
  // callers show a status label instead of the string "null".
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function stepDuration(step: RunStep): string | null {
  if (!step.startedAt || !step.completedAt) return null
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function asJson(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

// A step node is `provider.tool` (e.g. "granola.list_notes", "jira.discover_…",
// "nango:slack.send_message"). Derive the provider's brand logo so the process
// log shows real company marks instead of a generic wrench. Returns null for
// non-provider steps (e.g. "ask_user") so those keep the wrench.
const PROVIDER_NAMES: Record<string, string> = {
  slack: 'Slack', gmail: 'Gmail', salesforce: 'Salesforce', granola: 'Granola',
  email: 'Email', backstory: 'Backstory', jira: 'Jira', github: 'GitHub',
  notion: 'Notion', hubspot: 'HubSpot', clickup: 'ClickUp', linear: 'Linear',
  asana: 'Asana', confluence: 'Confluence', trello: 'Trello',
  snowflake: 'Snowflake', google_drive: 'Google Drive', google_sheets: 'Google Sheets',
  googledrive: 'Google Drive', googlesheets: 'Google Sheets', zendesk: 'Zendesk',
  monday: 'Monday', airtable: 'Airtable',
}
// Where the logo slug differs from the provider key (Simple Icons has no
// "email"/"people.ai" mark; use Resend / fall through to an initial tile).
const PROVIDER_LOGO_SLUGS: Record<string, string> = {
  email: 'resend',
  google_drive: 'googledrive',
  google_sheets: 'googlesheets',
  monday: 'mondaydotcom',
}

type ProviderLogo = { slug: string; name: string }

function stepProvider(step: Pick<RunStep, 'node' | 'input' | 'output'>): ProviderLogo | null {
  const node = step.node
  if (!node.includes('.')) return null // ask_user and other non-tool steps
  let provider = node.split('.')[0]
  if (provider.startsWith('nango:')) provider = provider.slice('nango:'.length) // nango:slack → slack
  if (!provider) return null
  // Custom MCP connections carry their slugified connection name as the
  // provider (e.g. "Backstory MCP" → backstory_mcp), so an exact-key lookup
  // misses them — fall back to a known provider key contained in the slug so
  // those steps still get the right brand mark instead of an initial tile.
  const knownKey =
    provider in PROVIDER_NAMES
      ? provider
      : Object.keys(PROVIDER_NAMES).find((key) => provider.includes(key))
  if (knownKey) {
    return { slug: PROVIDER_LOGO_SLUGS[knownKey] ?? knownKey, name: PROVIDER_NAMES[knownKey] }
  }
  const prettyName = provider
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  return { slug: PROVIDER_LOGO_SLUGS[provider] ?? provider, name: prettyName }
}

/**
 * The chip's headline: the action in plain English. Drops the internal plane
 * prefix ("nango:") — that's plumbing, not something a user asked for — and the
 * provider word the tool name repeats, so `nango:gmail.gmail_send_email` reads
 * as "Send email" beside the Gmail mark instead of spelling Gmail three times.
 */
function stepLabel(node: string): string {
  const cleaned = node.replace(/^nango:/, '')
  const dot = cleaned.indexOf('.')
  if (dot === -1) return humanizeToolName(cleaned) || cleaned
  // Multi-dot tool paths (google.calendar.create_event) read as words too.
  const action = humanizeToolName(cleaned.slice(dot + 1).replace(/\./g, ' '), cleaned.slice(0, dot))
  return action || cleaned
}

// One tool call: header always visible; inputs/outputs expand on click so a
// successful call's data is inspectable, not hidden behind a bare status badge.
// A call still in flight shows a live spinner ("Calling…") rather than a badge.
function ToolCallCard({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false)
  const provider = stepProvider(step)
  const duration = stepDuration(step)
  const failed = step.status === 'failed'
  const running = step.status === 'running'
  const waiting = step.status === 'waiting'
  const input = asJson(step.input)
  const output = asJson(step.error ?? step.output)
  const hasDetail = Boolean(input || output)
  return (
    <div className={cn('rounded-lg border bg-white text-sm', running && 'border-blue-200')}>
      <button
        type="button"
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="flex min-w-0 items-center gap-2">
          {provider ? (
            <IntegrationLogo slug={provider.slug} name={provider.name} className="h-4 w-4 shrink-0 rounded-sm" />
          ) : (
            <Wrench className={cn('h-3.5 w-3.5 shrink-0', running ? 'text-blue-500' : 'text-gray-400')} />
          )}
          {/* Raw node id stays on the title for debugging, off the surface. */}
          <span className="truncate text-xs font-medium" title={step.node}>{stepLabel(step.node)}</span>
          {provider && <span className="shrink-0 text-xs text-gray-400">{provider.name}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {duration && <span className="text-xs text-gray-500">{duration}</span>}
          {running ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-blue-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Calling…
            </span>
          ) : waiting ? (
            <Badge variant="warn">waiting</Badge>
          ) : failed ? (
            <Badge variant="risk">{step.status}</Badge>
          ) : (
            <Badge variant="outline">{step.status}</Badge>
          )}
          {hasDetail && <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200', open && 'rotate-180')} />}
        </span>
      </button>
      {open && hasDetail && (
        <div className="space-y-2 border-t px-3 py-2">
          {input && (
            <div>
              <p className="mono-label mb-1">Input</p>
              <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-xs">{input}</pre>
            </div>
          )}
          {output && (
            <div>
              <p className="mono-label mb-1">{failed ? 'Error' : 'Output'}</p>
              <pre className={cn('overflow-x-auto rounded p-2 text-xs', failed ? 'bg-red-50 text-red-700' : 'bg-gray-50')}>{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The agent's narration for one turn, shown as a reasoning step in the timeline.
function ThinkingCard({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-white/60 px-3 py-2">
      <p className="mono-label mb-1 flex items-center gap-1.5 text-gray-400">
        <Sparkles className="h-3 w-3" /> Thinking
      </p>
      <div className="text-sm text-gray-600"><Markdown>{text}</Markdown></div>
    </div>
  )
}

// Correlated-context facts are assembled server-side and often embed a raw
// JSON blob (e.g. `Output: {"summary":"…"}` or `Sales AI status: {"error":"…"}`)
// that renders as escaped JSON noise. Replace each flat {...} blob with its most
// meaningful string field so the fact reads as prose. Applied at display time so
// it cleans up facts indexed before the server-side formatting fix too.
function humanizeFact(text: string): string {
  return text.replace(/\{[^{}]*\}/g, (blob) => {
    try {
      const obj = JSON.parse(blob) as Record<string, unknown>
      if (obj && typeof obj === 'object') {
        for (const key of ['summary', 'response', 'error', 'message', 'text']) {
          const value = obj[key]
          if (typeof value === 'string' && value.trim()) return value.trim()
        }
        const strings = Object.values(obj).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        if (strings.length) return strings.join(' — ')
      }
    } catch {
      // Not valid JSON — leave the original text untouched.
    }
    return blob
  })
}

// Fact types sourced from Backstory Sales AI (vs. internal run/agent nodes), so
// they render with the Backstory brand mark to show where the data came from.
const SALES_AI_FACT_TYPES = new Set(['opportunity', 'account', 'signal'])

// Renders the graph-RAG context the agent pulled in before acting — the visible
// "brain" step: which Sales AI signals, prior runs, and related entities it
// correlated. Collapsed to the summary by default; expandable to the facts.
function ContextCard({ summary, hits, related }: { summary: string; hits: ContextFact[]; related: ContextFact[] }) {
  const [open, setOpen] = useState(false)
  const total = hits.length + related.length
  return (
    <div className="rounded-lg border border-dashed border-horizon-200 bg-horizon-50/40 px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
        disabled={total === 0}
      >
        <Network className="h-3 w-3 shrink-0 text-horizon-600" />
        <span className="mono-label text-horizon-700">Correlated context</span>
        {total > 0 && <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      <p className="mt-1 text-sm text-gray-600">{summary}</p>
      {open && total > 0 && (
        <ul className="mt-2 space-y-1 border-t pt-2">
          {[...hits, ...related].map((fact, i) => (
            <li key={i} className="flex items-start gap-1.5 whitespace-pre-wrap text-xs text-gray-600">
              {SALES_AI_FACT_TYPES.has((fact.type || '').toLowerCase()) && (
                <IntegrationLogo slug="backstory" name="Backstory" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span>
                <span className="mono-label mr-1.5 text-gray-400">{fact.type}</span>
                {humanizeFact(fact.text)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// The agent's plan for the run, announced up front so the timeline reads as
// "here's what I'm going to do" before the tool calls that carry it out.
function PlanCard({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-white/60 px-3 py-2">
      <p className="mono-label mb-1 flex items-center gap-1.5 text-gray-400">
        <ListOrdered className="h-3 w-3" /> Plan
      </p>
      <p className="whitespace-pre-wrap text-sm text-gray-600">{text}</p>
    </div>
  )
}

// A memory the agent pulled in from a prior run — kept to a single collapsed
// summary line, matching the context card's default (unexpanded) density.
function MemoryCard({ summary }: { summary: string }) {
  return (
    <div className="rounded-lg border border-dashed border-horizon-200 bg-horizon-50/40 px-3 py-2">
      <p className="mono-label mb-1 flex items-center gap-1.5 text-horizon-700">
        <Brain className="h-3 w-3" /> Memory
      </p>
      <p className="text-sm text-gray-600">{summary}</p>
    </div>
  )
}

// A question the agent would normally have asked the user, answered instead
// from a remembered prior answer — surfaced so the automation stays visible.
function AutoAnswerCard({ question, answer }: { question: string; answer: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-white/60 px-3 py-2">
      <p className="mono-label mb-1 flex items-center gap-1.5 text-gray-400">
        <MessageSquareQuote className="h-3 w-3" /> Answered from memory
      </p>
      <p className="text-sm text-gray-500">{question}</p>
      <p className="text-sm font-semibold text-gray-800">{answer}</p>
    </div>
  )
}

// Suggestions the agent surfaced from this run (e.g. "remember this" or
// "connect this integration"), rendered after the timeline with a per-row
// dismiss so the user can act on or clear each one without leaving the pane.
function SuggestionsCard({
  suggestions,
  agentId,
  onChanged,
}: {
  suggestions: SuggestionItem[]
  agentId: string
  onChanged: () => void
}) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const visible = suggestions.filter((suggestion) => !dismissedIds.has(suggestion.memoryId))
  if (!visible.length) return null

  const dismiss = async (memoryId: string) => {
    setDismissedIds((current) => new Set(current).add(memoryId))
    try {
      const res = await fetch(`/api/agents/${agentId}/memories`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: memoryId, status: 'dismissed' }),
      })
      if (!res.ok) {
        setDismissedIds((current) => {
          const next = new Set(current)
          next.delete(memoryId)
          return next
        })
        toast.error('Could not dismiss the suggestion.')
        return
      }
    } catch {
      setDismissedIds((current) => {
        const next = new Set(current)
        next.delete(memoryId)
        return next
      })
      toast.error('Could not dismiss the suggestion.')
      return
    }
    onChanged()
  }

  return (
    <div className="rounded-lg border border-dashed border-amber-200 bg-amber-50/40 px-3 py-3">
      <h4 className="mono-label mb-2 flex items-center gap-1.5 text-amber-700">
        <Lightbulb className="h-3.5 w-3.5" /> Suggestions
      </h4>
      <ul className="space-y-2">
        {visible.map((suggestion) => (
          <li key={suggestion.memoryId} className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-800">{suggestion.title}</p>
              <p className="text-xs text-gray-500">{suggestion.rationale}</p>
              {suggestion.actionType === 'connect' && (
                <Link href="/integrations?tab=servers" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  <LinkIcon className="h-3 w-3" /> Open integrations
                </Link>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss suggestion"
              onClick={() => dismiss(suggestion.memoryId)}
              className="shrink-0 rounded p-1 text-gray-400 transition-colors duration-150 hover:bg-amber-100 hover:text-gray-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// The event→timeline shaping lives in @/lib/agents/process-feed (shared with
// the flow runs panel's compact live feed) — this pane renders it as cards.

function RunRow({
  activity,
  agentId,
  expanded,
  onToggle,
  onChanged,
  onSuggestionsChanged,
}: {
  activity: Activity
  agentId: string
  expanded: boolean
  onToggle: () => void
  onChanged: () => void
  /** Fired after a suggestion is dismissed so the pane's badge count can refresh. */
  onSuggestionsChanged: () => void
}) {
  const [details, setDetails] = useState<RunDetails | null>(null)
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const status = activityStatus(activity)
  const isActive = ['running', 'pending', 'cancelling', 'waiting_for_input', 'waiting_for_approval'].includes(status)
  const isCancellable = isCancellableRunStatus(status)
  const isTerminal = isTerminalRunStatus(status)
  const { items: timeline, suggestions } = buildProcessTimeline(details?.events ?? [], details?.steps ?? [])
  // The most recent question this run asked that carries a remembered prior
  // answer, so the reply box can offer a one-click prefill instead of making
  // the user retype an answer the agent already has on file.
  const suggested = [...(details?.events ?? [])]
    .reverse()
    .find((event) => event.kind === 'agent.question' && event.payload?.suggestedAnswer)
    ?.payload?.suggestedAnswer as { content: string } | undefined

  useEffect(() => {
    if (!expanded) {
      setDetails(null)
      return
    }
    let cancelled = false
    const fetchDetails = () =>
      fetch(`/api/workflows/executions?executionId=${activity.id}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((data) => { if (!cancelled) setDetails(data.items?.[0] || null) })
        .catch(() => { if (!cancelled) setDetails(null) })
    fetchDetails()
    // While a run is active, poll its detail so thinking and tool calls stream in
    // (near-real-time) without a full-page refetch. Visibility-gated: an expanded
    // pane on a backgrounded tab polls nothing and catches up on return.
    const stopPolling = isActive ? startVisibleInterval(fetchDetails, 2000) : undefined
    return () => { cancelled = true; stopPolling?.() }
  }, [expanded, activity.id, status, isActive])

  const sendReply = async () => {
    if (!reply.trim() || replying) return
    setReplying(true)
    try {
      await fetch(`/api/executions/${activity.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: reply }),
      })
      setReply('')
      onChanged()
    } finally {
      setReplying(false)
    }
  }

  const cancelRun = async () => {
    if (actionBusy || !window.confirm('Cancel this run?')) return
    setActionBusy(true)
    try {
      const response = await fetch(`/api/agents/${agentId}/runs/${activity.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) {
        toast.error(data.error || 'Could not cancel the run.')
        return
      }
      toast.success('Run cancelled.')
      onChanged()
    } catch {
      toast.error('Could not cancel the run.')
    } finally {
      setActionBusy(false)
    }
  }

  const deleteRun = async () => {
    if (actionBusy || !window.confirm('Delete this run from history? This cannot be undone.')) return
    setActionBusy(true)
    try {
      const response = await fetch(`/api/agents/${agentId}/runs/${activity.id}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) {
        toast.error(data.error || 'Could not delete the run.')
        return
      }
      toast.success('Run deleted.')
      onChanged()
    } catch {
      toast.error('Could not delete the run.')
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <div className="border-b">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle()
          }
        }}
        className={cn(
          'grid w-full cursor-pointer grid-cols-[auto_auto_1fr_auto_auto] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-gray-50',
          expanded && 'bg-gray-50',
        )}
      >
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200', expanded && 'rotate-180')} />
        {runStatusIcon(status)}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{activity.metadata?.title || activity.agentType}</div>
          <div className="line-clamp-1 text-xs text-gray-500">
            {(() => {
              const summary =
                activity.metadata?.pendingQuestion?.question || activity.metadata?.headline || activity.error || resultText(activity)
              if (summary) return summary
              if (status === 'waiting_for_input') return 'Waiting for you…'
              if (status === 'cancelling') return 'Cancelling…'
              if (isActive) return <TypewriterStatus seed={activity.id ? activity.id.charCodeAt(activity.id.length - 1) : 0} />
              return 'No output'
            })()}
          </div>
        </div>
        <time className="shrink-0 font-mono text-xs tabular-nums text-gray-400">{new Date(activity.startedAt).toLocaleString()}</time>
        <span className="flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
          {isCancellable && (
            <button
              type="button"
              title="Cancel this run"
              disabled={actionBusy}
              onClick={cancelRun}
              className="shrink-0 rounded p-1 text-gray-400 transition-colors duration-150 hover:bg-red-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XCircle className="h-4 w-4" />
            </button>
          )}
          {isTerminal && (
            <button
              type="button"
              title="Delete this run"
              disabled={actionBusy}
              onClick={deleteRun}
              className="shrink-0 rounded p-1 text-gray-400 transition-colors duration-150 hover:bg-red-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>

      {expanded && (
        <div className="space-y-4 border-t bg-gray-50/60 px-4 py-4">
          {activity.error && (
            <pre className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{activity.error}</pre>
          )}

          {status === 'waiting_for_input' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-900"><HelpCircle className="h-4 w-4" /> Agent needs your input</h4>
              <p className="mb-3 whitespace-pre-wrap text-sm text-amber-900">{activity.metadata?.pendingQuestion?.question || 'The agent asked a question.'}</p>
              <div className="flex gap-2">
                <Input
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && sendReply()}
                  placeholder="Reply to the agent..."
                />
                <Button size="icon" disabled={replying || !reply.trim()} onClick={sendReply}>
                  {replying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
              {suggested && !reply && (
                <button type="button" onClick={() => setReply(suggested.content)} className="mt-2 flex items-center gap-1.5 text-xs font-medium text-indigo-700 hover:text-indigo-900">
                  <History className="h-3.5 w-3.5" /> Use previous answer: <span className="italic">“{suggested.content.slice(0, 80)}”</span>
                </button>
              )}
            </div>
          )}

          {/* Process timeline: the agent's reasoning interleaved with its tool
              calls, streaming in while the run is active. Conversation with the
              agent lives in the assistant pane on the right, not here. */}
          <div>
            <h4 className="eyebrow mb-2 flex items-center gap-2">
              <Wrench className="h-4 w-4" /> Process
              {timeline.length ? <span className="text-gray-400">· {timeline.length}</span> : null}
            </h4>
            <div className="space-y-2">
              {timeline.map((item) => (
                <div key={item.key} className="animate-fade-in">
                  {item.kind === 'thinking'
                    ? <ThinkingCard text={item.text} />
                    : item.kind === 'context'
                      ? <ContextCard summary={item.summary} hits={item.hits} related={item.related} />
                      : item.kind === 'plan'
                        ? <PlanCard text={item.text} />
                        : item.kind === 'memory'
                          ? <MemoryCard summary={item.summary} />
                          : item.kind === 'autoanswer'
                            ? <AutoAnswerCard question={item.question} answer={item.answer} />
                            : <ToolCallCard step={item.step} />}
                </div>
              ))}
              {isActive && (
                <p className="flex items-center gap-2 px-1 text-sm text-blue-600">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Agent is working…
                </p>
              )}
              {!details && <p className="text-sm text-gray-500"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading run detail…</p>}
              {details && !timeline.length && !isActive && <p className="text-sm text-gray-500">No steps recorded for this run.</p>}
            </div>
          </div>

          {suggestions.length > 0 && (
            <SuggestionsCard suggestions={suggestions} agentId={agentId} onChanged={onSuggestionsChanged} />
          )}

          {/* The run's OUTPUT is shown in the assistant pane on the right (that
              surface holds agent output + the conversation); the left pane is
              logs + status only. */}
        </div>
      )}
    </div>
  )
}

export function AgentActivityPane({
  agent,
  activities,
  focusRunId,
  onChanged,
  onSelectRun,
}: {
  agent: Agent
  activities: Activity[]
  /** Deep-linked run to auto-expand (e.g. ?run= or a fresh manual run). */
  focusRunId?: string | null
  onChanged: () => void
  /** Fires with the expanded run (or null) so the right pane can show its output. */
  onSelectRun?: (activity: Activity | null) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [suggestionCount, setSuggestionCount] = useState(0)
  const [expandedGroups, setExpandedGroups] = useState<Set<ActivityGroup>>(() => new Set())

  // A notification/deep link selects the run for the fixed output pane without
  // expanding its potentially long process log after hydration. Expanding the
  // inline log remains an explicit click on the row.
  useEffect(() => {
    setExpandedId(null)
    setSelectedId(focusRunId ?? null)
    setExpandedGroups(new Set())
  }, [focusRunId, agent.id])

  // Surface the selected run (kept fresh as activities poll) to the parent so
  // the assistant pane can render its output independently of inline expansion.
  useEffect(() => {
    onSelectRun?.(activities.find((activity) => activity.id === selectedId) ?? null)
  }, [selectedId, activities, onSelectRun])

  // Open-suggestion count for the lightbulb badge: refetched whenever the
  // selected agent changes, and again after a suggestion is dismissed below.
  const refreshSuggestionCount = () => {
    fetch(`/api/agents/${agent.id}/memories?kind=suggestion&status=open`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setSuggestionCount(typeof data.openSuggestions === 'number' ? data.openSuggestions : 0))
      .catch(() => setSuggestionCount(0))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refreshSuggestionCount() }, [agent.id])

  const header = (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <span className="truncate text-sm font-semibold">{agent.title}</span>
      {suggestionCount > 0 && (
        <span
          title="Open suggestions from this agent's runs"
          className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
        >
          <Lightbulb className="h-3 w-3" /> {suggestionCount}
        </span>
      )}
    </div>
  )

  if (!activities.length) {
    return (
      <div>
        {header}
        <div className="p-4">
          <EmptyState
            icon={Play}
            title="No runs yet"
            description="Create agent and logs will show here"
          />
        </div>
      </div>
    )
  }

  return (
    <div>
      {header}
      {groupOrder.map((groupStatus) => {
        const items = activities.filter((activity) => activityStatus(activity) === groupStatus)
        if (!items.length) return null
        const groupExpanded = expandedGroups.has(groupStatus)
        const visibleItems = groupExpanded ? items : items.slice(0, INITIAL_RUNS_PER_GROUP)
        const hiddenCount = items.length - visibleItems.length
        return (
          <div key={groupStatus}>
            <div className="flex items-center gap-2 border-b bg-gray-50 px-4 py-2 text-sm font-medium">
              {groupStatus === 'completed' ? <CheckCircle2 className="h-4 w-4 text-green-600" /> :
                groupStatus === 'running' ? <CircleDashed className="h-4 w-4 animate-spin text-blue-600" /> :
                groupStatus === 'cancelling' ? <CircleDashed className="h-4 w-4 animate-spin text-gray-400" /> :
                groupStatus === 'waiting_for_input' || groupStatus === 'waiting_for_approval' ? <HelpCircle className="h-4 w-4 text-amber-500" /> :
                groupStatus === 'cancelled' ? <XCircle className="h-4 w-4 text-gray-400" /> :
                <AlertCircle className="h-4 w-4 text-red-600" />}
              {groupLabels[groupStatus]} <span className="font-mono text-xs tabular-nums text-gray-400">{items.length}</span>
            </div>
            {visibleItems.map((activity) => (
              <RunRow
                key={activity.id}
                activity={activity}
                agentId={agent.id}
                expanded={expandedId === activity.id}
                onToggle={() => {
                  const closing = expandedId === activity.id
                  setExpandedId(closing ? null : activity.id)
                  setSelectedId(closing ? null : activity.id)
                }}
                onChanged={onChanged}
                onSuggestionsChanged={refreshSuggestionCount}
              />
            ))}
            {(hiddenCount > 0 || groupExpanded) && items.length > INITIAL_RUNS_PER_GROUP && (
              <button
                type="button"
                className="flex w-full items-center justify-center gap-1.5 border-b bg-white px-4 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-800"
                onClick={() => setExpandedGroups((current) => {
                  const next = new Set(current)
                  if (groupExpanded) next.delete(groupStatus)
                  else next.add(groupStatus)
                  return next
                })}
              >
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', groupExpanded && 'rotate-180')} />
                {groupExpanded ? 'Show recent only' : `Show ${hiddenCount} older`}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
