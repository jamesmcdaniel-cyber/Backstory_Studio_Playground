'use client'

/**
 * Integration detail dialog: what this app can READ and what it can DO here,
 * rendered from /api/nango/integrations/[provider]/capabilities — which
 * derives from the same tool registry the agents execute against, so this
 * dialog cannot promise a capability the runtime doesn't have.
 *
 * Doubles as the management surface: the footer carries the same
 * connect/verify/disconnect actions as the card, so opening details is never
 * a dead end.
 */

import { BookOpen, PencilLine, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { Skeleton } from '@/components/ui/skeleton'

type CapabilityItem = { label: string; description: string }
type Capabilities = { provider: string; label: string; reads: CapabilityItem[]; writes: CapabilityItem[] }

export interface IntegrationDetailProps {
  integration: { id: string; provider: string; name: string; logo?: string; toolCount?: number }
  connected: boolean
  verified: boolean
  busy: boolean
  verifying: boolean
  onConnect: () => void
  onVerify: () => void
  onDisconnect: () => void
  onClose: () => void
}

function CapabilityList({ title, icon, items, note }: { title: string; icon: React.ReactNode; items: CapabilityItem[]; note?: string }) {
  if (!items.length) return null
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">{icon}{title}</h3>
      {note && <p className="mb-2 text-xs text-muted-foreground">{note}</p>}
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.label} className="text-sm">
            <span className="font-medium text-foreground">{item.label}</span>
            <span className="text-muted-foreground"> — {item.description}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function IntegrationDetailDialog({
  integration, connected, verified, busy, verifying, onConnect, onVerify, onDisconnect, onClose,
}: IntegrationDetailProps) {
  const { data, loading } = useCachedJson<{ capabilities?: Capabilities }>(
    `/api/nango/integrations/${encodeURIComponent(integration.id)}/capabilities`,
  )
  const caps = data?.capabilities
  const empty = !loading && caps && caps.reads.length === 0 && caps.writes.length === 0
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IntegrationLogo src={integration.logo} slug={integration.provider} name={integration.name} />
            {integration.name}
            {connected
              ? <Badge variant={verified ? 'good' : 'warn'}>{verified ? 'Verified' : 'Unverified'}</Badge>
              : <Badge variant="secondary">Not connected</Badge>}
          </DialogTitle>
          <DialogDescription>
            What agents and flows can do through your {integration.name} account. Everything runs as you — never
            through a shared workspace credential.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}
        {empty && (
          <p className="text-sm text-muted-foreground">
            This app can be connected, but no agent tools use it yet — its data isn&apos;t reachable from runs until
            tools ship for it.
          </p>
        )}
        {caps && !empty && (
          <div className="space-y-4">
            <CapabilityList
              title="What it can read"
              icon={<BookOpen aria-hidden className="h-4 w-4" />}
              items={caps.reads}
            />
            <CapabilityList
              title="What it can do"
              icon={<PencilLine aria-hidden className="h-4 w-4" />}
              items={caps.writes}
              note="Actions that change something go through the approval gate before they run."
            />
          </div>
        )}

        <div className="mt-2 border-t pt-3">
          {connected ? (
            <div className="grid grid-cols-2 gap-2">
              <Button variant={verified ? 'outline' : 'default'} onClick={onVerify} loading={verifying}>
                <ShieldCheck className="h-4 w-4" />
                {verified ? 'Verify again' : 'Verify'}
              </Button>
              <Button variant="outline" onClick={onDisconnect} loading={busy}>Disconnect</Button>
            </div>
          ) : (
            <Button className="w-full" onClick={onConnect} loading={busy}>Connect</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
