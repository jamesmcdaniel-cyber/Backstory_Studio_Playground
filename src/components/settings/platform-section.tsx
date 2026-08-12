'use client'

/**
 * Settings → Platform. Super admins only.
 *
 * This used to be the "Super admins" tab of the Reviews console, which put a
 * people-and-permissions surface inside a queue-triage tool. Permissions belong
 * in Settings, so it moved here and split in two:
 *
 *   - people in YOUR workspace are managed in Settings → Members, where Super
 *     admin is simply the top rank of the role select
 *   - this panel keeps what Members structurally cannot reach — grants
 *     addressed to people who have not signed in yet, people in OTHER internal
 *     and partner workspaces, and the workspace tiering that decides where a
 *     super-admin grant resolves at all
 *
 * Both talk to the same /api/catalogue/staff route, which re-checks
 * platform.administer and is internalOnly.
 *
 * Domain access followed the same way out of Reviews (its "Access" tab): who may
 * sign in at all is permissions administration too. It keeps its own component
 * and its own route — see domain-access-section.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SUPER_ADMIN_PLATFORM_ROLE } from '@/lib/authz/platform-roles'
import { DomainAccessSection } from '@/components/settings/domain-access-section'

type StaffOrg = { id: string; name: string; slug: string; kind: string }
type StaffUser = {
  id: string
  email: string | null
  name: string | null
  platformRole: string | null
  organizationId: string
}
type PendingStaff = { id: string; email: string; createdAt: string }

const ORG_KINDS: Array<{ value: string; label: string }> = [
  { value: 'internal', label: 'Backstory (internal)' },
  { value: 'partner', label: 'People.ai (partner)' },
  { value: 'customer', label: 'Customer' },
]

/** '' is a real choice — no platform tier at all — so it needs a non-empty value. */
const NO_PLATFORM_ROLE = 'none'

const PLATFORM_ROLES: Array<{ value: string; label: string }> = [
  { value: NO_PLATFORM_ROLE, label: 'No platform role' },
  { value: 'staff', label: 'Staff' },
  { value: SUPER_ADMIN_PLATFORM_ROLE, label: 'Super admin' },
]

export function PlatformSection({ organizationId }: { organizationId: string | null }) {
  const [organizations, setOrganizations] = useState<StaffOrg[]>([])
  const [users, setUsers] = useState<StaffUser[]>([])
  const [pendingStaff, setPendingStaff] = useState<PendingStaff[]>([])
  const [newEmail, setNewEmail] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await fetch('/api/catalogue/staff', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
    if (data?.success) {
      setOrganizations(data.organizations ?? [])
      setUsers(data.users ?? [])
      setPendingStaff(data.pendingStaff ?? [])
    }
    setLoaded(true)
  }, [])

  useEffect(() => { void load() }, [load])

  // People in the caller's own workspace are managed in Members — showing them
  // twice would give the same person two role controls that disagree.
  const otherWorkspaceUsers = useMemo(
    () => users.filter((user) => user.organizationId !== organizationId),
    [users, organizationId],
  )
  const orgName = useMemo(
    () => new Map(organizations.map((org) => [org.id, org.name])),
    [organizations],
  )

  const patch = async (payload: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const response = await fetch('/api/catalogue/staff', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      toast.error(body.error || 'That change could not be saved.')
      return null
    }
    await load()
    return body
  }

  const addSuperAdmin = async (event: React.FormEvent) => {
    event.preventDefault()
    const email = newEmail.trim()
    if (!email) return
    setSaving(true)
    try {
      const body = await patch({ email, platformRole: SUPER_ADMIN_PLATFORM_ROLE })
      if (!body) return
      setNewEmail('')
      if (typeof body.warning === 'string' && body.warning) toast.warning(body.warning)
      else if (body.grant === 'pending') toast.success(`${email} becomes a super admin on their first sign-in.`)
      else toast.success(`${email} is now a super admin.`)
    } finally { setSaving(false) }
  }

  const setUserRole = async (user: StaffUser, value: string) => {
    setBusyId(user.id)
    try {
      const body = await patch({ userId: user.id, platformRole: value === NO_PLATFORM_ROLE ? null : value })
      if (!body) return
      toast.success('Platform role updated.')
    } finally { setBusyId(null) }
  }

  const setOrgKind = async (org: StaffOrg, kind: string) => {
    setBusyId(org.id)
    try {
      const body = await patch({ organizationId: org.id, orgKind: kind })
      if (body) toast.success(`${org.name} is now ${ORG_KINDS.find((o) => o.value === kind)?.label ?? kind}.`)
    } finally { setBusyId(null) }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Super admins</CardTitle>
          <CardDescription>
            Super admins review catalogue submissions, decide what the shared catalogue serves, and grant the tier to
            others. To promote someone already in this workspace, use the role select in Members.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={addSuperAdmin} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1 space-y-1.5">
              <Label htmlFor="super-admin-email">Grant by email</Label>
              <Input
                id="super-admin-email"
                type="email"
                required
                placeholder="colleague@people.ai"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
              />
            </div>
            <Button type="submit" loading={saving} disabled={!newEmail.trim()}>Add super admin</Button>
          </form>
          <p className="text-xs text-muted-foreground">
            Works for an address with no account yet — the grant applies the first time they sign in.
          </p>

          {pendingStaff.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {pendingStaff.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{entry.email}</span>
                  <Badge variant="outline">Waiting on first sign-in</Badge>
                  <button
                    type="button"
                    onClick={() => void patch({ email: entry.email, platformRole: null })}
                    className="text-xs font-medium text-graphite-400 hover:text-red-600"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">Other workspaces</h3>
            {!loaded ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : otherWorkspaceUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nobody outside this workspace holds a platform role. People in this workspace are managed in Members.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {otherWorkspaceUsers.map((user) => (
                  <li key={user.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{user.name || user.email || user.id}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {orgName.get(user.organizationId) ?? 'Unknown workspace'}
                      </div>
                    </div>
                    <Select
                      value={user.platformRole || NO_PLATFORM_ROLE}
                      disabled={busyId === user.id}
                      onValueChange={(value) => void setUserRole(user, value)}
                    >
                      <SelectTrigger className="h-8 w-[10rem] text-xs" aria-label={`Platform role for ${user.name || user.email}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLATFORM_ROLES.map((role) => (
                          <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace tiers</CardTitle>
          <CardDescription>
            A super-admin grant only resolves inside an internal or partner workspace, so the tier decides who can
            actually review. Customer workspaces never see the catalogue console.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!loaded ? (
            <p className="text-sm text-muted-foreground">Loading workspaces…</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {organizations.map((org) => (
                <li key={org.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{org.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{org.slug}</div>
                  </div>
                  <Select
                    value={org.kind}
                    disabled={busyId === org.id}
                    onValueChange={(value) => void setOrgKind(org, value)}
                  >
                    <SelectTrigger className="h-8 w-[12rem] text-xs" aria-label={`Tier for ${org.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ORG_KINDS.map((kind) => (
                        <SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <DomainAccessSection />
    </>
  )
}
