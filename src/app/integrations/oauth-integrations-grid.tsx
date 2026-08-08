'use client'

import { useCallback, useMemo, useState } from 'react'
import { CheckCircle2, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Pagination, paginate } from '@/components/ui/pagination'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { useNangoConnect } from '@/lib/client/use-nango-connect'

/** Integration cards per page — mirrors the Templates library grid. */
const PAGE_SIZE = 9

/**
 * What the provider's consent flow will ask for, surfaced BEFORE the user
 * clicks Connect. The Nango iframe collects these (subdomain, environment,
 * account picks) without warning, which reads as "random" — this names it.
 * Keyed by the catalog provider slug; partial on purpose.
 */
const PROVIDER_CONNECT_HINTS: Record<string, string> = {
  salesforce: 'Salesforce asks production vs sandbox — sandbox logins go through test.salesforce.com.',
  'salesforce-sandbox': 'Connects against test.salesforce.com (sandbox orgs).',
  zendesk: 'Have your Zendesk subdomain ready — the “company” in company.zendesk.com.',
  jira: 'Sign in with Atlassian and pick your site (yourteam.atlassian.net) when asked.',
  confluence: 'Sign in with Atlassian and pick your site (yourteam.atlassian.net) when asked.',
  slack: 'Grants this workspace’s Slack app scopes — invite the bot to any channel it should post in.',
  notion: 'During Notion’s consent step, share the pages and databases the integration may read — unshared pages stay invisible.',
  airtable: 'Airtable grants only the bases you pick during consent.',
  hubspot: 'Pick which HubSpot account to grant when HubSpot asks.',
  github: 'Authorizes github.com accounts — GitHub Enterprise servers are not supported here.',
  gmail: 'Google may warn about an unverified app while the OAuth app is in testing — continue with your workspace account.',
  google_drive: 'Google may warn about an unverified app while the OAuth app is in testing — continue with your workspace account.',
  google_sheets: 'Google may warn about an unverified app while the OAuth app is in testing — continue with your workspace account.',
  granola: 'Have your Granola API token (grn_…) ready — create one in Granola under Settings → API keys.',
}

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

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshIntegrations(), refreshStatus()])
  }, [refreshIntegrations, refreshStatus])

  // The connect/verify/disconnect round-trip is shared with the in-context
  // connect dialog templates open (see use-nango-connect).
  const { busy, verifying, connect, verify, disconnect } = useNangoConnect(refreshAll)

  // Plain substring search over the catalog — name and provider slug, filtered
  // as you type.
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

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

      {!filtered.length && !loading && (
        <EmptyState
          title={q ? 'No integrations match your search' : 'No integrations are enabled yet'}
          description={q ? 'Try a different name or provider.' : 'Enable integrations in your Nango dashboard and they appear here.'}
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
