'use client'

/**
 * Settings → Platform → Domain access.
 *
 * Which email domains may sign in, and which workspace their people land in.
 *
 * This used to be the "Access" tab of the Reviews console (plus a bare
 * /admin/domains page). Reviews decides what the shared catalogue serves; who
 * may sign in at all is permissions administration, so it belongs beside Super
 * admins and Workspace tiers rather than inside a queue-triage tool.
 *
 * Still NOT a workspace-admin surface: it is rendered only under the Platform
 * tab, which is gated on platform.administer, and /api/admin/domains re-checks that
 * server-side. An org admin allowing their own domain would invert the boundary
 * this screen exists to hold — admitting one person is the invitation flow's job.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/settings/dialogs'

type DomainRow = {
  id: string
  domain: string
  note: string
  createdAt: string
  disabledAt: string | null
  organizationId: string
  organization: { name: string; slug: string } | null
}

type OrgRow = { id: string; name: string; slug: string; kind: string }

export function DomainAccessSection() {
  const [domains, setDomains] = useState<DomainRow[]>([])
  const [organizations, setOrganizations] = useState<OrgRow[]>([])
  const [companyDomains, setCompanyDomains] = useState<string[]>([])
  const [domain, setDomain] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [note, setNote] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  // The row awaiting a block confirmation, and whether that block should also
  // sign its people out. Two separate decisions, which the old native confirm
  // collapsed into OK/Cancel.
  const [blocking, setBlocking] = useState<DomainRow | null>(null)
  const [deactivateUsers, setDeactivateUsers] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/admin/domains', { cache: 'no-store' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      toast.error(data.error || 'Could not load domains.')
      setLoaded(true)
      return
    }
    setDomains(data.domains ?? [])
    setOrganizations(data.organizations ?? [])
    setCompanyDomains(data.companyDomains ?? [])
    setLoaded(true)
  }, [])

  useEffect(() => { void load() }, [load])

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!domain.trim() || !organizationId) {
      toast.error('Enter a domain and choose the workspace its people should join.')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/admin/domains', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain, organizationId, note }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not add that domain.')
        return
      }
      toast.success(`${data.domain.domain} can now sign in.`)
      setDomain('')
      setNote('')
      await load()
    } finally { setBusy(false) }
  }

  const setDisabled = async (row: DomainRow, disabled: boolean, alsoDeactivate = false) => {
    setBusy(true)
    try {
      const response = await fetch('/api/admin/domains', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: row.id, disabled, deactivateUsers: alsoDeactivate }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not update that domain.')
        return
      }
      toast.success(
        disabled
          ? `${row.domain} blocked${data.deactivated ? ` — ${data.deactivated} account(s) deactivated.` : '.'}`
          : `${row.domain} re-enabled.`,
      )
      setBlocking(null)
      await load()
    } finally { setBusy(false) }
  }

  const askToBlock = (row: DomainRow) => {
    setDeactivateUsers(false)
    setBlocking(row)
  }

  // A company domain's row is routing only — its people are admitted by the
  // hardcoded list whether or not it is blocked — so the sign-in wording and the
  // deactivate-accounts offer would both be lies for it.
  const blockingCompanyDomain = blocking ? companyDomains.includes(blocking.domain) : false

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Domain access</CardTitle>
        <CardDescription>
          Which email domains may sign in, and which workspace their people join.
          {companyDomains.length > 0 && (
            <> {companyDomains.join(' and ')} can always sign in — list one below only to send its people into a shared
            workspace instead of a solo one each.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={add} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="allow-domain">Domain</Label>
              <Input
                id="allow-domain"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="customer.com"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="allow-domain-workspace">Workspace they join</Label>
              <Select value={organizationId} onValueChange={setOrganizationId}>
                <SelectTrigger id="allow-domain-workspace">
                  <SelectValue placeholder="Choose a workspace…" />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((org) => (
                    <SelectItem key={org.id} value={org.id}>{org.name} ({org.kind})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="allow-domain-note">Note</Label>
              <Input
                id="allow-domain-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional"
                autoComplete="off"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Everyone signing in from this domain joins the chosen workspace as a member. Applies to accounts created
            from now on — people who already signed in keep the workspace they landed in, so move them with an
            invitation from that workspace&apos;s Members screen. Public email providers such as gmail.com are refused —
            allowing one would let anyone with an email address in. To admit one person instead, invite them.
          </p>
          <Button type="submit" loading={busy} disabled={!domain.trim() || !organizationId}>Allow domain</Button>
        </form>

        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">Allowed domains</h3>
          {!loaded ? (
            <p className="text-sm text-muted-foreground">Loading domains…</p>
          ) : domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">No domains listed yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {domains.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {row.domain}
                      {row.disabledAt && <span className="ml-2 text-xs text-muted-foreground">blocked</span>}
                      {companyDomains.includes(row.domain) && (
                        <span className="ml-2 text-xs text-muted-foreground">company domain — routing only</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      joins {row.organization?.name ?? 'unknown workspace'}
                      {row.note ? ` — ${row.note}` : ''}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => (row.disabledAt ? void setDisabled(row, false) : askToBlock(row))}
                  >
                    {row.disabledAt ? 'Re-enable' : 'Block'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <ConfirmDialog
        open={blocking !== null}
        onOpenChange={(open) => { if (!open) setBlocking(null) }}
        title={blocking ? `Block ${blocking.domain}?` : 'Block domain?'}
        description={
          blockingCompanyDomain
            ? `${blocking?.domain} is a company domain: its people can always sign in. Blocking only stops new accounts from joining the chosen workspace — they will land in a solo workspace of their own instead.`
            : 'Access stops on their next request — both new sign-ins and anyone currently signed in. Their accounts stay intact.'
        }
        confirmLabel="Block domain"
        destructive
        busy={busy}
        onConfirm={() => blocking && void setDisabled(blocking, true, !blockingCompanyDomain && deactivateUsers)}
      >
        {!blockingCompanyDomain && (
          <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <Label htmlFor="deactivate-users" className="text-sm font-normal">
              Also deactivate their accounts
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Leave off to revoke platform access only — reversible by
                re-enabling the domain.
              </span>
            </Label>
            <Switch id="deactivate-users" checked={deactivateUsers} onCheckedChange={setDeactivateUsers} />
          </div>
        )}
      </ConfirmDialog>
    </Card>
  )
}
