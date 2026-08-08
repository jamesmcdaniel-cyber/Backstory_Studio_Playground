'use client'

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { PROVIDER_CONNECT_HINTS } from '@/components/integrations/provider-connect-hints'

export type ConnectableIntegration = {
  id: string
  provider: string
  name: string
  logo?: string
}

/**
 * In-place connect picker for the /credentials page: the catalog entries that
 * aren't connected yet, each connectable right here through the shared Nango
 * round-trip — no detour to the Integrations tab. Connected entries drop out
 * of the list as the status refresh lands, so the dialog can stay open while
 * several accounts are connected in a row.
 */
export function ConnectIntegrationDialog({
  open,
  onOpenChange,
  integrations,
  busy,
  onConnect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Catalog entries not currently connected. */
  integrations: ConnectableIntegration[]
  /** Integration id with a Nango consent round-trip in flight, if any. */
  busy: string | null
  onConnect: (integration: ConnectableIntegration) => void
}) {
  const [search, setSearch] = useState('')

  const q = search.trim().toLowerCase()
  const filtered = useMemo(
    () => (!q ? integrations : integrations.filter((i) => `${i.name} ${i.provider}`.toLowerCase().includes(q))),
    [integrations, q],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect an integration</DialogTitle>
          <DialogDescription>
            Sign in once and every flow and agent can act through your account.
          </DialogDescription>
        </DialogHeader>

        {integrations.length > 0 && (
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              // type/name/autoComplete: without these, browser autofill treats
              // a bare text input as an identity field and pre-fills the saved
              // email — silently filtering the list to nothing.
              type="search"
              name="integration-picker-search"
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search integrations…"
              aria-label="Search integrations"
              className="pl-9 [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
        )}

        <div className="-mx-1 max-h-[50vh] space-y-1 overflow-y-auto px-1">
          {integrations.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Every available integration is already connected.
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No integrations match your search.</p>
          ) : (
            filtered.map((integration) => (
              <div key={integration.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2.5">
                <IntegrationLogo
                  src={integration.logo}
                  slug={integration.provider}
                  name={integration.name}
                  className="h-8 w-8 shrink-0 rounded-md border border-border/60 bg-white p-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{integration.name}</span>
                  {PROVIDER_CONNECT_HINTS[integration.provider] && (
                    <span className="block text-xs text-muted-foreground">{PROVIDER_CONNECT_HINTS[integration.provider]}</span>
                  )}
                </span>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => onConnect(integration)}
                  loading={busy === integration.id}
                >
                  Connect
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
