'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Nango, { type ConnectUI } from '@nangohq/frontend'
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Pagination, paginate } from '@/components/ui/pagination'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { useCachedJson } from '@/lib/client/use-cached-json'

/** Integration cards per page — mirrors the Templates library grid. */
const PAGE_SIZE = 9

type Integration = {
  id: string
  provider: string
  name: string
  logo?: string
  // Agent tools wired for this integration's Nango config key. 0 = connectable
  // but no agent tool resolves it; undefined only from a pre-upgrade cache.
  toolCount?: number
}

type AiMatch = { id: string; reason: string }

type Connection = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
  verifiedAt?: string
}

export function OAuthIntegrationsGrid() {
  // Cached (stale-while-revalidate): the integration catalog is static (also
  // server-cached), connections revalidate in the background. A revisit paints
  // the last-seen grid instantly instead of the loading skeleton.
  const { data: integrationsData, loading: loadingIntegrations, refresh: refreshIntegrations } =
    useCachedJson<{ integrations?: Integration[] }>('/api/nango/integrations')
  const { data: statusData, loading: loadingStatus, refresh: refreshStatus } =
    useCachedJson<{ connections?: Record<string, Connection> }>('/api/nango/status')
  const integrations = useMemo(() => integrationsData?.integrations ?? [], [integrationsData])
  const connections = statusData?.connections ?? {}
  const loading = loadingIntegrations || loadingStatus
  const [busy, setBusy] = useState<string | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)
  const connectUIRef = useRef<ConnectUI | null>(null)

  // Search + AI finder (mirrors the Templates library): the box filters by
  // name; Enter / "Ask AI" asks the model which integrations fit a stated goal.
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [aiResults, setAiResults] = useState<AiMatch[] | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const aiSeq = useRef(0)

  const q = search.trim().toLowerCase()
  const filtered = useMemo(
    () => (!q ? integrations : integrations.filter((i) => `${i.name} ${i.provider}`.toLowerCase().includes(q))),
    [integrations, q],
  )
  const onSearch = (value: string) => {
    setSearch(value)
    setPage(1)
  }

  const runAiSearch = async () => {
    const goal = search.trim()
    if (goal.length < 3 || aiLoading || !integrations.length) return
    const seq = ++aiSeq.current
    setAiResults([])
    setAiError(null)
    setAiLoading(true)
    try {
      const res = await fetch('/api/integrations/ai-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: goal, items: integrations.map((i) => ({ id: i.id, name: i.name, provider: i.provider })) }),
      })
      const data = await res.json().catch(() => ({}))
      if (seq !== aiSeq.current) return
      if (!res.ok) setAiError(data.error || 'Could not find integrations for that goal.')
      else setAiResults(data.matches || [])
    } catch {
      if (seq === aiSeq.current) setAiError('Could not find integrations for that goal.')
    } finally {
      if (seq === aiSeq.current) setAiLoading(false)
    }
  }

  const closeAiResults = () => {
    aiSeq.current++
    setAiResults(null)
    setAiError(null)
    setAiLoading(false)
  }

  const refreshAll = useCallback(() => {
    void refreshIntegrations()
    void refreshStatus()
  }, [refreshIntegrations, refreshStatus])

  useEffect(() => {
    return () => {
      connectUIRef.current?.close()
      connectUIRef.current = null
    }
  }, [])

  const { pageItems, pageCount, page: currentPage } = paginate(filtered, page, PAGE_SIZE)

  const verify = async (integration: Integration) => {
    setVerifying(integration.id)
    try {
      const response = await fetch(
        `/api/nango/connections/${encodeURIComponent(integration.id)}/verify`,
        { method: 'POST' },
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || `Verification failed (HTTP ${response.status}).`)
      }
      toast.success(`${integration.name} credentials verified`)
      await refreshStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Provider credentials could not be verified.')
      await refreshStatus()
    } finally {
      setVerifying(null)
      setBusy(null)
    }
  }

  const connect = async (integration: Integration) => {
    setBusy(integration.id)
    try {
      const nango = new Nango()
      const connectBaseUrl = process.env.NEXT_PUBLIC_NANGO_CONNECT_URL
      const connectUI = nango.openConnectUI({
        ...(connectBaseUrl ? { baseURL: connectBaseUrl } : {}),
        onEvent: (event) => {
          if (event.type === 'connect') {
            toast.message(`${integration.name} connected — verifying credentials…`)
            connectUIRef.current = null
            window.setTimeout(() => void verify(integration), 400)
          } else if (event.type === 'close') {
            connectUIRef.current = null
            setBusy(null)
          } else if (event.type === 'error') {
            toast.error(event.payload.errorMessage || 'Unable to connect account')
            setBusy(null)
          }
        },
      })
      connectUIRef.current = connectUI

      const response = await fetch('/api/nango/session-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: integration.id }),
      })
      const data = await response.json()
      if (!response.ok || !data.sessionToken) {
        connectUI.close()
        connectUIRef.current = null
        throw new Error(data.error || 'Unable to start the connection flow')
      }
      connectUI.setSessionToken(data.sessionToken)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to connect account')
      setBusy(null)
    }
  }

  const disconnect = async (integration: Integration) => {
    if (!window.confirm(`Disconnect ${integration.name}?`)) return
    setBusy(integration.id)
    try {
      const response = await fetch(`/api/nango/connections/${encodeURIComponent(integration.id)}`, { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to disconnect account')
      await refreshStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to disconnect account')
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Search + AI finder — mirrors the Templates library. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runAiSearch() }}
            placeholder="Describe what you want to accomplish — press Enter for AI matches…"
            className="h-11 w-full pr-28"
          />
          <button
            type="button"
            disabled={search.trim().length < 3 || aiLoading || !integrations.length}
            onClick={runAiSearch}
            className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:pointer-events-none disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {aiLoading ? 'Asking…' : 'Ask AI'}
          </button>
        </div>
        <Button variant="outline" size="icon" onClick={refreshAll} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {aiResults !== null && (
        <div className="space-y-3 rounded-xl border border-indigo-200/60 bg-indigo-50/40 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-300" />
              <h3 className="text-sm font-semibold">AI suggestions</h3>
            </div>
            <button type="button" aria-label="Dismiss AI suggestions" onClick={closeAiResults} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          {aiLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Finding integrations for your goal…
            </div>
          ) : aiError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{aiError}</p>
          ) : aiResults.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No integrations match that goal yet.</p>
          ) : (
            <div className="space-y-2">
              {aiResults.map((match) => {
                const item = integrations.find((i) => i.id === match.id)
                if (!item) return null
                const connection = connections[item.id]
                return (
                  <div key={match.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card p-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <IntegrationLogo src={item.logo} slug={item.provider} name={item.name} />
                      <div className="min-w-0">
                        <span className="truncate text-sm font-medium">{item.name}</span>
                        <p className="text-xs italic text-muted-foreground">{match.reason}</p>
                      </div>
                    </div>
                    {connection?.connected ? (
                      <Badge variant={connection.verifiedAt ? 'good' : 'warn'}>
                        {connection.verifiedAt ? <ShieldCheck className="mr-1 h-3 w-3" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                        {connection.verifiedAt ? 'Verified' : 'Verify'}
                      </Badge>
                    ) : (
                      <Button size="sm" onClick={() => connect(item)} loading={busy === item.id}>Connect</Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {!filtered.length && !loading && (
        <EmptyState
          title={q ? 'No integrations match your search' : 'No integrations are enabled yet'}
          description={q ? 'Try a different name, or ask AI what fits your goal.' : 'Enable integrations in your Nango dashboard and they appear here.'}
        />
      )}

      <div className="stagger-children grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {pageItems.map((integration) => {
          const connection = connections[integration.id]
          return (
            <Card key={integration.id} variant="interactive">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3 text-base">
                  <span className="flex items-center gap-2">
                    <IntegrationLogo src={integration.logo} slug={integration.provider} name={integration.name} />
                    {integration.name}
                  </span>
                  {connection?.connected ? (
                    <Badge variant={connection.verifiedAt ? 'good' : 'warn'}>
                      {connection.verifiedAt ? <ShieldCheck className="mr-1 h-3 w-3" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                      {connection.verifiedAt ? 'Verified' : 'Unverified'}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Not connected</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="line-clamp-2 min-h-10 text-sm text-gray-500">
                  Connect your {integration.name} account so agents can act on your behalf.
                  {integration.toolCount
                    ? ` ${integration.toolCount} agent tool${integration.toolCount === 1 ? '' : 's'} available.`
                    : ''}
                </p>
                {connection?.error && <p className="text-sm text-red-600">{connection.error}</p>}
                {connection?.connected
                  ? <div className="grid grid-cols-2 gap-2">
                      <Button
                        className="w-full"
                        variant={connection.verifiedAt ? 'outline' : 'default'}
                        onClick={() => verify(integration)}
                        loading={verifying === integration.id}
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {connection.verifiedAt ? 'Verify again' : 'Verify'}
                      </Button>
                      <Button className="w-full" variant="outline" onClick={() => disconnect(integration)} loading={busy === integration.id}>Disconnect</Button>
                    </div>
                  : <Button className="w-full" onClick={() => connect(integration)} loading={busy === integration.id}>
                      Connect
                    </Button>}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
    </div>
  )
}
