'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, RefreshCw, RotateCw, Trash2 } from 'lucide-react'
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
import type { CredentialDependent } from '@/lib/credentials/dependents'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { ScopeBadge, type ScopeReviewView } from '@/components/integrations/scope-badge'
import { StalenessBadge } from '@/components/integrations/staleness-badge'
import { N8nConnectDialog } from '@/components/integrations/n8n-connect-dialog'
import {
  ConnectIntegrationDialog,
  type ConnectableIntegration,
} from '@/components/integrations/connect-integration-dialog'
import {
  McpConnectionDialog,
  draftAuthPayload,
  type McpConnectionDraft,
  type SerializedConnection,
} from '@/app/connections/mcp-connection-dialog'
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
 * place (reconnect / re-verify), and an exposed or leaked credential
 * is rotated here without touching any flow — OAuth accounts revoke stored
 * tokens then re-run consent, HTTP credentials take fresh secrets behind the
 * same id.
 *
 * Deliberately absent: workspace-shared API keys. Agents act on behalf of the
 * user who connected them, never a shared workspace identity.
 *
 * Every list endpoint is redacted and flow.read, so all members can audit
 * status; mutations are integration.manage (ADMIN+) and the write affordances
 * hide for everyone else.
 */

type OauthRow = {
  key: string
  provider: string
  name: string
  logo?: string
  connected: boolean
  verifiedAt?: string
  error?: string
  /** Scope review from the mirror; see components/integrations/scope-badge. */
  scopes?: ScopeReviewView
}

type CatalogIntegration = ConnectableIntegration

// The list endpoint serialises the full connection (auth mode included), plus
// userId for the personal-vs-workspace marker.
type McpRow = SerializedConnection & { userId?: string | null }

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
  const [catalog, setCatalog] = useState<CatalogIntegration[]>([])
  const [mcp, setMcp] = useState<McpRow[]>([])
  const [http, setHttp] = useState<HttpCredentialSummary[]>([])

  const [connectOpen, setConnectOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [n8nOpen, setN8nOpen] = useState(false)
  const [rotateHttpTarget, setRotateHttpTarget] = useState<HttpCredentialSummary | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<HttpCredentialSummary | null>(null)
  // What would break, fetched when the confirm opens. Null = still looking.
  const [dependents, setDependents] = useState<{ summary: string; items: CredentialDependent[] } | null>(null)
  useEffect(() => {
    if (!deleteTarget) { setDependents(null); return }
    let cancelled = false
    setDependents(null)
    void fetch(`/api/credentials/dependents?kind=http_credential&ref=${encodeURIComponent(deleteTarget.id)}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        setDependents(
          data?.success
            ? { summary: data.summary as string, items: (data.dependents ?? []) as CredentialDependent[] }
            // A failed check must not read as "nothing uses this" — that is the
            // reassuring answer, and it is the one we do not have.
            : { summary: 'Could not check what uses this credential. Delete only if you are sure.', items: [] },
        )
      })
      .catch(() => {
        if (!cancelled) setDependents({ summary: 'Could not check what uses this credential. Delete only if you are sure.', items: [] })
      })
    return () => { cancelled = true }
  }, [deleteTarget])
  const [oauthConfirm, setOauthConfirm] = useState<OauthConfirm | null>(null)
  const [oauthConfirmBusy, setOauthConfirmBusy] = useState(false)
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false)
  const [mcpEditing, setMcpEditing] = useState<McpRow | null>(null)
  const [mcpDeleteTarget, setMcpDeleteTarget] = useState<McpRow | null>(null)
  const [mcpBusyId, setMcpBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [nango, catalogData, servers, credentials] = await Promise.all([
      fetchJson('/api/nango/status'),
      fetchJson('/api/nango/integrations'),
      fetchJson('/api/mcp-connections'),
      fetchJson('/api/http-credentials'),
    ])
    const connections = (nango?.connections ?? {}) as Record<
      string,
      { provider?: string; connected?: boolean; error?: string; verifiedAt?: string; scopes?: ScopeReviewView }
    >
    const integrations = Array.isArray(catalogData?.integrations) ? (catalogData.integrations as CatalogIntegration[]) : []
    const byId = new Map(integrations.map((integration) => [integration.id, integration]))
    setCatalog(integrations)
    setOauth(
      Object.entries(connections).map(([key, status]) => ({
        key,
        provider: status.provider ?? key,
        name: byId.get(key)?.name ?? key,
        logo: byId.get(key)?.logo,
        connected: Boolean(status.connected),
        verifiedAt: status.verifiedAt,
        error: status.error,
        scopes: status.scopes,
      })),
    )
    setMcp(Array.isArray(servers?.connections) ? (servers.connections as McpRow[]) : [])
    setHttp(Array.isArray(credentials?.credentials) ? (credentials.credentials as HttpCredentialSummary[]) : [])
    setLoading(false)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Reconnect reuses the shared Nango round-trip: opening the Connect UI over
  // an existing connection re-runs consent and stores fresh tokens.
  const { busy: nangoBusy, connect } = useNangoConnect(load)

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

  // Catalog entries with no live connection — what the connect picker offers.
  // A "needs reconnect" account keeps its row (and Reconnect button) above, so
  // it stays out of the picker to avoid two competing entry points.
  const accountIds = useMemo(() => new Set(oauth.map((row) => row.key)), [oauth])
  const connectable = useMemo(
    () => catalog.filter((integration) => !accountIds.has(integration.id)),
    [accountIds, catalog],
  )

  const saveMcpConnection = async (draft: McpConnectionDraft) => {
    // Omit blank secret fields on edit — the server preserves the stored
    // encrypted secrets for omitted fields.
    const payload: Record<string, unknown> = {
      name: draft.name,
      description: draft.description || undefined,
      serverUrl: draft.serverUrl,
      ...draftAuthPayload(draft),
    }
    if (mcpEditing) payload.id = mcpEditing.id

    const response = await fetch('/api/mcp-connections', {
      method: mcpEditing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      writeErrorToast(data, response.status)
      throw new Error((data as { error?: string })?.error || 'Failed to save the server.')
    }
    toast.success(mcpEditing ? 'Server updated.' : 'Server added.')
    setMcpEditing(null)
    await load()
  }

  const removeMcpConnection = async (row: McpRow) => {
    setMcpBusyId(row.id)
    try {
      const response = await fetch('/api/mcp-connections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id }),
      })
      const data = await response.json().catch(() => null)
      if (response.ok) {
        toast.success(`${row.name} removed.`)
        await load()
      } else {
        writeErrorToast(data, response.status)
      }
    } finally {
      setMcpBusyId(null)
      setMcpDeleteTarget(null)
    }
  }

  const connectedCount =
    oauth.filter((row) => row.connected).length +
    mcp.filter((row) => row.isActive).length +
    http.filter((row) => row.status === 'verified').length
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
      <div className="space-y-3">
        {/* Reached only from /flows (no sidebar entry), so the page always
            offers the way back to where the journey started. */}
        <Link href="/flows" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to flows
        </Link>
        <div className="flex items-start justify-between gap-4">
          <PageHeader
            eyebrow="Flows"
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
              canManage && (
                <Button variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Connect new
                </Button>
              )
            }
          >
            {oauth.length === 0 ? (
              <SectionEmpty>No app accounts connected yet — connect Slack, Gmail, Salesforce and more with Connect new.</SectionEmpty>
            ) : (
              oauth.map((row) => (
                <CredentialRow
                  key={row.key}
                  logoSrc={row.logo}
                  logoSlug={row.provider}
                  name={row.name}
                  detail={row.error}
                  badge={
                    <span className="flex items-center gap-1.5">
                      {row.connected ? (
                        <Badge variant={row.verifiedAt ? 'good' : 'warn'}>{row.verifiedAt ? 'Verified' : 'Unverified'}</Badge>
                      ) : (
                        <Badge variant="warn">Needs reconnect</Badge>
                      )}
                      {/* What this account can actually DO, next to whether it
                          works — the two questions are always asked together. */}
                      <ScopeBadge review={row.scopes} />
                    </span>
                  }
                  actions={
                    canManage && (
                      <>
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
                <span className="flex items-center gap-2">
                  {/* Preset over the same store: the saved row IS an HTTP
                      credential, this just spares people knowing the header
                      name. Exists so n8n workflow URLs import directly. */}
                  <Button variant="outline" size="sm" onClick={() => setN8nOpen(true)}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" /> Connect n8n
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" /> New credential
                  </Button>
                </span>
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
                  badge={
                    <span className="flex items-center gap-1.5">
                      {row.status === 'verified' ? <Badge variant="good">Verified</Badge> : <Badge variant="warn">Needs attention</Badge>}
                      {/* An unowned credential is one that no offboarding can
                          revoke and no audit entry can attribute to a person.
                          Flagged rather than auto-assigned: guessing an owner
                          would put someone's name on actions they never took. */}
                      {row.isSharedLegacy && (
                        <Badge variant="warn" title="Shared by the whole workspace — recreate it so it has an owner">
                          Unowned
                        </Badge>
                      )}
                      {/* Silent while the credential is fresh — a badge on every
                          row is wallpaper, and wallpaper is how an unrotated
                          two-year-old secret stayed invisible. */}
                      <StalenessBadge staleness={row.staleness} />
                    </span>
                  }
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
              canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMcpEditing(null)
                    setMcpDialogOpen(true)
                  }}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add server
                </Button>
              )
            }
          >
            {mcp.length === 0 ? (
              <SectionEmpty>No MCP servers connected.</SectionEmpty>
            ) : (
              mcp.map((row) => {
                // Platform-managed rows (the native Backstory server) and SSO
                // connections reconnect through the OAuth redirect; everything
                // else re-enters its secrets in the edit dialog, which
                // re-verifies on save.
                const reconnectsViaOauth = Boolean(row.provider) || row.auth?.flow === 'authcode'
                return (
                  <CredentialRow
                    key={row.id}
                    logoSlug={row.provider ?? row.name}
                    name={row.name}
                    detail={hostOf(row.serverUrl) + (row.userId ? ' · personal' : '')}
                    badge={
                      <span className="flex items-center gap-1.5">
                        {row.isActive ? (
                          <Badge variant="good">Active</Badge>
                        ) : (
                          <Badge variant="warn">{row.provider ? 'Needs authorization' : 'Inactive'}</Badge>
                        )}
                        {/* Only for authenticated servers — an unauthenticated
                            MCP server holds no grant to review. */}
                        {row.auth?.authType !== 'none' && <ScopeBadge review={row.scopes} />}
                      </span>
                    }
                    actions={
                      canManage && (
                        <>
                          {reconnectsViaOauth ? (
                            <Button asChild variant="ghost" size="sm" title="Re-run authorization to renew the server's tokens">
                              <a href={`/api/mcp-connections/oauth/start?connectionId=${encodeURIComponent(row.id)}&returnTo=%2Fcredentials`}>
                                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reconnect
                              </a>
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setMcpEditing(row)
                                setMcpDialogOpen(true)
                              }}
                              title="Re-enter the server's credentials — saving verifies the connection"
                            >
                              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reconnect
                            </Button>
                          )}
                          {/* The native Backstory server is platform-managed and can
                              never be deleted — the API refuses too. */}
                          {!row.provider && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:text-red-700"
                              onClick={() => setMcpDeleteTarget(row)}
                              disabled={mcpBusyId === row.id}
                              aria-label={`Delete ${row.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </>
                      )
                    }
                  />
                )
              })
            )}
          </CredentialSection>
        </>
      )}

      <ConnectIntegrationDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        integrations={connectable}
        busy={nangoBusy}
        onConnect={(integration) => void connect({ id: integration.id, name: integration.name })}
      />

      <McpConnectionDialog
        open={mcpDialogOpen}
        onOpenChange={(next) => {
          setMcpDialogOpen(next)
          if (!next) setMcpEditing(null)
        }}
        onSave={saveMcpConnection}
        editingConnection={mcpEditing}
        returnTo="/credentials"
      />

      <Dialog open={Boolean(mcpDeleteTarget)} onOpenChange={(next) => !next && setMcpDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{mcpDeleteTarget?.name}”?</DialogTitle>
            <DialogDescription>
              Agents and HTTP steps using this server's tools lose access until it is connected again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMcpDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={Boolean(mcpDeleteTarget && mcpBusyId === mcpDeleteTarget.id)}
              onClick={() => mcpDeleteTarget && void removeMcpConnection(mcpDeleteTarget)}
            >
              Delete server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <N8nConnectDialog open={n8nOpen} onOpenChange={setN8nOpen} onSaved={() => void load()} />
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
              {/* Named, not generalised: "any flow step using this" is true of
                  every credential and tells the reader nothing about THIS one.
                  The list is what makes the decision. */}
              {dependents === null
                ? 'Checking what uses this credential…'
                : dependents.summary}
            </DialogDescription>
          </DialogHeader>
          {dependents && dependents.items.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 text-sm">
              {dependents.items.map((item) => (
                <li key={`${item.type}-${item.id}`} className="flex items-center gap-2">
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                      item.type === 'flow' && item.published
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-slate-200 text-slate-700',
                    )}
                  >
                    {item.type === 'flow' ? (item.published ? 'Live' : 'Draft') : 'Agent'}
                  </span>
                  <span className="truncate">{item.name}</span>
                </li>
              ))}
            </ul>
          )}
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
