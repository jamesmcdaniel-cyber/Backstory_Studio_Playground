'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ExternalLink, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import {
  HttpCredentialDialog,
  HTTP_AUTH_OPTIONS,
  type HttpCredentialSummary,
} from './http-credential-dialog'
import { cn } from '@/lib/utils'

/**
 * The workspace's credential bank, surfaced where flows are built. Everything a
 * node can authenticate with — OAuth app accounts, MCP servers, HTTP
 * credentials, workspace keys — is connected once and reused by every flow, so
 * building a new flow never means re-entering a secret: pick the stored
 * credential in the step, and only reconnect here when one expires.
 *
 * Read surface for every flow author (all list endpoints are redacted and
 * flow.read); create / re-verify / delete of HTTP credentials call the
 * admin-gated write endpoints and surface a friendly message on 403.
 */

const OPEN_KEY = 'flows.credentialsBank.open'

/** Mirrors the Settings panel's provider list (workspace-credentials-panel.tsx). */
const WORKSPACE_KEY_PROVIDERS = ['slack', 'email', 'granola'] as const

type OauthConnection = {
  key: string
  provider: string
  connected: boolean
  error?: string
}

type McpConnection = {
  id: string
  provider: string | null
  name: string
  serverUrl: string
  isActive: boolean
  userId: string | null
}

type WorkspaceKey = {
  provider: string
  label: string
  configured: boolean
  hasOwnKey: boolean
  source: 'org' | 'env' | null
}

const AUTH_TYPE_LABEL = Object.fromEntries(HTTP_AUTH_OPTIONS.map((option) => [option.value, option.label]))

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) return null
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function writeErrorToast(data: unknown, status: number) {
  const message =
    status === 403
      ? 'Only workspace admins can manage credentials.'
      : (data as { error?: string })?.error || 'The request failed.'
  toast.error(message)
}

export function CredentialsBank() {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [oauth, setOauth] = useState<OauthConnection[]>([])
  const [mcp, setMcp] = useState<McpConnection[]>([])
  const [http, setHttp] = useState<HttpCredentialSummary[]>([])
  const [keys, setKeys] = useState<WorkspaceKey[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<HttpCredentialSummary | null>(null)

  useEffect(() => {
    try {
      if (localStorage.getItem(OPEN_KEY) === '1') setOpen(true)
    } catch {
      /* storage unavailable */
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const [nango, servers, credentials, ...keyStates] = await Promise.all([
      fetchJson('/api/nango/status'),
      fetchJson('/api/mcp-connections'),
      fetchJson('/api/http-credentials'),
      ...WORKSPACE_KEY_PROVIDERS.map((provider) => fetchJson(`/api/integrations/credentials/${provider}`)),
    ])
    const connections = (nango?.connections ?? {}) as Record<string, { provider?: string; connected?: boolean; error?: string }>
    setOauth(
      Object.entries(connections).map(([key, status]) => ({
        key,
        provider: status.provider ?? key,
        connected: Boolean(status.connected),
        error: status.error,
      })),
    )
    setMcp(Array.isArray(servers?.connections) ? (servers.connections as McpConnection[]) : [])
    setHttp(Array.isArray(credentials?.credentials) ? (credentials.credentials as HttpCredentialSummary[]) : [])
    setKeys(keyStates.flatMap((state) => (state?.provider ? [state as unknown as WorkspaceKey] : [])))
    setLoading(false)
    setLoaded(true)
  }, [])

  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
    if (next && !loaded && !loading) void load()
  }

  useEffect(() => {
    if (open && !loaded && !loading) void load()
    // Load once when restored open from storage; subsequent opens reuse state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const reverify = async (credential: HttpCredentialSummary) => {
    setBusyId(credential.id)
    try {
      const response = await fetch('/api/http-credentials', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: credential.id }),
      })
      const data = await response.json().catch(() => null)
      if (response.ok && data?.success) {
        setHttp((current) => current.map((row) => (row.id === credential.id ? data.credential : row)))
        toast.success(`${credential.name} verified.`)
      } else {
        // A failed probe also flips the stored row to error — reflect that.
        setHttp((current) =>
          current.map((row) =>
            row.id === credential.id && response.status !== 403 ? { ...row, status: 'error' } : row,
          ),
        )
        writeErrorToast(data, response.status)
      }
    } finally {
      setBusyId(null)
    }
  }

  const removeCredential = async (credential: HttpCredentialSummary) => {
    setBusyId(credential.id)
    try {
      const response = await fetch(`/api/http-credentials?id=${encodeURIComponent(credential.id)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => null)
      if (response.ok && data?.success) {
        setHttp((current) => current.filter((row) => row.id !== credential.id))
        toast.success(`${credential.name} deleted.`)
      } else {
        writeErrorToast(data, response.status)
      }
    } finally {
      setBusyId(null)
      setDeleteTarget(null)
    }
  }

  const connectedCount =
    oauth.filter((row) => row.connected).length +
    mcp.filter((row) => row.isActive).length +
    http.filter((row) => row.status === 'verified').length +
    keys.filter((row) => row.configured).length
  const attentionCount =
    oauth.filter((row) => !row.connected).length +
    mcp.filter((row) => !row.isActive).length +
    http.filter((row) => row.status !== 'verified').length

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/50"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-horizon-50 text-horizon-600 dark:bg-horizon-500/10 dark:text-horizon-300">
          <KeyRound className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">Credentials bank</span>
          <span className="block truncate text-xs text-muted-foreground">
            Connect once — every flow in this workspace reuses these. Reconnect only when one expires.
          </span>
        </span>
        {loaded && (
          <span className="flex shrink-0 items-center gap-1.5">
            <Badge variant="good">{connectedCount} connected</Badge>
            {attentionCount > 0 && <Badge variant="warn">{attentionCount} need attention</Badge>}
          </span>
        )}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-5 border-t border-border/60 px-5 py-4">
          {loading && !loaded ? (
            <div className="space-y-2">
              <Skeleton className="h-10 rounded-lg" />
              <Skeleton className="h-10 rounded-lg" />
              <Skeleton className="h-10 rounded-lg" />
            </div>
          ) : (
            <>
              <BankSection
                title="App accounts"
                hint="OAuth accounts flows use through Tool steps."
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/integrations">
                      Manage in Integrations <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                }
              >
                {oauth.length === 0 ? (
                  <BankEmpty>No app accounts connected yet — connect Slack, Gmail, Salesforce and more in Integrations.</BankEmpty>
                ) : (
                  oauth.map((row) => (
                    <BankRow
                      key={row.key}
                      logoSlug={row.provider}
                      name={row.key}
                      detail={row.error}
                      badge={
                        row.connected ? <Badge variant="good">Connected</Badge> : <Badge variant="warn">Reconnect</Badge>
                      }
                    />
                  ))
                )}
              </BankSection>

              <BankSection
                title="MCP servers"
                hint="Connected servers exposing tools to agents and HTTP steps."
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/integrations?tab=servers">
                      Manage servers <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                }
              >
                {mcp.length === 0 ? (
                  <BankEmpty>No MCP servers connected.</BankEmpty>
                ) : (
                  mcp.map((row) => (
                    <BankRow
                      key={row.id}
                      logoSlug={row.provider ?? row.name}
                      name={row.name}
                      detail={hostOf(row.serverUrl) + (row.userId ? ' · personal' : '')}
                      badge={row.isActive ? <Badge variant="good">Active</Badge> : <Badge variant="warn">Inactive</Badge>}
                    />
                  ))
                )}
              </BankSection>

              <BankSection
                title="HTTP credentials"
                hint="Reusable auth for HTTP request steps, bound to the host they were verified against."
                action={
                  <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" /> New credential
                  </Button>
                }
              >
                {http.length === 0 ? (
                  <BankEmpty>No HTTP credentials yet — add one here or from any HTTP step, then reuse it everywhere.</BankEmpty>
                ) : (
                  http.map((row) => (
                    <BankRow
                      key={row.id}
                      logoSlug={row.allowedHost.split('.').slice(-2, -1)[0]}
                      name={row.name}
                      detail={`${row.allowedHost} · ${AUTH_TYPE_LABEL[row.authType] ?? row.authType}${row.status !== 'verified' && row.lastError ? ` — ${row.lastError}` : ''}`}
                      badge={row.status === 'verified' ? <Badge variant="good">Verified</Badge> : <Badge variant="warn">Reconnect</Badge>}
                      actions={
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void reverify(row)}
                            loading={busyId === row.id}
                            title="Verify this credential still works"
                          >
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Re-verify
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700"
                            onClick={() => setDeleteTarget(row)}
                            disabled={busyId === row.id}
                            aria-label={`Delete ${row.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      }
                    />
                  ))
                )}
              </BankSection>

              <BankSection
                title="Workspace keys"
                hint="API keys shared by the whole workspace."
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/settings">
                      Manage in Settings <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                }
              >
                {keys.length === 0 ? (
                  <BankEmpty>Workspace keys could not be loaded.</BankEmpty>
                ) : (
                  keys.map((row) => (
                    <BankRow
                      key={row.provider}
                      logoSlug={row.provider}
                      name={row.label}
                      detail={row.hasOwnKey ? 'This workspace' : row.source === 'env' ? 'Platform account' : undefined}
                      badge={row.configured ? <Badge variant="good">Configured</Badge> : <Badge variant="secondary">Not connected</Badge>}
                    />
                  ))
                )}
              </BankSection>
            </>
          )}
        </div>
      )}

      <HttpCredentialDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        requestUrl=""
        requestMethod="GET"
        editableUrl
        onSaved={(credential) => {
          setHttp((current) => [...current.filter((row) => row.id !== credential.id), credential])
          toast.success(`${credential.name} saved — pick it in any HTTP step.`)
        }}
      />

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{deleteTarget?.name}”?</DialogTitle>
            <DialogDescription>
              Any flow step using this credential will stop authenticating until another credential is selected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={Boolean(deleteTarget && busyId === deleteTarget.id)}
              onClick={() => deleteTarget && void removeCredential(deleteTarget)}
            >
              Delete credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function BankSection({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground/80">{hint}</p>
        </div>
        {action}
      </div>
      <div className="divide-y divide-border/60 rounded-lg border border-border/60">{children}</div>
    </section>
  )
}

function BankEmpty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-sm text-muted-foreground">{children}</p>
}

function BankRow({
  logoSlug,
  name,
  detail,
  badge,
  actions,
}: {
  logoSlug?: string | null
  name: string
  detail?: string
  badge: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <IntegrationLogo slug={logoSlug ?? undefined} name={name} className="h-7 w-7 shrink-0 rounded-md border border-border/60 bg-white p-1" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
      <span className="shrink-0">{badge}</span>
    </div>
  )
}
