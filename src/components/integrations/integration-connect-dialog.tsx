'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { McpConnectionDialog, type McpConnectionDraft, type SerializedConnection } from '@/app/connections/mcp-connection-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { IntegrationMark } from '@/components/integrations/integration-chip'
import { classifyRequirements, type CatalogEntry, type Requirement } from '@/components/integrations/integration-match'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { useNangoConnect } from '@/lib/client/use-nango-connect'
import { cn } from '@/lib/utils'

/**
 * Connect a template's requirements without leaving the template.
 *
 * The old flow sent people to /integrations to hunt for the right card among
 * dozens, then find their way back. This shows exactly the integrations THIS
 * template names, with live status, and runs the real connect flow in place —
 * Nango's Connect UI for OAuth providers, the MCP server form for MCP ones.
 *
 * Both of those mount their own overlays, so this dialog hides itself while one
 * is up (a Radix focus trap would otherwise make them unclickable) and comes
 * back with refreshed status once the user is done.
 */

const CATALOG_URL = '/api/nango/integrations'
const STATUS_URL = '/api/nango/status'

type Connection = { connected: boolean; provider: string; error?: string; verifiedAt?: string }

export function IntegrationConnectDialog({
  open,
  onOpenChange,
  names,
  title = 'Connect what this template needs',
  description = 'Each one is connected here — you don’t have to go find it on the integrations page.',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Raw integration names as the template declares them ("nango:salesforce"). */
  names: string[]
  title?: string
  description?: string
}) {
  // Only start fetching once the dialog has actually been opened: /api/nango/status
  // is a live Nango round-trip, too expensive to fire on every template view.
  const [activated, setActivated] = useState(false)
  useEffect(() => {
    if (open) setActivated(true)
  }, [open])

  const { data: catalogData, refresh: refreshCatalog } = useCachedJson<{ integrations?: CatalogEntry[] }>(
    activated ? CATALOG_URL : null,
  )
  const { data: statusData, error: statusError, refresh: refreshStatus } = useCachedJson<{
    connections?: Record<string, Connection>
  }>(activated ? STATUS_URL : null)
  // Status is genuinely unknown until the first response lands — a failed fetch
  // resolves to "not connected" rather than spinning forever.
  const statusUnknown = !statusData && !statusError

  const catalog = useMemo(() => catalogData?.integrations ?? [], [catalogData])
  const connections = useMemo<Record<string, Connection>>(() => statusData?.connections ?? {}, [statusData])

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshCatalog(), refreshStatus()])
  }, [refreshCatalog, refreshStatus])

  const { busy, verifying, overlayActive, connect, verify } = useNangoConnect(refreshAll)

  // MCP servers are a separate connection type with their own endpoint.
  const [mcpServers, setMcpServers] = useState<SerializedConnection[]>([])
  const [mcpDraftFor, setMcpDraftFor] = useState<string | null>(null)
  const loadMcp = useCallback(async () => {
    try {
      const response = await fetch('/api/mcp-connections', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      setMcpServers(Array.isArray(data.connections) ? data.connections : [])
    } catch {
      // Non-fatal: MCP rows just render as "not connected" and stay actionable.
    }
  }, [])

  // Re-read status every time the dialog is opened — the user may have connected
  // something in another tab since the cached copy was written.
  useEffect(() => {
    if (!open) return
    void refreshStatus()
    void loadMcp()
  }, [open, refreshStatus, loadMcp])

  const requirements = useMemo(() => classifyRequirements(names, catalog), [names, catalog])

  const mcpConnected = useCallback(
    (requirement: Requirement) => {
      const target = requirement.label.toLowerCase().replace(/[^a-z0-9]/g, '')
      return mcpServers.some((server) => {
        const name = server.name.toLowerCase().replace(/[^a-z0-9]/g, '')
        return server.isActive && (name.includes(target) || target.includes(name))
      })
    },
    [mcpServers],
  )

  const isSatisfied = useCallback(
    (requirement: Requirement) => {
      if (requirement.kind === 'builtin') return true
      if (requirement.kind === 'mcp') return mcpConnected(requirement)
      return requirement.entry ? connections[requirement.entry.id]?.connected === true : false
    },
    [connections, mcpConnected],
  )

  const outstanding = requirements.filter((requirement) => !isSatisfied(requirement)).length

  const saveMcpServer = async (draft: McpConnectionDraft) => {
    const payload: Record<string, unknown> = {
      name: draft.name,
      description: draft.description || undefined,
      serverUrl: draft.serverUrl,
      authType: draft.authType,
    }
    if (draft.authType === 'api_key') {
      if (draft.apiKey) payload.apiKey = draft.apiKey
      if (draft.headerName) payload.headerName = draft.headerName
    }
    if (draft.authType === 'oauth2') {
      if (draft.clientId) payload.clientId = draft.clientId
      if (draft.clientSecret) payload.clientSecret = draft.clientSecret
      if (draft.tokenUrl) payload.tokenUrl = draft.tokenUrl
      if (draft.scopes) payload.scopes = draft.scopes
    }
    const response = await fetch('/api/mcp-connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      const message = data.error || `Failed to save (HTTP ${response.status}).`
      toast.error(message)
      throw new Error(message)
    }
    toast.success('Server added.')
    await loadMcp()
  }

  return (
    <>
      {/* Hidden — not closed — while Nango's Connect UI or the MCP form owns the
          screen, so this dialog's state and the in-flight connection survive. */}
      <Dialog open={open && !overlayActive && mcpDraftFor === null} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="-mx-1 max-h-[60vh] space-y-2 overflow-y-auto px-1">
            {requirements.map((requirement) => (
              <RequirementRow
                key={requirement.name}
                requirement={requirement}
                connection={requirement.entry ? connections[requirement.entry.id] : undefined}
                satisfied={isSatisfied(requirement)}
                loading={statusUnknown && requirement.kind === 'oauth'}
                busy={busy === requirement.entry?.id}
                verifying={verifying === requirement.entry?.id}
                onConnect={() => requirement.entry && connect(requirement.entry)}
                onVerify={() => requirement.entry && verify(requirement.entry)}
                onAddServer={() => setMcpDraftFor(requirement.label)}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
            <p className="text-xs text-muted-foreground">
              {statusUnknown
                ? 'Checking what’s already connected…'
                : outstanding === 0
                  ? 'Everything this template needs is connected.'
                  : `${outstanding} still to connect.`}
            </p>
            <div className="flex items-center gap-2">
              <Link
                href="/integrations"
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                All integrations <ArrowUpRight className="h-3 w-3" />
              </Link>
              <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <McpConnectionDialog
        open={mcpDraftFor !== null}
        onOpenChange={(next) => setMcpDraftFor(next ? mcpDraftFor : null)}
        onSave={saveMcpServer}
        initialName={mcpDraftFor ?? undefined}
      />
    </>
  )
}

function RequirementRow({
  requirement,
  connection,
  satisfied,
  loading,
  busy,
  verifying,
  onConnect,
  onVerify,
  onAddServer,
}: {
  requirement: Requirement
  connection?: Connection
  satisfied: boolean
  loading: boolean
  busy: boolean
  verifying: boolean
  onConnect: () => void
  onVerify: () => void
  onAddServer: () => void
}) {
  const { label, kind, entry } = requirement
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl border p-3 transition-colors',
        satisfied ? 'border-emerald-200/70 bg-emerald-50/50 dark:border-emerald-500/20 dark:bg-emerald-500/5' : 'border-border/60 bg-card',
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <IntegrationMark name={requirement.name} className="h-5 w-5" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {kind === 'builtin'
              ? 'Built in — nothing to connect'
              : connection?.error
                ? connection.error
                : kind === 'mcp'
                  ? satisfied ? 'MCP server connected' : 'Custom MCP server'
                  : !entry
                    ? 'Not offered in this workspace yet'
                    : satisfied
                      ? connection?.verifiedAt ? 'Connected and verified' : 'Connected — not verified yet'
                      : 'Account connection required'}
          </p>
        </div>
      </div>

      <div className="shrink-0">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : kind === 'builtin' ? (
          <Badge variant="secondary">Ready</Badge>
        ) : kind === 'mcp' ? (
          satisfied ? (
            <Badge variant="good"><CheckCircle2 className="mr-1 h-3 w-3" />Connected</Badge>
          ) : (
            <Button size="sm" onClick={onAddServer}>Add server</Button>
          )
        ) : !entry ? (
          <Link
            href="/integrations"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Browse <ArrowUpRight className="h-3 w-3" />
          </Link>
        ) : satisfied ? (
          connection?.verifiedAt ? (
            <Badge variant="good"><ShieldCheck className="mr-1 h-3 w-3" />Verified</Badge>
          ) : (
            <Button size="sm" variant="outline" onClick={onVerify} loading={verifying}>Verify</Button>
          )
        ) : (
          <Button size="sm" onClick={onConnect} loading={busy}>Connect</Button>
        )}
      </div>
    </div>
  )
}
