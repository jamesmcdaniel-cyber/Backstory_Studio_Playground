'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Pagination, paginate } from '@/components/ui/pagination'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { PROVIDER_CONNECT_HINTS } from '@/components/integrations/provider-connect-hints'
import { IntegrationDetailDialog } from '@/components/integrations/integration-detail-dialog'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { useNangoConnect } from '@/lib/client/use-nango-connect'

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

type Connection = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
  verifiedAt?: string
}

/**
 * Whether the SIGNED-IN person is linked to a Slack account, and a retry.
 *
 * "Connected" and "linked" can disagree: captureSlackIdentity runs
 * fire-and-forget from the Nango webhook, so a Slack outage at connect time
 * leaves a working connection with no identity — this grid would say connected
 * while every Slack mention answers "connect your Slack account". This is the
 * only place that reconciles them.
 */
function SlackLinkStatus() {
  const [state, setState] = useState<{ linked: boolean; connected: boolean } | null>(null)
  const [retrying, setRetrying] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/slack/my-identity', { cache: 'no-store' })
      if (response.ok) setState(await response.json())
    } catch {
      // Leave the row absent rather than claiming a state we could not read.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const retry = async () => {
    setRetrying(true)
    try {
      await fetch('/api/slack/my-identity', { method: 'POST' })
      await load()
    } finally {
      setRetrying(false)
    }
  }

  // Nothing to say to someone who has not connected Slack at all — the card
  // below already offers that.
  if (!state?.connected) return null

  return (
    <div className="mb-4 rounded-md border px-3 py-2 text-sm">
      {state.linked ? (
        <span>
          Your Slack account is linked — you can summon agents by mentioning them in Slack.
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <span>
            Slack is connected, but we could not confirm which Slack account is yours, so mentions
            will not run for you yet.
          </span>
          <Button size="sm" variant="outline" onClick={() => void retry()} disabled={retrying}>
            {retrying ? 'Checking…' : 'Retry'}
          </Button>
        </span>
      )}
    </div>
  )
}

export function OAuthIntegrationsGrid({ autoConnect }: { autoConnect?: string | null } = {}) {
  // Cached (stale-while-revalidate): the integration catalog is static (also
  // server-cached), connections revalidate in the background. A revisit paints
  // the last-seen grid instantly instead of the loading skeleton.
  const { data: integrationsData, loading: loadingIntegrations, error: integrationsError, refresh: refreshIntegrations } =
    useCachedJson<{ integrations?: Integration[] }>('/api/nango/integrations')
  const { data: statusData, loading: loadingStatus, refresh: refreshStatus } =
    useCachedJson<{ connections?: Record<string, Connection> }>('/api/nango/status')
  const integrations = useMemo(() => integrationsData?.integrations ?? [], [integrationsData])
  const connections = statusData?.connections ?? {}
  const loading = loadingIntegrations || loadingStatus

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshIntegrations(), refreshStatus()])
  }, [refreshIntegrations, refreshStatus])

  // The connect/verify/disconnect round-trip is shared with the in-context
  // connect dialog templates open (see use-nango-connect).
  const { busy, verifying, connect, verify, disconnect } = useNangoConnect(refreshAll)

  // Deep link: /integrations?connect=slack opens that provider's flow straight
  // away, so the "link your Slack" prompt in a Slack thread lands somewhere
  // actionable instead of on a page of cards to hunt through. Fires once —
  // a ref, not state, so a re-render mid-flow cannot reopen the UI.
  const autoConnectFired = useRef(false)
  useEffect(() => {
    if (!autoConnect || autoConnectFired.current || integrations.length === 0) return
    const match = integrations.find(
      (integration) =>
        integration.provider?.toLowerCase() === autoConnect.toLowerCase() ||
        integration.id?.toLowerCase() === autoConnect.toLowerCase(),
    )
    if (!match) return
    autoConnectFired.current = true
    void connect({ id: match.id, name: match.name })
  }, [autoConnect, integrations, connect])

  // Plain substring search over the catalog — name and provider slug, filtered
  // as you type.
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  // Card click → capability detail dialog; Connect/Verify/Disconnect keep
  // working from the card via stopPropagation, and again inside the dialog.
  const [detailId, setDetailId] = useState<string | null>(null)

  const q = search.trim().toLowerCase()
  const filtered = useMemo(
    () => (!q ? integrations : integrations.filter((i) => `${i.name} ${i.provider}`.toLowerCase().includes(q))),
    [integrations, q],
  )
  const onSearch = (value: string) => {
    setSearch(value)
    setPage(1)
  }

  const { pageItems, pageCount, page: currentPage } = paginate(filtered, page, PAGE_SIZE)

  return (
    <div className="space-y-4">
      <SlackLinkStatus />
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            // type/name/autoComplete: without these, browser autofill treats a
            // bare text input as an identity field and pre-fills the user's
            // saved email — which silently filters the grid to nothing.
            type="search"
            name="integration-search"
            autoComplete="off"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search integrations…"
            aria-label="Search integrations"
            className="h-11 w-full pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button variant="outline" size="icon" onClick={() => void refreshAll()} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {/* A failed catalog fetch is NOT an empty catalog. Both used to render
          "No integrations are enabled yet — enable them in your Nango
          dashboard", which sent someone to a dashboard whose integrations were
          already there: the real fault was that our key could not list them.
          Show what actually went wrong, and never blame the dashboard for it. */}
      {!filtered.length && !loading && Boolean(integrationsError) && (
        <EmptyState
          title="Could not load integrations from Nango"
          description={
            integrationsError instanceof Error && integrationsError.message
              ? integrationsError.message
              : 'Nango did not return the integration catalog. Check NANGO_API_KEY (and its scopes) for this environment.'
          }
        />
      )}

      {!filtered.length && !loading && !integrationsError && (
        <EmptyState
          title={q ? 'No integrations match your search' : 'No integrations are enabled yet'}
          description={q ? 'Try a different name or provider.' : 'Enable integrations in your Nango dashboard and they appear here.'}
        />
      )}

      <div className="stagger-children grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {pageItems.map((integration) => {
          const connection = connections[integration.id]
          return (
            <Card
              key={integration.id}
              variant="interactive"
              role="button"
              tabIndex={0}
              aria-label={`${integration.name} details`}
              className="cursor-pointer"
              onClick={() => setDetailId(integration.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setDetailId(integration.id)
                }
              }}
            >
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
                {!connection?.connected && PROVIDER_CONNECT_HINTS[integration.provider] && (
                  <p className="text-xs text-gray-500">{PROVIDER_CONNECT_HINTS[integration.provider]}</p>
                )}
                {connection?.connected && integration.toolCount === 0 && (
                  <p className="text-xs text-amber-700">
                    Connected, but no agent tools resolve for this app — check its unique key in the Nango dashboard,
                    or its tools haven’t shipped yet.
                  </p>
                )}
                {/* Health warnings only make sense on a live connection — a
                    disconnected card already says "Not connected", and its
                    stale auth error would just shout at the Connect button. */}
                {connection?.connected && connection.error && <p className="text-sm text-red-600">{connection.error}</p>}
                {connection?.connected
                  ? <div className="grid grid-cols-2 gap-2">
                      <Button
                        className="w-full"
                        variant={connection.verifiedAt ? 'outline' : 'default'}
                        onClick={(event) => { event.stopPropagation(); verify(integration) }}
                        loading={verifying === integration.id}
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {connection.verifiedAt ? 'Verify again' : 'Verify'}
                      </Button>
                      <Button className="w-full" variant="outline" onClick={(event) => { event.stopPropagation(); disconnect(integration) }} loading={busy === integration.id}>Disconnect</Button>
                    </div>
                  : <Button className="w-full" onClick={(event) => { event.stopPropagation(); connect(integration) }} loading={busy === integration.id}>
                      Connect
                    </Button>}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />

      {detailId && (() => {
        const integration = integrations.find((candidate) => candidate.id === detailId)
        if (!integration) return null
        const connection = connections[integration.id]
        return (
          <IntegrationDetailDialog
            integration={integration}
            connected={Boolean(connection?.connected)}
            verified={Boolean(connection?.verifiedAt)}
            busy={busy === integration.id}
            verifying={verifying === integration.id}
            onConnect={() => connect(integration)}
            onVerify={() => verify(integration)}
            onDisconnect={() => disconnect(integration)}
            onClose={() => setDetailId(null)}
          />
        )
      })()}
    </div>
  )
}
