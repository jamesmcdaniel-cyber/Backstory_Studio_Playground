'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, Globe2, Loader2, Play, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { MiniCalendar } from '@/components/ui/mini-calendar'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import {
  HttpCredentialDialog,
  HTTP_AUTH_OPTIONS,
  type HttpCredentialSummary,
} from '@/components/flows/http-credential-dialog'
import { KnowledgePanel } from '@/app/agents/knowledge-panel'
import { AgentHttpEndpointDialog } from '@/components/agents/http-endpoint-dialog'
import { QuickConfigChip } from '@/components/agents/tool-quick-config-popover'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { mcpToolQuickConfig, parseAgentToolSettings, quickConfigForChip, type ToolQuickConfig, type ToolScopeOption } from '@/lib/connectors/tool-quick-config'
import { endpointParams, endpointToolName, type AgentHttpEndpoint } from '@/lib/integrations/http-endpoints'
import { cn } from '@/lib/utils'
import { DAY_LABELS, cadenceOf, cronToTime, daysFromCron, dowCron } from '@/lib/scheduling/cadence'

/**
 * The agent configuration form, shared by the config dialog and the dashboard's
 * inline setup pane. Owns the draft state, integration/skill pickers, schedule
 * controls and the recent-runs list for an existing agent.
 */

type SkillSummary = {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations: string[]
}

type ToolChip = {
  key: string
  label: string
  slug: string
  connected: boolean
}

type ConnectionIntegration = {
  id: string
  name: string
}

type AvailableIntegrations = {
  tools: ToolChip[]
  connections: ConnectionIntegration[]
}

type AgentMemory = {
  id: string
  kind: string
  title: string
  content: string
  question: string | null
  status: string
  timesUsed: number
  lastUsedAt: string | null
  sourceExecutionId: string | null
  createdAt: string
}

const MEMORY_KIND_LABEL: Record<string, string> = {
  user_answer: 'Answer',
  learning: 'Learning',
  suggestion: 'Suggestion',
}

/**
 * API credentials for the HTTP API tool, using the same verify-and-save dialog
 * the flow HTTP node uses.
 *
 * Before this, an agent calling an authenticated API had nowhere to put the key
 * — the tool's own description told the model to read credentials out of the
 * agent's instructions, which meant pasting secrets into plain-text prompt
 * copy. Credentials saved here are encrypted, host-locked, verified once, and
 * attached by the runtime automatically when the agent calls that host.
 */
/**
 * The agent's configured API endpoints — each one a named tool the agent can
 * call, configured through the same options as the flow HTTP step.
 */
function HttpEndpointsSection({
  endpoints,
  onChange,
  connections,
}: {
  endpoints: AgentHttpEndpoint[]
  onChange: (endpoints: AgentHttpEndpoint[]) => void
  connections: { id: string; name: string }[]
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AgentHttpEndpoint | null>(null)

  return (
    <div className="mt-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label>API endpoints</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Requests this agent can make, each exposed as a tool it calls by name — method, URL, query, headers, body
            and auth, exactly like a flow&apos;s HTTP step.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {endpoints.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No endpoints yet. Add one to let this agent call a specific API on demand.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {endpoints.map((endpoint) => {
            const params = endpointParams(endpoint)
            return (
              <li key={endpoint.id} className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
                <Globe2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setEditing(endpoint)
                    setDialogOpen(true)
                  }}
                >
                  <p className="truncate text-xs font-medium">
                    {endpoint.name}
                    <span className="ml-1.5 font-normal text-muted-foreground">({endpointToolName(endpoint)})</span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {endpoint.method} {endpoint.url}
                    {params.length ? ` · inputs: ${params.join(', ')}` : ''}
                  </p>
                </button>
                {(endpoint.credentialId || endpoint.connectionId) && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">Authenticated</Badge>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${endpoint.name}`}
                  onClick={() => onChange(endpoints.filter((entry) => entry.id !== endpoint.id))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <AgentHttpEndpointDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        endpoint={editing}
        connections={connections}
        onSave={(saved) => {
          const exists = endpoints.some((entry) => entry.id === saved.id)
          onChange(exists ? endpoints.map((entry) => (entry.id === saved.id ? saved : entry)) : [...endpoints, saved])
        }}
      />
    </div>
  )
}

function HttpCredentialsPanel({ active }: { active: boolean }) {
  const [credentials, setCredentials] = useState<HttpCredentialSummary[] | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch('/api/http-credentials?scope=bindable', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      // Listing needs only flow.read; on any failure show the section as
      // empty rather than erroring at the user.
      .then((data) => setCredentials(Array.isArray(data?.credentials) ? data.credentials : []))
      .catch(() => setCredentials([]))
  }, [])

  useEffect(() => {
    if (!active) return
    load()
  }, [active, load])

  const remove = async (credential: HttpCredentialSummary) => {
    setBusyId(credential.id)
    try {
      const response = await fetch(`/api/http-credentials?id=${encodeURIComponent(credential.id)}`, { method: 'DELETE' })
      if (!response.ok) {
        toast.error('Could not remove that credential.')
        return
      }
      setCredentials((current) => (current ?? []).filter((row) => row.id !== credential.id))
      toast.success(`Removed ${credential.name}.`)
    } finally {
      setBusyId(null)
    }
  }

  const reverify = async (credential: HttpCredentialSummary) => {
    setBusyId(credential.id)
    try {
      const response = await fetch('/api/http-credentials', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: credential.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'The API rejected that credential.')
        load()
        return
      }
      setCredentials((current) => (current ?? []).map((row) => (row.id === credential.id ? data.credential : row)))
      toast.success(`${credential.name} still works.`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mt-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label>API credentials</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Keys for the APIs this agent calls. Each one is encrypted, locked to a single host, and applied automatically
            when the agent calls that host — so keys never go in the instructions.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {credentials === null ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading credentials…</p>
      ) : credentials.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No API credentials yet. Add one to let this agent call an authenticated API.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {credentials.map((credential) => (
            <li key={credential.id} className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
              <Globe2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{credential.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {credential.allowedHost} · {HTTP_AUTH_OPTIONS.find((o) => o.value === credential.authType)?.label || credential.authType}
                </p>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  'shrink-0 text-[10px]',
                  credential.status === 'verified' ? 'border-green-200 text-green-700' : 'border-amber-200 text-amber-700',
                )}
                title={credential.lastError || undefined}
              >
                {credential.status === 'verified' ? 'Verified' : 'Needs attention'}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs"
                disabled={busyId === credential.id}
                onClick={() => reverify(credential)}
              >
                {busyId === credential.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Test'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${credential.name}`}
                disabled={busyId === credential.id}
                onClick={() => remove(credential)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <HttpCredentialDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        requestUrl=""
        requestMethod="GET"
        editableUrl
        onSaved={(credential) =>
          setCredentials((current) => [...(current ?? []).filter((row) => row.id !== credential.id), credential])
        }
      />
    </div>
  )
}

const MEMORY_KIND_VARIANT: Record<string, 'info' | 'good' | 'warn'> = {
  user_answer: 'info',
  learning: 'good',
  suggestion: 'warn',
}

/** One learned memory — shared by the config panel's two-row preview and the full-log dialog. */
function MemoryRow({ memory, onDelete }: { memory: AgentMemory; onDelete: (id: string) => void }) {
  return (
    <li className="group flex items-start gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2">
          <Badge variant={MEMORY_KIND_VARIANT[memory.kind] ?? 'secondary'}>
            {MEMORY_KIND_LABEL[memory.kind] ?? memory.kind}
          </Badge>
          <span className="truncate font-semibold text-gray-700" title={memory.title}>{memory.title}</span>
        </div>
        {memory.question && <p className="italic text-gray-500">{memory.question}</p>}
        <p className="line-clamp-2 text-gray-500">{memory.content}</p>
        {memory.lastUsedAt && (
          <p className="mt-0.5 text-xs text-gray-400">Last used {new Date(memory.lastUsedAt).toLocaleDateString()}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDelete(memory.id)}
        className="shrink-0 text-gray-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
        aria-label={`Remove memory ${memory.title}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  )
}

export type AgentDraft = {
  title: string
  description: string
  instructions: string
  model: string
  priority: string
  integrations: string[]
  /** Per-tool scopes (Slack channels, GitHub repos…) keyed by quick-config key. */
  toolSettings?: Record<string, ToolScopeOption[]>
  skills: string[]
  icon: string
  folder: string
  visibility: 'shared' | 'private'
  /** Lets this agent delegate to other agents via the run_agent tool. */
  allowSubagents?: boolean
  /** Restrict which agents it may run. Empty = any of the user's agents. */
  subagentIds?: string[]
  /** Lets this agent run published flows via the run_flow tool. */
  allowFlows?: boolean
  /** Restrict which flows it may run. Empty = any visible published flow. */
  flowIds?: string[]
  /** The outcome this agent ultimately serves — steers every run + self-evaluation. */
  goal: string
  /** When true, a question closely matching a past answer is auto-answered from memory. */
  autoAnswerFromMemory?: boolean
  /** When true, every run starts with an explicit numbered plan before any tool call. */
  alwaysStrategize?: boolean
  requireApproval?: boolean
  /** Configured API endpoints (HTTP API tool) — each becomes a named agent tool. */
  httpEndpoints?: AgentHttpEndpoint[]
  schedule: {
    type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron' | 'once'
    time?: string
    cron?: string
    timezone: string
    /** YYYY-MM-DD calendar date for a one-time ('once') run, paired with time. */
    runAt?: string
    isActive: boolean
  }
}

// ~10 common IANA timezones offered in the schedule picker.
const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
] as const

/** The browser's IANA timezone, falling back to UTC (e.g. during SSR). */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const emptyDraft: AgentDraft = {
  title: '',
  description: '',
  instructions: '',
  model: 'claude-sonnet-5',
  priority: 'medium',
  integrations: [],
  toolSettings: {},
  skills: [],
  icon: '🤖',
  folder: '',
  visibility: 'shared',
  allowSubagents: false,
  subagentIds: [],
  allowFlows: false,
  flowIds: [],
  goal: '',
  autoAnswerFromMemory: false,
  alwaysStrategize: false,
  requireApproval: false,
  httpEndpoints: [],
  schedule: { type: 'manual', time: '09:00', timezone: 'UTC', isActive: false },
}

// ── Model catalog ───────────────────────────────────────────────────────────
// id must satisfy the runtime's provider routing (model-runner.ts): a `claude*`
// id routes to Anthropic, anything else to the OpenAI-compatible slot (Qwen).
// Claude first (platform default / most capable); logos via IntegrationLogo.
const MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' as const },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' as const },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' as const },
  { id: 'qwen-3.7', label: 'Qwen 3.7', provider: 'qwen' as const },
]

function ModelOption({ provider, label }: { provider: 'anthropic' | 'qwen'; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <IntegrationLogo slug={provider} name={provider === 'anthropic' ? 'Claude' : 'Qwen'} className="h-4 w-4" />
      {label}
    </span>
  )
}

// ── Schedule cadence (visual UI concept mapped onto the backend schedule) ────
// Backend supports type manual|hourly|daily|weekly|cron|once (see due.ts). The
// UI offers only friendly visual cadences and never exposes raw cron — the
// classification/serialization helpers are shared with the flow trigger editor
// (src/lib/scheduling/cadence.ts). Agents deliberately offer hourly as the
// fastest cadence; a legacy sub-hourly cron displays as Hourly and converts on
// its next save.
type AgentCadence = 'hourly' | 'daily' | 'daysofweek' | 'once'

function agentCadenceOf(schedule: AgentDraft['schedule']): AgentCadence {
  const cadence = cadenceOf(schedule)
  return cadence === 'every15min' || cadence === 'every30min' ? 'hourly' : cadence
}

/** Today as YYYY-MM-DD in local time — the earliest selectable one-time date. */
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Legacy 'hourly' ≡ cron '0 * * * *'; represent it as cron so the Hourly
 *  preset round-trips losslessly (cadenceOf maps every-hour crons back). */
function normalizeSchedule(schedule: AgentDraft['schedule']): AgentDraft['schedule'] {
  if (schedule.type === 'hourly') return { ...schedule, type: 'cron', cron: schedule.cron || '0 * * * *' }
  return schedule
}

// Curated agent emojis — all ≤4 UTF-16 code units, so they fit the icon cap.
const AGENT_EMOJIS = [
  '🤖', '📊', '📈', '📉', '✉️', '📬', '🔔', '📅',
  '🗂️', '📝', '🔎', '🎯', '⚡', '🧠', '💬', '📣',
  '🛰️', '🧭', '🚀', '🛎️', '💼', '📌', '🧾', '🔗',
  '⏰', '🗓️', '✅', '⭐', '🔥', '💡', '🏷️', '🪄',
]

function EmojiPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-14 items-center justify-center rounded-md border border-input bg-background text-xl transition-colors hover:bg-accent"
        aria-label="Choose agent emoji"
      >
        {value || '🤖'}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover p-2 shadow-md">
          <div className="grid grid-cols-8 gap-0.5">
            {AGENT_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => { onChange(emoji); setOpen(false) }}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded text-lg hover:bg-accent',
                  value === emoji && 'bg-accent',
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function AgentConfigForm({
  editingAgent,
  template,
  onSave,
  onRunAgent,
  runningId,
  onOpenRun,
  active = true,
  saveLabel,
  onDirtyChange,
}: {
  editingAgent?: any
  template?: any
  onSave: (draft: AgentDraft) => Promise<void> | void
  onRunAgent?: (agent: any) => Promise<void> | void
  runningId?: string | null
  /** Where a recent-run row should navigate; defaults to the dashboard deep link. */
  onOpenRun?: (runId: string) => void
  /** Dialogs pass their `open` flag so effects re-run each time they reopen. */
  active?: boolean
  saveLabel?: string
  /** Reports unsaved draft state so the containing workspace can guard navigation. */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [publishingTemplate, setPublishingTemplate] = useState(false)
  // Snapshot of the draft as last populated/saved, so Run can tell whether
  // there are unsaved edits that must be persisted before executing.
  const baselineRef = useRef<string>(JSON.stringify(emptyDraft))
  const [skillNames, setSkillNames] = useState<Record<string, string>>({})
  const [availableIntegrations, setAvailableIntegrations] = useState<AvailableIntegrations | null>(null)
  // Stable per-connection quick-config objects: the popover refetches when its
  // config identity changes, so these must not be rebuilt on every keystroke.
  const mcpQuickConfigs = useMemo(() => {
    const configs = new Map<string, ToolQuickConfig>()
    for (const connection of availableIntegrations?.connections ?? []) {
      configs.set(connection.id, mcpToolQuickConfig(connection))
    }
    return configs
  }, [availableIntegrations])
  const [runs, setRuns] = useState<any[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [memoriesLoading, setMemoriesLoading] = useState(false)
  // Full memory log lives in a dialog — the panel shows only the two newest
  // entries, so a long-lived agent's memory can't crowd out the form.
  const [showMemoryLog, setShowMemoryLog] = useState(false)
  const [confirmClearMemory, setConfirmClearMemory] = useState(false)
  // Other agents in the workspace, offered as run_agent targets.
  const [orgAgents, setOrgAgents] = useState<{ id: string; title: string }[]>([])
  // Published flows for the "Call flows" picker (published = runnable by agents).
  const [orgFlows, setOrgFlows] = useState<{ id: string; name: string }[]>([])
  const [showMoreConfig, setShowMoreConfig] = useState(false)
  const [showCapabilities, setShowCapabilities] = useState(false)

  useEffect(() => {
    if (!active) return
    fetch('/api/agents', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setOrgAgents((data.agents as { id: string; title: string }[]).map((a) => ({ id: a.id, title: a.title })))
      })
      .catch(() => {})
    fetch('/api/flows', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        const flows = (data.flows ?? []) as { id: string; name: string; published?: boolean }[]
        setOrgFlows(flows.filter((f) => f.published).map((f) => ({ id: f.id, name: f.name })))
      })
      .catch(() => {})
  }, [active])

  // Load this agent's recent runs when editing.
  useEffect(() => {
    if (!active || !editingAgent?.id) { setRuns([]); return }
    setRunsLoading(true)
    fetch(`/api/workflows/executions?agentId=${editingAgent.id}&limit=8`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => setRuns(Array.isArray(data.items) ? data.items.map((item: any) => item.execution) : []))
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false))
  }, [active, editingAgent])

  // Load this agent's memory when editing. Skipped in create mode — there's no agent id yet.
  useEffect(() => {
    if (!active || !editingAgent?.id) { setMemories([]); return }
    setMemoriesLoading(true)
    fetch(`/api/agents/${editingAgent.id}/memories`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => setMemories(data.success ? data.memories : []))
      .catch(() => setMemories([]))
      .finally(() => setMemoriesLoading(false))
  }, [active, editingAgent])

  const deleteMemory = async (id: string) => {
    if (!editingAgent?.id) return
    setMemories((prev) => prev.filter((m) => m.id !== id))
    const response = await fetch(`/api/agents/${editingAgent.id}/memories`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) toast.error('Could not remove memory.')
  }

  const clearAllMemory = async () => {
    if (!editingAgent?.id) return
    const previous = memories
    setMemories([])
    const response = await fetch(`/api/agents/${editingAgent.id}/memories`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    if (!response.ok) {
      setMemories(previous)
      toast.error('Could not clear memory.')
    } else {
      setConfirmClearMemory(false)
      toast.success('Agent memory cleared.')
    }
  }

  // Load skill names for compact skills display
  useEffect(() => {
    fetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          const map: Record<string, string> = {}
          for (const s of data.skills as SkillSummary[]) {
            map[s.id] = s.name
          }
          setSkillNames(map)
        }
      })
      .catch(() => {})
  }, [])

  // Load available integrations when the form becomes active, and refetch when
  // the user returns to the tab — so a tool connected elsewhere (the
  // Integrations/MCP pages) shows up here promptly
  // instead of only after a full reload.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const loadAvailable = () => {
      fetch('/api/integrations/available', { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => {
          if (cancelled || !data.success) return
          setAvailableIntegrations({ tools: data.tools ?? [], connections: data.connections ?? [] })
        })
        .catch(() => {})
    }
    loadAvailable()
    const refetchOnReturn = () => { if (!document.hidden) loadAvailable() }
    window.addEventListener('focus', refetchOnReturn)
    document.addEventListener('visibilitychange', refetchOnReturn)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refetchOnReturn)
      document.removeEventListener('visibilitychange', refetchOnReturn)
    }
  }, [active])

  // Populate the draft ONLY when the edited agent/template identity changes (or
  // the form activates) — NOT on every editingAgent object-reference change. The
  // dashboard polls agents every 10s, so depending on the object here would
  // overwrite the user's in-progress edits (name/icon/instructions) each poll,
  // making edits appear to "not save". Keying on the id preserves the draft.
  useEffect(() => {
    const source = editingAgent || template
    const next = source ? {
      ...emptyDraft,
      ...source,
      instructions: source.instructions || source.objective || '',
      integrations: source.integrations || [],
      toolSettings: parseAgentToolSettings((source as { toolSettings?: unknown }).toolSettings),
      skills: source.skills || [],
      icon: source.icon || emptyDraft.icon,
      folder: source.folder || '',
      visibility: source.visibility || 'shared',
      allowSubagents: source.allowSubagents === true,
      subagentIds: Array.isArray(source.subagentIds) ? source.subagentIds : [],
      allowFlows: source.allowFlows === true,
      flowIds: Array.isArray(source.flowIds) ? source.flowIds : [],
      goal: source.goal || '',
      autoAnswerFromMemory: source.autoAnswerFromMemory === true,
      alwaysStrategize: source.alwaysStrategize === true,
      requireApproval: source.requireApproval === true,
      httpEndpoints: Array.isArray(source.httpEndpoints) ? source.httpEndpoints : [],
      schedule: normalizeSchedule({ ...emptyDraft.schedule, ...(source.schedule || {}) }),
    } : {
      ...emptyDraft,
      // When creating a fresh agent, default the schedule timezone to the
      // browser's resolved zone so daily/weekly times match the user's clock.
      schedule: { ...emptyDraft.schedule, timezone: browserTimezone() },
    }
    setDraft(next)
    baselineRef.current = JSON.stringify(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingAgent?.id, template?.id, active])

  // Matches the connector registry's HTTP descriptor (`has('http')`), so the
  // credentials panel appears for exactly the selections that load the tool.
  const httpAttached = draft.integrations.some((key) => key.toLowerCase().includes('http'))

  const toggleIntegration = (label: string) => {
    const next = draft.integrations.includes(label)
      ? draft.integrations.filter((i) => i !== label)
      : [...draft.integrations, label]
    setDraft({ ...draft, integrations: next })
  }

  const detachSkill = (skillId: string) => {
    setDraft({ ...draft, skills: draft.skills.filter((id) => id !== skillId) })
  }

  const dirty = JSON.stringify(draft) !== baselineRef.current
  const enabledCapabilityCount = [
    draft.allowSubagents,
    draft.allowFlows,
    draft.schedule.isActive,
    draft.autoAnswerFromMemory,
    draft.alwaysStrategize,
    draft.requireApproval,
  ].filter(Boolean).length

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!dirty) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [dirty])

  const submit = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      baselineRef.current = JSON.stringify(draft)
    } finally {
      setSaving(false)
    }
  }

  // Run always executes what's persisted — so unsaved edits MUST be saved
  // first, or the run silently uses the old instructions and edits appear
  // to "not catch". A failed save aborts the run (onSave throws on error).
  const runNow = async () => {
    if (!onRunAgent || !editingAgent) return
    if (dirty) {
      setSaving(true)
      try {
        await onSave(draft)
        baselineRef.current = JSON.stringify(draft)
      } finally {
        setSaving(false)
      }
    }
    await onRunAgent(editingAgent)
  }

  const openRun = (runId: string) => {
    if (onOpenRun) onOpenRun(runId)
    else router.push(`/agents?run=${runId}`)
  }

  const publishTemplate = async () => {
    if (!editingAgent) return
    const title = draft.title.trim()
    const instructions = draft.instructions.trim()
    if (!title || !instructions) {
      toast.error('Name and instructions are required before adding a template.')
      return
    }
    setPublishingTemplate(true)
    try {
      const tags = Array.from(new Set([
        'agent',
        ...(draft.folder.trim() ? [draft.folder.trim()] : []),
        ...draft.skills.map((skillId) => skillNames[skillId]).filter((name): name is string => Boolean(name)),
      ]))
      const response = await fetch('/api/agent-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: title,
          description: draft.description.trim() || title,
          category: 'Custom',
          instructions,
          integrations: draft.integrations,
          skills: draft.skills,
          tags,
          model: draft.model,
          icon: draft.icon,
          allowSubagents: draft.allowSubagents === true,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not add this agent to templates.')
      toast.success('Added to template catalogue.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add this agent to templates.')
    } finally {
      setPublishingTemplate(false)
    }
  }

  // ── Schedule (visual cadence UI ↔ backend schedule) ───────────────────────
  const cadence = agentCadenceOf(draft.schedule)
  // The time shown in the time picker: cron-backed cadences carry it in the cron
  // fields, the rest in `time`.
  const scheduleTime = (draft.schedule.type === 'cron')
    ? cronToTime(draft.schedule.cron || '')
    : (draft.schedule.time || '09:00')
  const selectedDays = cadence === 'daysofweek' ? daysFromCron(draft.schedule.cron) : []

  const setScheduleEnabled = (on: boolean) => {
    if (!on) {
      setDraft({ ...draft, schedule: { ...draft.schedule, type: 'manual', isActive: false } })
      return
    }
    // Turning it on from "manual" defaults to a daily cadence.
    const time = draft.schedule.time || '09:00'
    const timezone = draft.schedule.timezone || browserTimezone()
    const base = draft.schedule.type === 'manual'
      ? { type: 'daily' as const, time, timezone }
      : draft.schedule
    setDraft({ ...draft, schedule: { ...base, isActive: true } })
  }

  const setCadence = (next: AgentCadence) => {
    const time = scheduleTime
    const timezone = draft.schedule.timezone || browserTimezone()
    const schedule: AgentDraft['schedule'] =
      next === 'daily' ? { type: 'daily', time, timezone, isActive: true }
      : next === 'once' ? { type: 'once', runAt: draft.schedule.runAt || todayKey(), time, timezone, isActive: true }
      : next === 'hourly' ? { type: 'cron', cron: '0 * * * *', time, timezone, isActive: true }
      : { type: 'cron', cron: dowCron(time, selectedDays.length ? selectedDays : [1, 2, 3, 4, 5]), time, timezone, isActive: true }
    setDraft({ ...draft, schedule })
  }

  const setScheduleTime = (time: string) => {
    setDraft({
      ...draft,
      schedule: cadence === 'daysofweek'
        ? { ...draft.schedule, time, cron: dowCron(time, selectedDays) }
        : { ...draft.schedule, time },
    })
  }

  const toggleDay = (day: number) => {
    const next = selectedDays.includes(day)
      ? selectedDays.filter((d) => d !== day)
      : [...selectedDays, day]
    // Never allow zero days — keep at least the toggled one.
    const days = next.length ? next : [day]
    setDraft({ ...draft, schedule: { ...draft.schedule, type: 'cron', cron: dowCron(scheduleTime, days) } })
  }

  const setRunAt = (date: string) => {
    setDraft({ ...draft, schedule: { ...draft.schedule, type: 'once', runAt: date } })
  }

  // Plain-language confirmation of what the current schedule does.
  const scheduleSummary = (() => {
    const tz = draft.schedule.timezone || 'UTC'
    if (cadence === 'hourly') return `Runs every hour, on the hour (${tz}).`
    if (cadence === 'daily') return `Runs every day at ${scheduleTime} (${tz}).`
    if (cadence === 'daysofweek') {
      const names = [...selectedDays].sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join(', ')
      return `Runs ${names || '—'} at ${scheduleTime} (${tz}).`
    }
    if (cadence === 'once') return `Runs once on ${draft.schedule.runAt || todayKey()} at ${scheduleTime} (${tz}).`
    return ''
  })()

  // AI-proposed goal from a run's reflection pass, pending user confirmation —
  // only worth surfacing while the draft has no goal of its own yet.
  const suggestedGoal = typeof editingAgent?.suggestedGoal === 'string' ? editingAgent.suggestedGoal : ''

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="agent-name">Name</Label>
        <div className="flex gap-2">
          <EmojiPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
          <Input id="agent-name" className="flex-1" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </div>
      </div>
      <div>
        <Label htmlFor="agent-description">Description</Label>
        <Input id="agent-description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="agent-folder">Folder</Label>
          <Input
            id="agent-folder"
            placeholder="e.g. operations"
            value={draft.folder}
            onChange={(event) => setDraft({ ...draft, folder: event.target.value })}
          />
        </div>
        <div>
          <Label>Visibility</Label>
          <Select value={draft.visibility} onValueChange={(visibility: AgentDraft['visibility']) => setDraft({ ...draft, visibility })}>
            <SelectTrigger aria-label="Agent visibility"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="shared">Workspace</SelectItem>
              <SelectItem value="private">Private</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="agent-instructions">Instructions</Label>
        <Textarea id="agent-instructions" rows={8} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
      </div>
      <div>
        <Label htmlFor="agent-goal">Larger goal (optional)</Label>
        {suggestedGoal && !draft.goal && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2.5 text-sm text-indigo-900">
            <p><span className="font-semibold">Suggested goal:</span> {suggestedGoal}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, goal: suggestedGoal })}>
              Use it
            </Button>
          </div>
        )}
        <Textarea id="agent-goal" rows={2} value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} />
        <p className="mt-1 text-xs text-muted-foreground">
          The outcome this agent ultimately serves — it steers every run and self-evaluation.
        </p>
      </div>
      <div>
        <Label>Model</Label>
        <Select value={draft.model} onValueChange={(model) => setDraft({ ...draft, model })}>
          <SelectTrigger aria-label="Agent model"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <ModelOption provider={m.provider} label={m.label} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Connected tools picker ───────────────────────────────────── */}
      <div>
        <Label>Connected tools</Label>
        {availableIntegrations ? (
          <div className="mt-2 space-y-3">
            {/* All attachable tools across planes (built-ins, Nango, and
                custom Backstory-MCP connections) in one wrapping row group so
                they flow together rather than breaking onto separate rows. */}
            {(availableIntegrations.tools.length > 0 || availableIntegrations.connections.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {availableIntegrations.tools.map((t) => {
                  const selected = draft.integrations.includes(t.key)
                  // Tools with a natural resource scope (Slack channels, GitHub
                  // repos…) get a gear popover on the chip that fetches the live
                  // options and restricts the agent to a chosen subset.
                  const quickConfig = quickConfigForChip(t.key)
                  if (quickConfig) {
                    return (
                      <QuickConfigChip
                        key={t.key}
                        label={t.label}
                        slug={t.slug}
                        connected={t.connected}
                        selected={selected}
                        config={quickConfig}
                        value={draft.toolSettings?.[quickConfig.key] ?? []}
                        onToggle={() => toggleIntegration(t.key)}
                        onValueChange={(value) =>
                          setDraft({ ...draft, toolSettings: { ...(draft.toolSettings ?? {}), [quickConfig.key]: value } })
                        }
                      />
                    )
                  }
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => toggleIntegration(t.key)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs transition-colors duration-150',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                      )}
                    >
                      <IntegrationLogo slug={t.slug} name={t.label} className="h-4 w-4 bg-white/70" />
                      {t.label}
                      {!t.connected && !selected && (
                        <span className="text-[10px] opacity-60">not configured</span>
                      )}
                      {t.connected && !selected && (
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                      )}
                    </button>
                  )
                })}
                {availableIntegrations.connections.map((c) => {
                  const selected = draft.integrations.includes(c.name)
                  // Every MCP connection gets the gear popover: its options are
                  // the server's own tool list, so the agent can be limited to
                  // a subset of the server's tools.
                  const quickConfig = mcpQuickConfigs.get(c.id) ?? mcpToolQuickConfig(c)
                  return (
                    <QuickConfigChip
                      key={c.id}
                      label={c.name}
                      slug={c.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}
                      connected
                      selected={selected}
                      config={quickConfig}
                      value={draft.toolSettings?.[quickConfig.key] ?? []}
                      onToggle={() => toggleIntegration(c.name)}
                      onValueChange={(value) =>
                        setDraft({ ...draft, toolSettings: { ...(draft.toolSettings ?? {}), [quickConfig.key]: value } })
                      }
                    />
                  )
                })}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Click a tool to attach it to this agent — a green dot means it&apos;s connected and
              ready, but the agent only uses tools you attach here.
            </p>

            {/* HTTP API is the one attachable tool that needs its own per-API
                setup (endpoints + credentials), so it lives inline with the
                chip rather than on a separate settings page. */}
            {httpAttached && (
              <HttpEndpointsSection
                endpoints={draft.httpEndpoints ?? []}
                onChange={(endpoints) => setDraft({ ...draft, httpEndpoints: endpoints })}
                connections={availableIntegrations.connections}
              />
            )}
            {httpAttached && <HttpCredentialsPanel active={active} />}
            <div className="flex items-center gap-2">
              <Link
                href="/integrations?tab=servers"
                className="text-xs font-medium text-primary hover:underline"
              >
                + Connect a tool
              </Link>
              <span className="text-xs text-muted-foreground">
                — add more in Integrations.
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Loading integrations…</p>
        )}
      </div>

      <section className="overflow-hidden rounded-xl border border-border">
        <button
          type="button"
          onClick={() => setShowCapabilities((open) => !open)}
          aria-expanded={showCapabilities}
          aria-controls="agent-capabilities"
          className="flex w-full items-center justify-between gap-4 bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/60"
        >
          <span>
            <span className="block text-sm font-semibold text-foreground">Automation and delegation</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">Scheduling, agent handoffs, callable flows, and run safeguards.</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {enabledCapabilityCount > 0 && (
              <Badge variant="outline" className="bg-background">{enabledCapabilityCount} enabled</Badge>
            )}
            <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', showCapabilities && 'rotate-180')} />
          </span>
        </button>

        {showCapabilities && (
        <div id="agent-capabilities" className="space-y-4 border-t border-border p-4">
      {/* ── Multi-agent handoff ─────────────────────────────────────── */}
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Run other agents</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Let this agent delegate to your other agents (fan-out or pipeline stages) via a run_agent tool.
            </p>
          </div>
          <Switch
            aria-label="Allow this agent to run other agents"
            checked={draft.allowSubagents === true}
            onCheckedChange={(on) => setDraft({ ...draft, allowSubagents: on })}
          />
        </div>

        {draft.allowSubagents === true && (() => {
          const candidates = orgAgents.filter((a) => a.id !== editingAgent?.id)
          const selected = draft.subagentIds ?? []
          const allSelected = selected.length === 0
          const toggleAgent = (id: string) => {
            const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
            setDraft({ ...draft, subagentIds: next })
          }
          return (
            <div className="mt-3 border-t pt-3">
              <p className="mb-2 text-xs font-medium text-gray-600">Which agents can it run?</p>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-gray-50">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-600"
                  checked={allSelected}
                  onChange={() => setDraft({ ...draft, subagentIds: [] })}
                />
                <span className="font-medium">All agents</span>
                <span className="text-xs text-gray-400">({candidates.length} available)</span>
              </label>
              {candidates.length > 0 && (
                <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1">
                  {candidates.map((agent) => (
                    <label key={agent.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-gray-50">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-indigo-600"
                        checked={allSelected || selected.includes(agent.id)}
                        onChange={() => toggleAgent(agent.id)}
                      />
                      <span className="truncate">{agent.title}</span>
                    </label>
                  ))}
                </div>
              )}
              {candidates.length === 0 && <p className="px-1 text-xs text-gray-400">No other agents yet — create more to delegate to them.</p>}
            </div>
          )
        })()}
      </div>

      {/* ── Call flows ──────────────────────────────────────────────── */}
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Call flows</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Let this agent run your published flows via a run_flow tool and use their output.
            </p>
          </div>
          <Switch
            aria-label="Allow this agent to call flows"
            checked={draft.allowFlows === true}
            onCheckedChange={(on) => setDraft({ ...draft, allowFlows: on })}
          />
        </div>

        {draft.allowFlows === true && (() => {
          const selected = draft.flowIds ?? []
          const allSelected = selected.length === 0
          const toggleFlow = (id: string) => {
            const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
            setDraft({ ...draft, flowIds: next })
          }
          return (
            <div className="mt-3 border-t pt-3">
              <p className="mb-2 text-xs font-medium text-gray-600">Which flows can it run?</p>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-gray-50">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-600"
                  checked={allSelected}
                  onChange={() => setDraft({ ...draft, flowIds: [] })}
                />
                <span className="font-medium">All published flows</span>
                <span className="text-xs text-gray-400">({orgFlows.length} available)</span>
              </label>
              {orgFlows.length > 0 && (
                <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1">
                  {orgFlows.map((flow) => (
                    <label key={flow.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-gray-50">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-indigo-600"
                        checked={allSelected || selected.includes(flow.id)}
                        onChange={() => toggleFlow(flow.id)}
                      />
                      <span className="truncate">{flow.name}</span>
                    </label>
                  ))}
                </div>
              )}
              {orgFlows.length === 0 && (
                <p className="px-1 text-xs text-gray-400">No published flows yet — publish a flow in the builder to make it callable.</p>
              )}
            </div>
          )
        })()}
      </div>

      {/* ── Schedule ─────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <div>
            <Label>Schedule enabled</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">Run this agent automatically on a cadence.</p>
          </div>
          <Switch aria-label="Enable agent schedule" checked={draft.schedule.isActive} onCheckedChange={setScheduleEnabled} />
        </div>

        {draft.schedule.isActive && (
          <div className="space-y-3 border-t pt-3">
            <div>
              <Label>Cadence</Label>
              <Select value={cadence} onValueChange={(value) => setCadence(value as AgentCadence)}>
                <SelectTrigger aria-label="Schedule cadence"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="daysofweek">Days of week</SelectItem>
                  <SelectItem value="once">Once (specific date)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Days of week — weekday toggles */}
            {cadence === 'daysofweek' && (
              <div>
                <Label>Repeat on</Label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {DAY_LABELS.map((label, day) => {
                    const on = selectedDays.includes(day)
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleDay(day)}
                        className={cn(
                          'h-8 w-10 rounded-md border text-xs font-medium transition-colors duration-fast',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                        )}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Once — calendar date picker */}
            {cadence === 'once' && (
              <div>
                <Label>Date</Label>
                <div className="mt-1.5">
                  <MiniCalendar value={draft.schedule.runAt} onChange={setRunAt} min={todayKey()} />
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {/* Hourly has no time-of-day — it fires on the hour, every hour. */}
              {cadence !== 'hourly' && (
                <div>
                  <Label>Time</Label>
                  <Input aria-label="Schedule time" type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} />
                </div>
              )}
              <div>
                <Label>Timezone</Label>
                <Select
                  value={draft.schedule.timezone}
                  onValueChange={(timezone) => setDraft({ ...draft, schedule: { ...draft.schedule, timezone } })}
                >
                  <SelectTrigger aria-label="Schedule timezone"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {/* Keep a browser-detected zone outside the common list selectable. */}
                    {!COMMON_TIMEZONES.includes(draft.schedule.timezone as (typeof COMMON_TIMEZONES)[number]) && draft.schedule.timezone && (
                      <SelectItem value={draft.schedule.timezone}>{draft.schedule.timezone}</SelectItem>
                    )}
                    {COMMON_TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {scheduleSummary && <p className="text-xs text-muted-foreground">{scheduleSummary}</p>}
          </div>
        )}
      </div>

      {/* ── More configurations (collapsed by default) ──────────────── */}
      <div>
        <button
          type="button"
          onClick={() => setShowMoreConfig((v) => !v)}
          aria-expanded={showMoreConfig}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ChevronDown
            className={cn('h-4 w-4 transition-transform duration-150', !showMoreConfig && '-rotate-90')}
          />
          {showMoreConfig ? 'Hide extra configurations' : 'View more configurations'}
        </button>

        {showMoreConfig && (
          <div className="mt-3 space-y-3">
            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>Answer from memory automatically</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    When a question closely matches one you&apos;ve answered before, the agent reuses your answer instead of pausing.
                  </p>
                </div>
                <Switch
                  aria-label="Answer from memory automatically"
                  checked={draft.autoAnswerFromMemory === true}
                  onCheckedChange={(on) => setDraft({ ...draft, autoAnswerFromMemory: on })}
                />
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>Always strategize</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Every run starts with an explicit numbered plan before any tool call.
                  </p>
                </div>
                <Switch
                  aria-label="Always strategize before running"
                  checked={draft.alwaysStrategize === true}
                  onCheckedChange={(on) => setDraft({ ...draft, alwaysStrategize: on })}
                />
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>Approve messages before they send</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Slack messages, emails, and Salesforce records wait for a teammate to approve them instead of going out during the run. Reading is never held up.
                  </p>
                </div>
                <Switch
                  aria-label="Require approval before sending messages"
                  checked={draft.requireApproval === true}
                  onCheckedChange={(on) => setDraft({ ...draft, requireApproval: on })}
                />
              </div>
            </div>
          </div>
        )}
      </div>
        </div>
        )}
      </section>

      {/* ── Compact Skills display ───────────────────────────────────── */}
      <div>
        <Label>Skills</Label>
        {draft.skills.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {draft.skills.map((skillId) => (
              <span
                key={skillId}
                className="flex items-center gap-1 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground"
              >
                {skillNames[skillId] ?? skillId}
                <button
                  type="button"
                  aria-label={`Remove skill ${skillNames[skillId] ?? skillId}`}
                  onClick={() => detachSkill(skillId)}
                  className="ml-0.5 rounded-full p-0.5 transition-colors duration-150 hover:bg-border"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No skills attached.</p>
        )}
        <p className="mt-1.5 text-xs text-muted-foreground">
          Add skills from the{' '}
          <Link href="/templates?asset=skills" className="text-primary hover:underline">
            Library
          </Link>
          .
        </p>
      </div>

      {editingAgent?.id && <KnowledgePanel agentId={editingAgent.id} />}

      {editingAgent && (runsLoading || runs.length > 0) && (
        <div>
          <p className="eyebrow mb-2">Recent runs</p>
          {runsLoading ? (
            <p className="text-sm text-gray-500"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => openRun(run.id)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-gray-50"
                  >
                    <span className="truncate text-gray-700">{run.metadata?.headline || run.error || run.status}</span>
                    <span className="shrink-0 text-xs text-gray-500">{new Date(run.startedAt).toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editingAgent?.id && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="eyebrow">Memory</p>
            {memories.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowMemoryLog(true)}>
                View all ({memories.length})
              </Button>
            )}
          </div>
          {memoriesLoading ? (
            <p className="text-sm text-gray-500"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…</p>
          ) : memories.length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-sm text-gray-500">
              Nothing learned yet — memories appear after runs complete.
            </p>
          ) : (
            // Newest two only — the full log (and Clear all) lives in the
            // dialog, so a long-lived agent's memory can't push the Save
            // button out of reach.
            <ul className="divide-y rounded-lg border">
              {memories.slice(0, 2).map((memory) => (
                <MemoryRow key={memory.id} memory={memory} onDelete={deleteMemory} />
              ))}
            </ul>
          )}
          <Dialog open={showMemoryLog} onOpenChange={setShowMemoryLog}>
            <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Agent memory</DialogTitle>
                <DialogDescription>
                  Everything this agent has learned across runs — {memories.length === 1 ? '1 entry' : `${memories.length} entries`}.
                </DialogDescription>
              </DialogHeader>
              {memories.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-sm text-gray-500">
                  Nothing learned yet — memories appear after runs complete.
                </p>
              ) : (
                <ul className="min-h-0 divide-y overflow-y-auto rounded-lg border">
                  {memories.map((memory) => (
                    <MemoryRow key={memory.id} memory={memory} onDelete={deleteMemory} />
                  ))}
                </ul>
              )}
              {memories.length > 0 && (
                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmClearMemory(true)}
                    className="text-red-600 hover:text-red-700"
                  >
                    Clear all memory
                  </Button>
                </DialogFooter>
              )}
            </DialogContent>
          </Dialog>
          <ConfirmDialog
            open={confirmClearMemory}
            onOpenChange={setConfirmClearMemory}
            title="Clear all agent memory?"
            description="This permanently removes everything this agent has learned across runs."
            confirmLabel="Clear memory"
            destructive
            onConfirm={() => void clearAllMemory()}
          />
        </div>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-wrap gap-2 border-t bg-white/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        {editingAgent && onRunAgent && (
          <Button
            variant="outline"
            disabled={saving || runningId === editingAgent.id}
            onClick={runNow}
            className="shrink-0"
          >
            {saving || runningId === editingAgent.id
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Play className="mr-1.5 h-4 w-4" />}
            {dirty ? 'Save & run' : 'Run'}
          </Button>
        )}
        {editingAgent && (
          <Button
            variant="outline"
            disabled={saving || publishingTemplate || !draft.title || !draft.instructions}
            loading={publishingTemplate}
            onClick={publishTemplate}
            className="shrink-0"
          >
            Add to templates
          </Button>
        )}
        <Button className="flex-1" disabled={saving || !draft.title || !draft.instructions} onClick={submit}>
          {saving ? 'Saving...' : saveLabel || (editingAgent ? 'Save agent' : 'Create agent')}
        </Button>
      </div>
    </div>
  )
}
