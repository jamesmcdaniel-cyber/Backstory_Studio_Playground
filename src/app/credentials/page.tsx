'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Plus, RefreshCw, RotateCw, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { WorkspaceCredentialsPanel } from '@/components/integrations/workspace-credentials-panel'
import {
  HttpCredentialDialog,
  HTTP_AUTH_OPTIONS,
  type HttpCredentialSummary,
} from '@/components/flows/http-credential-dialog'
import { useAuth } from '@/hooks/use-auth'
import { useNangoConnect } from '@/lib/client/use-nango-connect'

/**
 * The workspace's credential surface — everything a flow or agent can
 * authenticate with, fully manageable from one page. This replaced the
 * collapsible read-mostly bank on /flows: expired credentials are fixed in
 * place (verify / reconnect / re-verify), and an exposed or leaked credential
 * is rotated here without touching any flow — OAuth accounts revoke stored
 * tokens then re-run consent, HTTP credentials take fresh secrets behind the
 * same id, workspace keys are replaced in the panel below.
 *
 * Every list endpoint is redacted and flow.read, so all members can audit
 * status; mutations are integration.manage (ADMIN+) and the write affordances
 * hide for everyone else.
 */

/** Mirrors the Settings panel's provider list (workspace-credentials-panel.tsx). */
const WORKSPACE_KEY_PROVIDERS = ['slack', 'email', 'granola'] as const

type OauthRow = {
  key: string
  provider: string
  name: string
  logo?: string
  connected: boolean
  verifiedAt?: string
  error?: string
}

type CatalogIntegration = {
  id: string
  provider: string
  name: string
  logo?: string
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

type OauthConfirm = { kind: 'rotate' | 'disconnect'; row: OauthRow }

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

export default function CredentialsPage() {
  const { can } = useAuth()
  const canManage = can('integration.manage')

  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [oauth, setOauth] = useState<OauthRow[]>([])
  const [mcp, setMcp] = useState<McpConnection[]>([])
  const [http, setHttp] = useState<HttpCredentialSummary[]>([])
  const [keys, setKeys] = useState<WorkspaceKey[]>([])

  const [createOpen, setCreateOpen] = useState(false)
  const [rotateHttpTarget, setRotateHttpTarget] = useState<HttpCredentialSummary | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<HttpCredentialSummary | null>(null)
  const [oauthConfirm, setOauthConfirm] = useState<OauthConfirm | null>(null)
  const [oauthConfirmBusy, setOauthConfirmBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [nango, catalog, servers, credentials, ...keyStates] = await Promise.all([
      fetchJson('/api/nango/status'),
      fetchJson('/api/nango/integrations'),
      fetchJson('/api/mcp-connections'),
      fetchJson('/api/http-credentials'),
      ...WORKSPACE_KEY_PROVIDERS.map((provider) => fetchJson(`/api/integrations/credentials/${provider}`)),
    ])
    const connections = (nango?.connections ?? {}) as Record<
      string,
      { provider?: string; connected?: boolean; error?: string; verifiedAt?: string }
    >
    const integrations = Array.isArray(catalog?.integrations) ? (catalog.integrations as CatalogIntegration[]) : []
    const byId = new Map(integrations.map((integration) => [integration.id, integration]))
    setOauth(
      Object.entries(connections).map(([key, status]) => ({
        key,
        provider: status.provider ?? key,
        name: byId.get(key)?.name ?? key,
        logo: byId.get(key)?.logo,
        connected: Boolean(status.connected),
        verifiedAt: status.verifiedAt,
        error: status.error,
      })),
    )
    setMcp(Array.isArray(servers?.connections) ? (servers.connections as McpConnection[]) : [])
    setHttp(Array.isArray(credentials?.credentials) ? (credentials.credentials as HttpCredentialSummary[]) : [])
    setKeys(keyStates.flatMap((state) => (state?.provider ? [state as unknown as WorkspaceKey] : [])))
    setLoading(false)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Reconnect reuses the shared Nango round-trip: opening the Connect UI over
  // an existing connection re-runs consent and stores fresh tokens.
  const { busy: nangoBusy, verifying, connect, verify } = useNangoConnect(load)

  const deleteOauthConnection = useCallback(async (row: OauthRow) => {
    const response = await fetch(`/api/nango/connections/${encodeURIComponent(row.key)}`, { method: 'DELETE' })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      writeErrorToast(data, response.status)
      return false
    }
    return true
  }, [])

  const runOauthConfirm = useCallback(async () => {
    if (!oauthConfirm) return
    const { kind, row } = oauthConfirm
    setOauthConfirmBusy(true)
    try {
      const deleted = await deleteOauthConnection(row)
      if (!deleted) return
      setOauthConfirm(null)
      if (kind === 'rotate') {
        toast.message(`${row.name} tokens revoked — sign in again to issue fresh ones.`)
        // connect() reloads status via its verify step once the consent completes.
        void connect({ id: row.key, name: row.name })
      } else {
        toast.success(`${row.name} disconnected.`)
        await load()
      }
    } finally {
      setOauthConfirmBusy(false)
    }
  }, [connect, deleteOauthConnection, load, oauthConfirm])

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

  const summary = useMemo(
    () =>
      loaded ? (
        <span className="flex items-center gap-1.5">
          <Badge variant="good">{connectedCount} connected</Badge>
          {attentionCount > 0 && <Badge variant="warn">{attentionCount} need attention</Badge>}
        </span>
      ) : null,
    [attentionCount, connectedCount, loaded],
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          eyebrow="Workspace"
          title="Credentials"
          description="Connect once — every flow and agent reuses these. Fix an expired credential or rotate a leaked one right here."
        />
        <div className="flex items-center gap-3">
          {summary}
          <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading} aria-label="Refresh credentials">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
        </div>
      </div>

      {!canManage && loaded && (
        <p className="text-sm text-muted-foreground">
          You can review credential health here — only workspace admins can connect, rotate, or remove credentials.
        </p>
      )}

      {loading && !loaded ? (
        <div className="space-y-2">
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-10 rounded-lg" />
        </div>
      ) : (
        <>
          <CredentialSection
            title="App accounts"
            hint="OAuth accounts flows use through Tool steps. Reconnect renews expired tokens; rotate revokes them first — use it when a token may have leaked."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/integrations">
                  Connect new <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            }
          >
            {oauth.length === 0 ? (
              <SectionEmpty>No app accounts connected yet — connect Slack, Gmail, Salesforce and more in Integrations.</SectionEmpty>
            ) : (
              oauth.map((row) => (
                <CredentialRow
                  key={row.key}
                  logoSrc={row.logo}
                  logoSlug={row.provider}
                  name={row.name}
                  detail={row.error}
                  badge={
                    row.connected ? (
                      <Badge variant={row.verifiedAt ? 'good' : 'warn'}>{row.verifiedAt ? 'Verified' : 'Unverified'}</Badge>
                    ) : (
                      <Badge variant="warn">Needs reconnect</Badge>
                    )
                  }
                  actions={
                    canManage && (
                      <>
                        {row.connected && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void verify({ id: row.key, name: row.name })}
                            loading={verifying === row.key}
                            title="Check the stored tokens still work"
                          >
                            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Verify
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void connect({ id: row.key, name: row.name })}
                          loading={nangoBusy === row.key}
                          title="Sign in again to renew expired or revoked tokens"
                        >
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reconnect
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setOauthConfirm({ kind: 'rotate', row })}
                          disabled={nangoBusy === row.key}
                          title="Revoke the stored tokens, then sign in to issue fresh ones — for exposed or leaked tokens"
                        >
                          <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Rotate
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => setOauthConfirm({ kind: 'disconnect', row })}
                          disabled={nangoBusy === row.key}
                          aria-label={`Disconnect ${row.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )
                  }
                />
              ))
            )}
          </CredentialSection>

          <CredentialSection
            title="HTTP credentials"
            hint="Reusable auth for HTTP request steps, bound to the host they were verified against. Rotate re-enters the secrets behind the same credential, so no step needs re-wiring."
            action={
              canManage && (
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> New credential
                </Button>
              )
            }
          >
            {http.length === 0 ? (
              <SectionEmpty>No HTTP credentials yet — add one here or from any HTTP step, then reuse it everywhere.</SectionEmpty>
            ) : (
              http.map((row) => (
                <CredentialRow
                  key={row.id}
                  logoSlug={row.allowedHost.split('.').slice(-2, -1)[0]}
                  name={row.name}
                  detail={`${row.allowedHost} · ${AUTH_TYPE_LABEL[row.authType] ?? row.authType}${row.status !== 'verified' && row.lastError ? ` — ${row.lastError}` : ''}`}
                  badge={row.status === 'verified' ? <Badge variant="good">Verified</Badge> : <Badge variant="warn">Needs attention</Badge>}
                  actions={
                    canManage && (
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
                          onClick={() => setRotateHttpTarget(row)}
                          disabled={busyId === row.id}
                          title="Replace the stored secrets with fresh ones — for exposed or leaked secrets"
                        >
                          <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Rotate
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
                    )
                  }
                />
              ))
            )}
          </CredentialSection>

          <CredentialSection
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
              <SectionEmpty>No MCP servers connected.</SectionEmpty>
            ) : (
              mcp.map((row) => (
                <CredentialRow
                  key={row.id}
                  logoSlug={row.provider ?? row.name}
                  name={row.name}
                  detail={hostOf(row.serverUrl) + (row.userId ? ' · personal' : '')}
                  badge={row.isActive ? <Badge variant="good">Active</Badge> : <Badge variant="warn">Inactive</Badge>}
                />
              ))
            )}
          </CredentialSection>

          <section className="space-y-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workspace keys</h3>
              <p className="text-xs text-muted-foreground/80">
                API keys shared by the whole workspace — verified when saved, encrypted at rest, never shown again. Rotate one
                by pasting its replacement.
              </p>
            </div>
            <WorkspaceCredentialsPanel />
          </section>
        </>
      )}

      <HttpCredentialDialog
        open={createOpen || Boolean(rotateHttpTarget)}
        onOpenChange={(next) => {
          if (!next) {
            setCreateOpen(false)
            setRotateHttpTarget(null)
          }
        }}
        requestUrl=""
        requestMethod="GET"
        editableUrl
        rotateCredential={rotateHttpTarget}
        onSaved={(credential) => {
          setHttp((current) => [...current.filter((row) => row.id !== credential.id), credential])
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

      <Dialog open={Boolean(oauthConfirm)} onOpenChange={(next) => !next && !oauthConfirmBusy && setOauthConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {oauthConfirm?.kind === 'rotate'
                ? `Rotate ${oauthConfirm.row.name} credentials?`
                : `Disconnect ${oauthConfirm?.row.name}?`}
            </DialogTitle>
            <DialogDescription>
              {oauthConfirm?.kind === 'rotate'
                ? 'The stored tokens are revoked immediately, then the sign-in reopens so fresh ones are issued. Flows using this account pause until you finish signing in.'
                : 'The stored tokens are revoked and flows using this account stop authenticating until it is connected again.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOauthConfirm(null)} disabled={oauthConfirmBusy}>Cancel</Button>
            <Button
              variant={oauthConfirm?.kind === 'rotate' ? 'default' : 'destructive'}
              loading={oauthConfirmBusy}
              onClick={() => void runOauthConfirm()}
            >
              {oauthConfirm?.kind === 'rotate' ? 'Revoke & sign in again' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function CredentialSection({
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
      <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card">{children}</div>
    </section>
  )
}

function SectionEmpty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-sm text-muted-foreground">{children}</p>
}

function CredentialRow({
  logoSrc,
  logoSlug,
  name,
  detail,
  badge,
  actions,
}: {
  logoSrc?: string
  logoSlug?: string | null
  name: string
  detail?: string
  badge: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2">
      <IntegrationLogo src={logoSrc} slug={logoSlug ?? undefined} name={name} className="h-7 w-7 shrink-0 rounded-md border border-border/60 bg-white p-1" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
      <span className="shrink-0">{badge}</span>
    </div>
  )
}
