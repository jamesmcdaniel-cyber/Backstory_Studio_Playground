'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

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

/**
 * Platform-wide access administration, rendered both as the Access tab of the
 * Reviews console and at its own /admin/domains URL. Super admins only —
 * /admin's layout is the gate, and every route it calls re-checks server-side.
 *
 * Deliberately NOT reachable from workspace settings: an org admin granting
 * their own domain access would invert the boundary this screen exists to
 * hold. One person at a time is the invitation flow's job instead.
 */
export function DomainsPanel({ heading = true }: { heading?: boolean }) {
  const [domains, setDomains] = useState<DomainRow[]>([])
  const [organizations, setOrganizations] = useState<OrgRow[]>([])
  const [companyDomains, setCompanyDomains] = useState<string[]>([])
  const [domain, setDomain] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/admin/domains', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) {
      toast.error(data.error || 'Could not load domains.')
      return
    }
    setDomains(data.domains)
    setOrganizations(data.organizations)
    setCompanyDomains(data.companyDomains)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    if (!domain.trim() || !organizationId) {
      toast.error('Enter a domain and choose the workspace its people should join.')
      return
    }
    setBusy(true)
    const response = await fetch('/api/admin/domains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain, organizationId, note }),
    })
    const data = await response.json()
    setBusy(false)
    if (!response.ok) {
      toast.error(data.error || 'Could not add that domain.')
      return
    }
    toast.success(`${data.domain.domain} can now sign in.`)
    setDomain('')
    setNote('')
    await load()
  }

  const setDisabled = async (row: DomainRow, disabled: boolean) => {
    let deactivateUsers = false
    if (disabled) {
      deactivateUsers = window.confirm(
        `Blocking ${row.domain} stops new sign-ins immediately, but people already signed in keep their session until it expires.\n\n` +
          'Click OK to also sign out and deactivate their accounts now. Click Cancel to block new sign-ins only.',
      )
    }
    setBusy(true)
    const response = await fetch('/api/admin/domains', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: row.id, disabled, deactivateUsers }),
    })
    const data = await response.json()
    setBusy(false)
    if (!response.ok) {
      toast.error(data.error || 'Could not update that domain.')
      return
    }
    toast.success(
      disabled
        ? `${row.domain} blocked${data.deactivated ? ` — ${data.deactivated} account(s) deactivated.` : '.'}`
        : `${row.domain} re-enabled.`,
    )
    await load()
  }

  return (
    <div className="space-y-8">
      {heading && (
        <header>
          <h1 className="text-2xl font-semibold">Platform access</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Which email domains may sign in. {companyDomains.join(' and ')} always have access and cannot be removed here.
          </p>
        </header>
      )}

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Allow a customer domain</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="customer.com"
            className="rounded-md border px-3 py-2 text-sm"
          />
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            className="rounded-md border px-3 py-2 text-sm"
          >
            <option value="">Workspace they join…</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name} ({org.kind})
              </option>
            ))}
          </select>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional)"
            className="rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Everyone signing in from this domain joins the chosen workspace as a member. Public email providers such as
          gmail.com are refused — allowing one would let anyone with an email address in. To admit one person instead,
          invite them from that workspace&apos;s members screen.
        </p>
        <button
          onClick={() => void add()}
          disabled={busy}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          Allow domain
        </button>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Allowed domains</h2>
        {domains.length === 0 && <p className="text-sm text-muted-foreground">No customer domains yet.</p>}
        {domains.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {domains.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {row.domain}
                    {row.disabledAt && <span className="ml-2 text-xs text-muted-foreground">blocked</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    joins {row.organization?.name ?? 'unknown workspace'}
                    {row.note ? ` — ${row.note}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => void setDisabled(row, !row.disabledAt)}
                  disabled={busy}
                  className="shrink-0 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  {row.disabledAt ? 'Re-enable' : 'Block'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
