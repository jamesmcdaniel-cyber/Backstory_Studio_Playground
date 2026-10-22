'use client'

import { useEffect, useState } from 'react'
import { Ban, ChevronDown, Eye, Hand, HelpCircle, Loader2, PenLine, RotateCcw, Split } from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { cn } from '@/lib/utils'
import type {
  AgentScope,
  AgentScopeSummary,
  ScopeActsAs,
  ScopeConnection,
  ScopeTool,
  ScopeToolAccess,
  ScopeTrigger,
} from '@/lib/agents/scope-types'

/**
 * "What this agent can do" — the scope card.
 *
 * Presentational over an AgentScope, which the server derives from the
 * runtime's own tool resolution (/api/agents/[id]/scope). Three exports:
 *
 *   AgentScopeSummaryLine — the compact counts + badges a roster card carries;
 *   AgentScopeCard        — the full card, from a scope already in hand;
 *   AgentScopePanel       — the full card, fetched for an agent id.
 *
 * Reusable as-is by anything that can produce an AgentScope (an external
 * agent shown as a teammate): nothing here knows where the scope came from.
 *
 * The permission vocabulary — Check / Hand "Needs approval" / Ban "Blocked",
 * on the status tokens — is the one Integrations uses for MCP tool
 * permissions, so a person reads the same states in both places.
 */

const ACCESS: Record<ScopeToolAccess, { label: string; icon: typeof Eye }> = {
  read: { label: 'Reads', icon: Eye },
  write: { label: 'Writes', icon: PenLine },
  depends: { label: 'Reads or writes', icon: Split },
  unclassified: { label: 'Not classified', icon: HelpCircle },
}

const ACTS_AS: Record<ScopeActsAs, string> = {
  user: 'Your account',
  workspace: 'Workspace',
  service: 'Workspace service',
  none: 'Inside Backstory',
}

/** Logo slug for a connection's provider (the logo resolver falls back to an initial). */
function logoSlug(connection: ScopeConnection): string {
  const provider = connection.provider.replace(/^nango:/, '')
  const known: Record<string, string> = {
    email: 'resend', google_drive: 'googledrive', google_sheets: 'googlesheets', google_calendar: 'googlecalendar',
    monday: 'mondaydotcom', http: 'http', data_tables: 'postgresql', repository: 'files', code: 'python', research: 'brave',
  }
  if (connection.plane === 'people_ai') return 'backstory'
  if (connection.plane === 'mcp') return connection.name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return known[provider] ?? provider.replace(/_/g, '')
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`

// ── Compact ──────────────────────────────────────────────────────────────────

/**
 * The roster card's scope line. Spans only — it sits inside the card's open
 * button, so it must not add an interactive element of its own.
 */
export function AgentScopeSummaryLine({ summary, className }: { summary: AgentScopeSummary | null | undefined; className?: string }) {
  if (!summary) return <span className={cn('block h-5', className)} aria-hidden="true" />
  const { counts } = summary
  return (
    <span className={cn('flex h-5 w-full items-center justify-center gap-1.5 text-[11px] text-muted-foreground', className)}>
      <span className="tabular-nums">{summary.jobs ? `Up to ${plural(counts.tools, 'tool')}` : plural(counts.tools, 'tool')}</span>
      {counts.writes > 0 && (
        <span className="inline-flex items-center gap-0.5 tabular-nums">
          <PenLine className="h-3 w-3" aria-hidden="true" />
          {counts.writes} can write
        </span>
      )}
      {summary.agentRequiresApproval ? (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--status-warn-bg)] px-1.5 text-[var(--status-warn-fg)]">
          <Hand className="h-3 w-3" aria-hidden="true" /> Asks first
        </span>
      ) : counts.needsApproval > 0 ? (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--status-warn-bg)] px-1.5 text-[var(--status-warn-fg)]">
          <Hand className="h-3 w-3" aria-hidden="true" /> {counts.needsApproval} gated
        </span>
      ) : null}
      {counts.blocked > 0 && (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--status-risk-bg)] px-1.5 text-[var(--status-risk-fg)]">
          <Ban className="h-3 w-3" aria-hidden="true" /> {counts.blocked} blocked
        </span>
      )}
    </span>
  )
}

// ── Full ─────────────────────────────────────────────────────────────────────

function actsAsSentence(scope: AgentScope): string {
  const groups = new Map<ScopeActsAs, string[]>()
  for (const connection of scope.connections) {
    if (connection.unavailable || connection.actsAs === 'none' || !connection.tools.length) continue
    groups.set(connection.actsAs, [...(groups.get(connection.actsAs) ?? []), connection.name])
  }
  const parts: string[] = []
  if (groups.get('user')?.length) parts.push(`your own ${groups.get('user')!.join(', ')}`)
  if (groups.get('workspace')?.length) parts.push(`the workspace's ${groups.get('workspace')!.join(', ')}`)
  if (groups.get('service')?.length) parts.push(`the workspace service identity for ${groups.get('service')!.join(', ')}`)
  return parts.length ? `When you run it, it uses ${parts.join('; ')}.` : 'When you run it, it reaches no outside account.'
}

function triggerLabel(trigger: ScopeTrigger): string {
  switch (trigger.kind) {
    case 'schedule': return trigger.description
    case 'webhook': return 'A webhook can start it'
    case 'signal': return `Starts on the "${trigger.description}" signal`
    case 'slack_channel': return `Answers in ${plural(trigger.count, 'Slack channel')}`
    case 'slack_command': return `/${trigger.command} in Slack`
  }
}

function StatusChip({ tool }: { tool: ScopeTool }) {
  if (tool.status === 'needs_approval') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--status-warn-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--status-warn-fg)]">
        <Hand className="h-3 w-3" aria-hidden="true" />
        {tool.approvalBy === 'integration' ? 'Needs approval' : 'Asks first'}
      </span>
    )
  }
  if (tool.status === 'blocked') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--status-risk-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--status-risk-fg)]">
        <Ban className="h-3 w-3" aria-hidden="true" />
        {tool.blockedBy === 'agent' ? 'Off for this agent' : 'Blocked in Integrations'}
      </span>
    )
  }
  return null
}

function ToolRow({ tool }: { tool: ScopeTool }) {
  const access = ACCESS[tool.access]
  const Icon = access.icon
  return (
    <li className={cn('grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-0.5 px-3 py-2', tool.status === 'blocked' && 'opacity-70')}>
      <span className="min-w-0">
        <span className={cn('block truncate text-sm text-foreground', tool.status === 'blocked' && 'line-through decoration-gray-300')}>{tool.label}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <Icon className="h-3 w-3" aria-hidden="true" /> {access.label}
          </span>
          {tool.undo && (
            <span className="inline-flex items-center gap-1" title={tool.undo.note}>
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {tool.undo.undoable ? 'Can be undone' : "Can't be undone"}
            </span>
          )}
        </span>
      </span>
      <StatusChip tool={tool} />
    </li>
  )
}

function ConnectionRow({ connection, defaultOpen }: { connection: ScopeConnection; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const usable = connection.tools.filter((tool) => tool.status !== 'blocked')
  const writes = usable.filter((tool) => tool.access === 'write' || tool.access === 'depends').length
  const gated = usable.filter((tool) => tool.status === 'needs_approval').length
  const blocked = connection.tools.length - usable.length
  return (
    <li className="rounded-xl border border-gray-200/80 bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={!connection.tools.length}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:cursor-default disabled:hover:bg-white"
      >
        <IntegrationLogo slug={logoSlug(connection)} name={connection.name} className="h-7 w-7 rounded-md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{connection.name}</span>
            <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">{ACTS_AS[connection.actsAs]}</span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {connection.unavailable
              ? connection.unavailable
              : [
                  plural(usable.length, 'tool'),
                  writes ? `${writes} can write` : 'read only',
                  gated ? `${gated} need approval` : null,
                  blocked ? `${blocked} blocked` : null,
                ].filter(Boolean).join(', ')}
          </span>
        </span>
        {connection.tools.length > 0 && (
          <ChevronDown className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200', open && 'rotate-180')} aria-hidden="true" />
        )}
      </button>
      {open && connection.tools.length > 0 && (
        <ul className="divide-y border-t">
          {connection.tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
        </ul>
      )}
    </li>
  )
}

/** The full card for a scope already in hand. */
export function AgentScopeCard({ scope, className }: { scope: AgentScope; className?: string }) {
  const { counts } = scope
  const withTools = scope.connections.filter((connection) => connection.tools.length || connection.unavailable)
  // Writes first: they are what a person is deciding whether to trust.
  const ordered = [...withTools].sort((a, b) => {
    const weight = (connection: ScopeConnection) =>
      connection.unavailable ? 3 : connection.tools.some((tool) => tool.access === 'write' || tool.access === 'depends') ? 0 : connection.actsAs === 'none' ? 2 : 1
    return weight(a) - weight(b)
  })
  const runsAsOwner = scope.triggers.some((trigger) => trigger.kind === 'schedule' || trigger.kind === 'signal')
  return (
    <section className={cn('space-y-4', className)} aria-labelledby={`scope-${scope.agentId}`}>
      <div>
        <h3 id={`scope-${scope.agentId}`} className="text-base font-semibold text-foreground">What this agent can do</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Checked the way a run checks it, for you: agents act as whoever runs them.
        </p>
      </div>

      <dl className="grid gap-x-4 gap-y-3 rounded-xl border border-gray-200/80 bg-gray-50/60 p-4 text-sm sm:grid-cols-[7rem_1fr]">
        <dt className="font-medium text-foreground">Acts as</dt>
        <dd className="text-muted-foreground">
          {actsAsSentence(scope)}
          {runsAsOwner && (
            <> Scheduled and signal runs act as {scope.identity.ownerName ?? 'the agent’s owner'}.</>
          )}
        </dd>

        <dt className="font-medium text-foreground">Approval</dt>
        <dd className="text-muted-foreground">
          {scope.approval.agentRequiresApproval
            ? 'Asks you before it writes through a connected account or a warehouse.'
            : counts.needsApproval
              ? `Acts without asking, except ${plural(counts.needsApproval, 'tool')} set to Needs approval in Integrations.`
              : counts.writes
                ? 'Acts without asking first.'
                : 'Nothing it can do changes anything outside Backstory.'}
          {scope.approval.notCoveredByAgentApproval.length > 0 && (
            <span className="mt-1 block text-[var(--status-warn-fg)]">
              Not held for approval: {scope.approval.notCoveredByAgentApproval.join(', ')}.
            </span>
          )}
        </dd>

        <dt className="font-medium text-foreground">Data</dt>
        <dd className="text-muted-foreground">
          Reads workspace documents in the Repository
          {scope.data.agentDocuments > 0 ? `, plus ${plural(scope.data.agentDocuments, 'document')} added to this agent` : ''}
          {scope.data.collections.length > 0 ? `, and these collections: ${scope.data.collections.map((collection) => collection.name).join(', ')}` : ''}.
        </dd>

        <dt className="font-medium text-foreground">Starts</dt>
        <dd className="text-muted-foreground">
          {scope.triggers.length
            ? scope.triggers.map(triggerLabel).join('. ') + '.'
            : 'Only when someone runs it.'}
        </dd>
      </dl>

      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground">Connections and tools</h4>
          <span className="text-xs tabular-nums text-muted-foreground">
            {plural(counts.tools, 'tool')}, {counts.writes} can write{counts.blocked ? `, ${counts.blocked} blocked` : ''}
          </span>
        </div>
        {ordered.length ? (
          <ul className="space-y-2">
            {ordered.map((connection, index) => (
              <ConnectionRow key={connection.key} connection={connection} defaultOpen={index === 0 && ordered.length <= 4} />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">No tools are connected to this agent.</p>
        )}
      </div>

      {scope.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-fg-muted">
          {scope.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </section>
  )
}

/** The full card, fetched for one agent. */
export function AgentScopePanel({ agentId, className }: { agentId: string; className?: string }) {
  const [scope, setScope] = useState<AgentScope | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setScope(null)
    setError(null)
    fetch(`/api/agents/${agentId}/scope`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (cancelled) return
        if (!response.ok || !data.scope) setError(data.error || 'Could not load what this agent can do.')
        else setScope(data.scope)
      })
      .catch(() => { if (!cancelled) setError('Could not load what this agent can do.') })
    return () => { cancelled = true }
  }, [agentId])
  if (error) return <p className={cn('rounded-xl border border-dashed p-4 text-sm text-muted-foreground', className)}>{error}</p>
  if (!scope) {
    return (
      <p className={cn('flex items-center gap-2 p-4 text-sm text-muted-foreground', className)}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking what this agent can do…
      </p>
    )
  }
  return <AgentScopeCard scope={scope} className={className} />
}
