'use client'

/**
 * One MCP server, opened from its card on Integrations → MCP Servers.
 *
 * Modeled on Claude's connector page: who the server is, whether it is
 * connected, and — the reason to open it — every tool it offers with a
 * permission per tool: Always allow, Needs approval, or Blocked. Those land on
 * McpConnection.toolPolicies and are enforced in the runtime (see
 * src/lib/mcp/tool-policy.ts), so what is set here is what agents and flows
 * can actually do.
 *
 * Changes save as they are made (optimistically, rolled back with a toast if
 * the server refuses). Reconnect, Edit, Copy server URL and Disconnect live
 * here too, so opening a server is never a dead end.
 */

import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Ban, Check, ChevronDown, Copy, Hand, MoreVertical, Pencil, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import type { CredentialDependent } from '@/lib/credentials/dependents'
import { EmbeddedOAuthStatus } from '@/components/auth/embedded-oauth-status'
import { useEmbeddedOAuth } from '@/hooks/use-embedded-oauth'
import { mcpReconnectCheck } from '@/lib/client/mcp-oauth-confirm'
import { EMBED_COMPLETE_PATH, topLevelNavigation } from '@/lib/embed'
import { reconnectHref } from '@/lib/mcp/reconnect'
import type { McpToolPolicy } from '@/lib/mcp/tool-policy'
import { cn } from '@/lib/utils'
import type { SerializedConnection } from '@/app/connections/mcp-connection-dialog'

export type McpToolItem = {
  name: string
  title: string
  description: string
  readOnly?: boolean
  destructive?: boolean
  policy: McpToolPolicy
}

type ConnectionInfo = {
  id: string
  name: string
  description: string | null
  provider: string | null
  serverUrl: string
  isActive: boolean
  healthStatus: string
  lastError: string | null
  lastVerifiedAt: string | null
  needsSignIn: boolean
  canManage: boolean
  canEdit: boolean
}

const POLICY_OPTIONS: { value: McpToolPolicy; label: string; icon: typeof Check; selected: string }[] = [
  { value: 'allow', label: 'Always allow', icon: Check, selected: 'bg-[var(--status-good-bg)] text-[var(--status-good-fg)] shadow-1' },
  { value: 'approve', label: 'Needs approval', icon: Hand, selected: 'bg-[var(--status-warn-bg)] text-[var(--status-warn-fg)] shadow-1' },
  { value: 'off', label: 'Blocked', icon: Ban, selected: 'bg-[var(--status-risk-bg)] text-[var(--status-risk-fg)] shadow-1' },
]
const policyLabel = (policy: McpToolPolicy) => POLICY_OPTIONS.find((option) => option.value === policy)!.label

/** Is this server working? Broken = the sweep or a verify said so, or it was never verified. */
export function mcpConnectionBroken(conn: Pick<SerializedConnection, 'isActive' | 'lastVerifiedAt' | 'healthStatus'>): boolean {
  return !conn.isActive || !conn.lastVerifiedAt || conn.healthStatus === 'unhealthy'
}

/**
 * The three-way permission control: a radio group of icon buttons, one tab
 * stop, arrow keys to move — the selected segment takes its status color.
 */
export function ToolPermissionControl({
  value,
  onChange,
  label,
  disabled,
}: {
  value: McpToolPolicy
  onChange: (next: McpToolPolicy) => void
  label: string
  disabled?: boolean
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = POLICY_OPTIONS[(index + step + POLICY_OPTIONS.length) % POLICY_OPTIONS.length]
    onChange(next.value)
    const group = event.currentTarget.parentElement
    requestAnimationFrame(() => group?.querySelector<HTMLButtonElement>(`[data-policy="${next.value}"]`)?.focus())
  }
  return (
    <div role="radiogroup" aria-label={`When ${label} may run`} className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5">
      {POLICY_OPTIONS.map((option, index) => {
        const checked = value === option.value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.label}
            title={option.label}
            data-policy={option.value}
            disabled={disabled}
            tabIndex={checked ? 0 : -1}
            onClick={() => { if (!checked) onChange(option.value) }}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'flex h-7 w-8 items-center justify-center rounded-md transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
              checked ? option.selected : 'text-fg-muted hover:bg-background hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}

/** "Custom ▾" — sets every tool in a group at once, and shows when they already agree. */
function GroupPermissionMenu({ tools, label, disabled, onSetAll }: { tools: McpToolItem[]; label: string; disabled?: boolean; onSetAll: (policy: McpToolPolicy) => void }) {
  const shared = tools.every((tool) => tool.policy === tools[0]?.policy) ? tools[0]?.policy : undefined
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-fg-muted" aria-label={`Set every tool in ${label}`}>
          {shared ? policyLabel(shared) : 'Custom'}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {POLICY_OPTIONS.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onSetAll(option.value)}>
            <option.icon className="h-3.5 w-3.5" aria-hidden />
            {option.label}
            {shared === option.value && <Check className="ml-auto h-3.5 w-3.5" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ToolGroup({ label, tools, total, canManage, onChange, onSetAll }: {
  label: string
  tools: McpToolItem[]
  total: McpToolItem[]
  canManage: boolean
  onChange: (name: string, policy: McpToolPolicy) => void
  onSetAll: (tools: McpToolItem[], policy: McpToolPolicy) => void
}) {
  const [open, setOpen] = useState(true)
  const listId = useId()
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className={cn('h-4 w-4 text-fg-muted transition-transform duration-fast', !open && '-rotate-90')} aria-hidden />
          {label}
          <span className="rounded-full bg-muted px-1.5 text-xs font-normal tabular-nums text-fg-muted">{total.length}</span>
        </button>
        <GroupPermissionMenu tools={total} label={label} disabled={!canManage} onSetAll={(policy) => onSetAll(total, policy)} />
      </div>
      {open && (
        <ul id={listId} className="divide-y border-t">
          {tools.map((tool) => (
            <li key={tool.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground" title={tool.name}>{tool.title}</p>
                {tool.description && (
                  <p className="line-clamp-1 text-xs text-fg-muted" title={tool.description}>{tool.description}</p>
                )}
              </div>
              <ToolPermissionControl value={tool.policy} label={tool.title} disabled={!canManage} onChange={(policy) => onChange(tool.name, policy)} />
            </li>
          ))}
          {tools.length === 0 && <li className="px-3 py-2.5 text-xs text-fg-muted">No tools in this group match your search.</li>}
        </ul>
      )}
    </section>
  )
}

/**
 * Confirm a disconnect, naming what will stop working first. Used by this
 * dialog and by the card's trash button, which used to delete on one click.
 */
export function DisconnectMcpDialog({ connection, open, onOpenChange, onConfirm }: {
  connection: { id: string; name: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}) {
  const [dependents, setDependents] = useState<{ summary: string; items: CredentialDependent[] } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setDependents(null)
    let live = true
    void fetch(`/api/credentials/dependents?kind=mcp_connection&ref=${encodeURIComponent(connection.id)}`, { cache: 'no-store' })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!live) return
        setDependents(data?.success ? { summary: String(data.summary ?? ''), items: (data.dependents ?? []) as CredentialDependent[] } : { summary: '', items: [] })
      })
      .catch(() => { if (live) setDependents({ summary: '', items: [] }) })
    return () => { live = false }
  }, [open, connection.id])

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {connection.name}?</DialogTitle>
          <DialogDescription>
            Its stored credentials are deleted, and agents and flows lose its tools. You can add the server again later.
          </DialogDescription>
        </DialogHeader>
        {!dependents ? (
          <Skeleton className="h-10 w-full" />
        ) : dependents.items.length > 0 ? (
          <div className="rounded-lg border border-[var(--status-warn-fg)]/30 bg-[var(--status-warn-bg)] p-3 text-sm text-[var(--status-warn-fg)]">
            <p className="font-medium">{dependents.summary}</p>
            <ul className="mt-1.5 space-y-0.5 text-xs">
              {dependents.items.slice(0, 6).map((entry) => (
                <li key={`${entry.type}:${entry.id}`}>
                  {entry.name}
                  <span className="opacity-80"> ({entry.type === 'agent' ? 'agent' : entry.published ? 'published flow' : 'draft flow'})</span>
                </li>
              ))}
              {dependents.items.length > 6 && <li>and {dependents.items.length - 6} more</li>}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-fg-muted">No agent or flow uses this server.</p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={confirm} loading={busy}>Disconnect</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface McpConnectionDetailDialogProps {
  connection: SerializedConnection
  /** Where the OAuth round trip lands back — the page holding this dialog. */
  returnTo: string
  verifying: boolean
  onVerify: () => void
  onEdit: () => void
  /** Delete the connection (the caller owns the list and reloads it). */
  onDisconnect: () => Promise<void>
  /** Tool permissions changed — the caller may refresh its summary. */
  onPermissionsChanged?: () => void
  /** A sign-in run in the embedded popup re-established the connection; the
   *  page never reloaded, so the caller refreshes its list. */
  onReconnected?: () => void
  onClose: () => void
}

export function McpConnectionDetailDialog({
  connection, returnTo, verifying, onVerify, onEdit, onDisconnect, onPermissionsChanged, onReconnected, onClose,
}: McpConnectionDetailDialogProps) {
  const oauth = useEmbeddedOAuth()
  const [info, setInfo] = useState<ConnectionInfo | null>(null)
  const [tools, setTools] = useState<McpToolItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const response = await fetch(`/api/mcp-connections/${encodeURIComponent(connection.id)}/tools?all=1`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (data.connection) setInfo(data.connection as ConnectionInfo)
      if (!response.ok || !data.success) {
        setTools([])
        setLoadError(data.error || `Couldn't load this server's tools (HTTP ${response.status}).`)
        return
      }
      setTools(data.items as McpToolItem[])
    } catch {
      setTools([])
      setLoadError("Couldn't reach Backstory to load this server's tools. Check your connection and reopen it.")
    }
  }, [connection.id])

  useEffect(() => { void load() }, [load])

  /** Apply now, save in the background, put it back if the save is refused. */
  const savePolicies = async (changes: Record<string, McpToolPolicy>) => {
    const before = tools
    if (!before) return
    const effective = Object.fromEntries(Object.entries(changes).filter(([name, policy]) => before.find((tool) => tool.name === name)?.policy !== policy))
    if (!Object.keys(effective).length) return
    setTools(before.map((tool) => (tool.name in effective ? { ...tool, policy: effective[tool.name] } : tool)))
    try {
      const response = await fetch(`/api/mcp-connections/${encodeURIComponent(connection.id)}/tools`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: effective }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Couldn't save the change (HTTP ${response.status}).`)
      }
      onPermissionsChanged?.()
    } catch (error) {
      // Roll back only what this change touched, so a later change that
      // already landed is not undone with it.
      setTools((current) => current?.map((tool) => {
        if (!(tool.name in effective)) return tool
        const previous = before.find((candidate) => candidate.name === tool.name)
        return previous ? { ...tool, policy: previous.policy } : tool
      }) ?? null)
      toast.error(error instanceof Error ? error.message : "Couldn't save the change.")
    }
  }

  const name = info?.name ?? connection.name
  const description = info?.description ?? connection.description
  const managed = Boolean(info?.provider ?? connection.provider)
  const canManage = info?.canManage ?? false
  const canEdit = (info?.canEdit ?? false) && !managed
  const signIn = info?.needsSignIn ?? false
  const broken = mcpConnectionBroken(connection) || info?.healthStatus === 'unhealthy'
  const reconnect = () => {
    if (!signIn) return onVerify()
    const target = { id: connection.id, provider: connection.provider, auth: connection.auth }
    // Embedded, the sign-in runs in a popup (the frame can follow neither the
    // IdP nor its Lax state cookie) and the dialog refreshes in place once the
    // server shows the connection re-verified. Top-level, the redirect as ever.
    const popped = oauth.launch({
      popupHref: reconnectHref(target, EMBED_COMPLETE_PATH),
      popupName: 'backstory-mcp-signin',
      check: mcpReconnectCheck({ id: connection.id, lastVerifiedAt: info?.lastVerifiedAt ?? connection.lastVerifiedAt ?? null }),
      onDone: () => {
        toast.success(`${name} reconnected.`)
        void load()
        onReconnected?.()
      },
    })
    if (!popped) topLevelNavigation.assign(reconnectHref(target, returnTo))
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!tools || !needle) return tools ?? []
    return tools.filter((tool) => `${tool.title} ${tool.name} ${tool.description}`.toLowerCase().includes(needle))
  }, [tools, query])

  // Group by what the server says about its tools. Without any hints there is
  // one honest group; with them, read-only and write tools split the way
  // Claude's page does, and anything unlabeled is kept apart rather than
  // guessed into either.
  const groups = useMemo(() => {
    const all = tools ?? []
    const hinted = all.some((tool) => typeof tool.readOnly === 'boolean')
    if (!hinted) return [{ label: 'Tools', total: all, shown: filtered }]
    const by = (test: (tool: McpToolItem) => boolean) => ({ total: all.filter(test), shown: filtered.filter(test) })
    return [
      { label: 'Read-only tools', ...by((tool) => tool.readOnly === true) },
      { label: 'Write tools', ...by((tool) => tool.readOnly === false) },
      { label: 'Other tools', ...by((tool) => typeof tool.readOnly !== 'boolean') },
    ].filter((group) => group.total.length > 0)
  }, [tools, filtered])

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(info?.serverUrl ?? connection.serverUrl)
      toast.success('Server URL copied.')
    } catch {
      toast.error("Couldn't copy — select the URL and copy it instead.")
    }
  }

  let status: ReactNode
  if (broken) status = <Badge variant="warn"><AlertTriangle className="mr-1 h-3 w-3" aria-hidden />Needs reconnecting</Badge>
  else status = <Badge variant="good"><Check className="mr-1 h-3 w-3" aria-hidden />Connected</Badge>

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
          <DialogHeader className="space-y-3 border-b px-6 pb-4 pt-6 text-left">
            <div className="flex flex-wrap items-center justify-between gap-3 pr-8">
              <div className="flex min-w-0 items-center gap-3">
                <IntegrationLogo slug={connection.provider ?? connection.name} name={name} className="h-10 w-10 rounded-lg bg-white p-1.5 ring-1 ring-border" />
                <div className="min-w-0">
                  <DialogTitle className="truncate text-lg">{name}</DialogTitle>
                  <p className="truncate text-xs text-fg-muted" title={info?.serverUrl ?? connection.serverUrl}>{info?.serverUrl ?? connection.serverUrl}</p>
                </div>
                {status}
              </div>
              <div className="flex items-center gap-1.5">
                {canEdit && (
                  <Button variant="outline" size="sm" onClick={() => setConfirmingDisconnect(true)}>Disconnect</Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`More actions for ${name}`}>
                      <MoreVertical className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={reconnect} disabled={!signIn && verifying}>
                      {signIn ? <RefreshCw className="h-3.5 w-3.5" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
                      {signIn ? 'Reconnect' : verifying ? 'Verifying…' : 'Verify connection'}
                    </DropdownMenuItem>
                    {canEdit && (
                      <DropdownMenuItem onSelect={onEdit}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                        Edit
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={copyUrl}>
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                      Copy server URL
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <DialogDescription className="text-sm text-fg-muted">
              {description || `Tools from ${name}, available to your agents and flows.`}
              {managed && ' Managed by Backstory — reconnect it here; it can’t be removed.'}
            </DialogDescription>
            <EmbeddedOAuthStatus state={oauth} />
          </DialogHeader>

          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {broken && !loadError && (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--status-warn-fg)]/30 bg-[var(--status-warn-bg)] p-3 text-sm text-[var(--status-warn-fg)]">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {info?.lastError || connection.lastError || 'This server stopped answering. Reconnect it so agents and flows can use its tools again.'}
                </p>
                <Button size="sm" variant="outline" onClick={reconnect} loading={!signIn && verifying}>Reconnect</Button>
              </div>
            )}

            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Tool permissions</h3>
                <p className="mt-0.5 max-w-md text-xs text-fg-muted">
                  Choose when agents and flows may use each tool. Tools this server adds later are allowed until you change them.
                </p>
              </div>
              {tools && tools.length > 6 && (
                <div className="relative w-full sm:w-56">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" aria-hidden />
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tools" aria-label="Search tools" className="h-8 pl-8 text-sm" />
                </div>
              )}
            </div>

            {!canManage && info && (
              <p className="text-xs text-fg-muted">Only a workspace admin can change the tools of a shared server.</p>
            )}

            {tools === null && (
              <div className="space-y-2" aria-label="Loading tools">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </div>
            )}

            {loadError && (
              <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-5 text-sm">
                <p className="flex items-start gap-2 text-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warn-fg)]" aria-hidden />
                  {loadError}
                </p>
                <Button size="sm" onClick={reconnect} loading={!signIn && verifying}>
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  Reconnect
                </Button>
              </div>
            )}

            {tools && !loadError && tools.length === 0 && (
              <p className="text-sm text-fg-muted">This server offers no tools right now.</p>
            )}

            {tools && !loadError && groups.map((group) => (
              <ToolGroup
                key={group.label}
                label={group.label}
                tools={group.shown}
                total={group.total}
                canManage={canManage}
                onChange={(toolName, policy) => void savePolicies({ [toolName]: policy })}
                onSetAll={(groupTools, policy) => void savePolicies(Object.fromEntries(groupTools.map((tool) => [tool.name, policy])))}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <DisconnectMcpDialog
        connection={{ id: connection.id, name }}
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        onConfirm={async () => {
          await onDisconnect()
          onClose()
        }}
      />
    </>
  )
}
