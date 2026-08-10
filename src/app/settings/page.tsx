'use client'

/**
 * Settings.
 *
 * Two things shape this page.
 *
 * NAVIGATION: it used to be one long scroll of nine cards, so "change the SSO
 * policy" meant scrolling past your own password fields. Each group is now a
 * tab with its own URL (`/settings?tab=security`), which also makes every
 * section linkable from elsewhere in the product. The tab rail is vertical on
 * desktop and a scrollable strip on mobile.
 *
 * GATING: sections are gated on the PERMISSION the backing route actually
 * checks, not on `isAdmin`. Those two disagree in a way that mattered — deleting
 * a workspace needs `workspace.delete`, which only the platform owner holds, so
 * every admin was shown a Delete workspace button that always answered 403 after
 * they typed the workspace name to confirm it.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  Bell,
  Building2,
  CreditCard,
  Database,
  ImagePlus,
  KeyRound,
  ShieldCheck,
  Terminal,
  Trash2,
  User as UserIcon,
  UserMinus,
  Users,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { resizeImageToDataUrl } from '@/lib/client/image'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { WorkspaceCredentialsPanel } from '@/components/integrations/workspace-credentials-panel'
import { EnterpriseSecuritySection } from '@/components/settings/enterprise-security-section'
import { DeveloperApiSection } from '@/components/settings/developer-api-section'
import { ConfirmDialog, SettingsRow } from '@/components/settings/dialogs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

type Organization = { id: string; name: string; slug: string; plan: string; logoUrl?: string | null }
type MemberRole = 'ADMIN' | 'USER' | 'OWNER' | 'VIEWER'
type Member = { id: string; name: string | null; email: string | null; role: MemberRole }

const ROLE_LABEL: Record<MemberRole, string> = { OWNER: 'Owner', ADMIN: 'Admin', USER: 'Member', VIEWER: 'Viewer' }

/** Roles an admin may assign. OWNER is reserved to the platform owner identity. */
const ASSIGNABLE_ROLES: Array<{ value: 'ADMIN' | 'USER' | 'VIEWER'; label: string; hint: string }> = [
  { value: 'ADMIN', label: 'Admin', hint: 'Manages the workspace, members, security, and billing.' },
  { value: 'USER', label: 'Member', hint: 'Builds and runs flows and agents.' },
  { value: 'VIEWER', label: 'Viewer', hint: 'Read-only access to flows and agents.' },
]

const PLAN_LABEL: Record<string, string> = {
  TRIAL: 'Trial',
  STARTER: 'Starter',
  PROFESSIONAL: 'Professional',
  ENTERPRISE: 'Enterprise',
}

const DEFAULT_ORG_LOGO = '/backstory-symbol-black.png'

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}

/* --------------------------------- Tabs ---------------------------------- */

type TabId =
  | 'account'
  | 'workspace'
  | 'members'
  | 'keys'
  | 'security'
  | 'developer'
  | 'notifications'
  | 'billing'
  | 'data'

const TABS: Array<{ id: TabId; label: string; icon: typeof UserIcon; permission?: string }> = [
  { id: 'account', label: 'Account', icon: UserIcon },
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'keys', label: 'Workspace keys', icon: KeyRound },
  { id: 'security', label: 'Security', icon: ShieldCheck, permission: 'security.manage' },
  { id: 'developer', label: 'Developer API', icon: Terminal, permission: 'api.manage' },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'data', label: 'Data & privacy', icon: Database },
]

export default function SettingsPage() {
  // useSearchParams needs a Suspense boundary for the static shell to prerender.
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-xl border bg-muted/40" />}>
      <SettingsTabs />
    </Suspense>
  )
}

function SettingsTabs() {
  const { user, isAdmin, userId, can, isLoaded } = useAuth()
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const searchParams = useSearchParams()

  // Whether the CALLER has a verified authenticator. Read once here because two
  // tabs need it: Account shows the personal status, Security uses it to refuse
  // a policy change that would lock this admin out.
  const [selfHasMfa, setSelfHasMfa] = useState<boolean | null>(null)
  const loadFactors = useCallback(async () => {
    const { data } = await supabase.auth.mfa.listFactors()
    const factors = data?.totp ?? []
    setSelfHasMfa(factors.some((factor) => factor.status === 'verified'))
  }, [supabase])
  useEffect(() => { void loadFactors().catch(() => setSelfHasMfa(null)) }, [loadFactors])

  // Permission-gated tabs stay hidden until the context resolves, so they don't
  // flash in and out for a member who will never see them.
  const visible = TABS.filter((tab) => !tab.permission || (isLoaded && can(tab.permission)))
  const requested = searchParams.get('tab') as TabId | null
  const active: TabId = visible.some((tab) => tab.id === requested) ? (requested as TabId) : 'account'

  const select = (id: TabId) => router.replace(id === 'account' ? '/settings' : `/settings?tab=${id}`, { scroll: false })

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
      <div className="lg:w-56 lg:shrink-0">
        <div className="lg:sticky lg:top-4">
          <h1 className="text-xl font-semibold text-foreground">Settings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Your account, workspace, and team.</p>
          {/* Horizontal and scrollable below lg, a rail above it. */}
          <nav
            aria-label="Settings sections"
            className="-mx-1 mt-4 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
          >
            {visible.map((tab) => {
              const Icon = tab.icon
              const isActive = tab.id === active
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => select(tab.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-full',
                    isActive
                      ? 'bg-horizon-50/80 text-horizon-700'
                      : 'text-graphite-600 hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {tab.label}
                </button>
              )
            })}
          </nav>
        </div>
      </div>

      {/* The settings body stays a form column — a narrower reading measure that
          does NOT re-center, so it keeps the shell's left edge. */}
      <div className="min-w-0 max-w-2xl flex-1 space-y-6">
        {active === 'account' && (
          <AccountSection
            supabase={supabase}
            firstName={user?.firstName ?? ''}
            lastName={user?.lastName ?? ''}
            email={user?.emailAddress ?? ''}
            hasMfa={selfHasMfa}
            onMfaChanged={() => void loadFactors()}
          />
        )}
        {active === 'workspace' && <WorkspaceSection canManage={can('org.manage')} />}
        {active === 'members' && <MembersSection canManage={can('members.manage')} selfId={userId} />}
        {active === 'keys' && <WorkspaceCredentialsPanel />}
        {active === 'security' && (
          <Section title="Enterprise security" description="SSO, verified domains, SCIM 2.0, and workspace MFA.">
            <EnterpriseSecuritySection selfHasMfa={selfHasMfa} />
          </Section>
        )}
        {active === 'developer' && (
          <Section title="Developer API" description="Scoped credentials for the flow import, export, management, and execution APIs.">
            <DeveloperApiSection />
          </Section>
        )}
        {active === 'notifications' && <NotificationsSection />}
        {active === 'billing' && <BillingSection />}
        {active === 'data' && (
          <DataLifecycleSection
            canExport={can('data.export')}
            canDeleteWorkspace={can('workspace.delete')}
            isAdmin={isAdmin}
            email={user?.emailAddress ?? ''}
            supabase={supabase}
          />
        )}
      </div>
    </div>
  )
}

/* ------------------------------- Account -------------------------------- */

function AccountSection({
  supabase,
  firstName,
  lastName,
  email,
  hasMfa,
  onMfaChanged,
}: {
  supabase: ReturnType<typeof createClient>
  firstName: string
  lastName: string
  email: string
  hasMfa: boolean | null
  onMfaChanged: () => void
}) {
  const [first, setFirst] = useState(firstName)
  const [last, setLast] = useState(lastName)
  const [savingName, setSavingName] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [disablingMfa, setDisablingMfa] = useState(false)
  const [confirmDisableMfa, setConfirmDisableMfa] = useState(false)

  // Keep local fields in sync once the auth hook resolves the real values.
  useEffect(() => { setFirst(firstName); setLast(lastName) }, [firstName, lastName])

  const saveName = async () => {
    setSavingName(true)
    const { error } = await supabase.auth.updateUser({
      data: { first_name: first.trim(), last_name: last.trim(), full_name: `${first} ${last}`.trim() },
    })
    setSavingName(false)
    if (error) toast.error(error.message)
    else toast.success('Name updated.')
  }

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 6) return toast.error('Password must be at least 6 characters.')
    if (password !== confirm) return toast.error('Passwords do not match.')
    setSavingPassword(true)
    const { error } = await supabase.auth.updateUser({ password })
    setSavingPassword(false)
    if (error) return toast.error(error.message)
    setPassword('')
    setConfirm('')
    toast.success('Password updated.')
  }

  // Unenrolling every verified factor. If the workspace requires MFA the next
  // request will bounce this user to enrollment, which the dialog says plainly.
  const disableMfa = async () => {
    setDisablingMfa(true)
    try {
      const { data } = await supabase.auth.mfa.listFactors()
      const factors = (data?.totp ?? []).filter((factor) => factor.status === 'verified')
      for (const factor of factors) {
        const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
        if (error) { toast.error(error.message); return }
      }
      setConfirmDisableMfa(false)
      onMfaChanged()
      toast.success('Authenticator removed.')
    } finally { setDisablingMfa(false) }
  }

  return (
    <Section title="Account" description="Your personal profile and sign-in.">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="first">First name</Label>
          <Input id="first" value={first} onChange={(e) => setFirst(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="last">Last name</Label>
          <Input id="last" value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={email} disabled readOnly />
        <p className="text-xs text-muted-foreground">Your sign-in address is fixed to the identity you joined with.</p>
      </div>
      <Button onClick={saveName} loading={savingName} disabled={!first.trim() || (first === firstName && last === lastName)}>
        Save name
      </Button>

      <form onSubmit={savePassword} className="space-y-4 border-t pt-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" minLength={6} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm</Label>
            <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" minLength={6} />
          </div>
        </div>
        <Button type="submit" variant="outline" loading={savingPassword} disabled={!password || !confirm}>
          Update password
        </Button>
      </form>

      {/* Enrollment lives at /auth/mfa; before this, nothing in Settings said so
          — an admin could require MFA workspace-wide with no path to satisfy it. */}
      <div className="border-t pt-4">
        <SettingsRow
          title="Two-factor authentication"
          description={
            hasMfa === null
              ? 'Checking your authenticator…'
              : hasMfa
                ? 'An authenticator app is verified on your account.'
                : 'Add an authenticator app for a second factor at sign-in.'
          }
        >
          {hasMfa ? (
            <div className="flex items-center gap-2">
              <Badge variant="good">Enabled</Badge>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDisableMfa(true)}>Remove</Button>
            </div>
          ) : (
            <Button asChild variant="outline" size="sm" disabled={hasMfa === null}>
              <a href="/auth/mfa">Set up</a>
            </Button>
          )}
        </SettingsRow>
      </div>

      <ConfirmDialog
        open={confirmDisableMfa}
        onOpenChange={setConfirmDisableMfa}
        title="Remove your authenticator?"
        description="If your workspace requires multi-factor authentication you'll be asked to enroll again on your next request."
        confirmLabel="Remove authenticator"
        destructive
        busy={disablingMfa}
        onConfirm={disableMfa}
      />
    </Section>
  )
}

/* ------------------------------ Workspace ------------------------------- */

function WorkspaceSection({ canManage }: { canManage: boolean }) {
  const [org, setOrg] = useState<Organization | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const logoInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const data = await fetch('/api/organizations', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    const first = data?.organizations?.[0] as Organization | undefined
    if (first) { setOrg(first); setName(first.name) }
  }, [])
  useEffect(() => { void load() }, [load])

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/organizations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Update failed.')
    if (data.organization) { setOrg(data.organization); setName(data.organization.name) }
  }

  const saveName = async () => {
    setSaving(true)
    try { await patch({ name: name.trim() }); toast.success('Workspace name updated.') }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Update failed.') }
    finally { setSaving(false) }
  }

  const uploadLogo = async (file: File) => {
    setUploading(true)
    try {
      const logoUrl = await resizeImageToDataUrl(file)
      await patch({ logoUrl })
      toast.success('Workspace logo updated.')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not upload that image.') }
    finally { setUploading(false) }
  }

  return (
    <Section title="Workspace" description="Your team’s shared workspace.">
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={org?.logoUrl || DEFAULT_ORG_LOGO} alt="" className="h-12 w-12 rounded-lg border object-cover" />
        {canManage && (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" loading={uploading} onClick={() => logoInput.current?.click()}>
              <ImagePlus className="h-4 w-4" /> {org?.logoUrl ? 'Change logo' : 'Upload logo'}
            </Button>
            {org?.logoUrl && (
              <Button type="button" variant="ghost" size="sm" disabled={uploading} onClick={() => patch({ logoUrl: null }).then(() => toast.success('Logo removed.')).catch((e) => toast.error(e.message))}>
                <Trash2 className="h-4 w-4" /> Remove
              </Button>
            )}
            <input
              ref={logoInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadLogo(f) }}
            />
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} readOnly={!canManage} />
        {!canManage && <p className="text-xs text-muted-foreground">Only workspace admins can change this.</p>}
      </div>
      {canManage && (
        <Button onClick={saveName} loading={saving} disabled={!name.trim() || name === org?.name}>Save workspace name</Button>
      )}

      <div className="flex items-center gap-2 border-t pt-4 text-sm">
        <span className="text-muted-foreground">Plan</span>
        <Badge variant="secondary">{PLAN_LABEL[org?.plan ?? ''] ?? org?.plan ?? '—'}</Badge>
      </div>
    </Section>
  )
}

/* ------------------------------- Members -------------------------------- */

// Viewer invitations are real: /api/organizations/invitations accepts the full
// role enum and the accept route maps it through INVITABLE_ROLES.
type Invite = { id: string; email: string; role: MemberRole; createdAt: string; expiresAt: string }

function MembersSection({ canManage, selfId }: { canManage: boolean; selfId: string | null }) {
  const [members, setMembers] = useState<Member[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'USER' | 'VIEWER'>('USER')
  const [inviting, setInviting] = useState(false)
  const [removing, setRemoving] = useState<Member | null>(null)

  const load = useCallback(async () => {
    const data = await fetch('/api/organizations/members', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (data?.success) setMembers(data.members ?? [])
    setLoaded(true)
  }, [])
  const loadInvites = useCallback(async () => {
    if (!canManage) return
    const data = await fetch('/api/organizations/invitations', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (data?.success) setInvites(data.invitations ?? [])
  }, [canManage])
  useEffect(() => { void load(); void loadInvites() }, [load, loadInvites])

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setInviting(true)
    try {
      const res = await fetch('/api/organizations/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error || 'Could not send the invitation.'); return }
      setInviteEmail('')
      await loadInvites()
      if (data.emailSent) {
        toast.success(`Invitation emailed to ${data.invitation.email}.`)
      } else {
        // No email provider configured (or send failed): hand the admin the link.
        try { await navigator.clipboard.writeText(data.link) } catch { /* clipboard blocked */ }
        toast.success('Invite created — link copied to clipboard to share.')
      }
    } finally { setInviting(false) }
  }

  const revokeInvite = async (invite: Invite) => {
    setBusyId(invite.id)
    try {
      const res = await fetch(`/api/organizations/invitations/${invite.id}`, { method: 'DELETE' })
      if (!res.ok) toast.error('Could not revoke the invitation.')
      else { setInvites((prev) => prev.filter((i) => i.id !== invite.id)); toast.success('Invitation revoked.') }
    } finally { setBusyId(null) }
  }

  const changeRole = async (member: Member, role: 'ADMIN' | 'USER' | 'VIEWER') => {
    setBusyId(member.id)
    setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, role } : m)))
    try {
      const res = await fetch(`/api/organizations/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, role: member.role } : m))); toast.error(data.error || 'Could not change role.') }
      else toast.success('Role updated.')
    } finally { setBusyId(null) }
  }

  const remove = async (member: Member) => {
    setBusyId(member.id)
    try {
      const res = await fetch(`/api/organizations/members/${member.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(data.error || 'Could not remove member.')
      else { setMembers((prev) => prev.filter((m) => m.id !== member.id)); setRemoving(null); toast.success('Member removed.') }
    } finally { setBusyId(null) }
  }

  return (
    <Section title="Members" description="People in your workspace.">
      {!loaded ? (
        <p className="text-sm text-muted-foreground">Loading members…</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-graphite-200 text-xs font-semibold text-graphite-600">
                {(member.name || member.email || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {member.name || member.email}
                  {member.id === selfId && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(You)</span>}
                </div>
                {member.name && member.email && <div className="truncate text-xs text-muted-foreground">{member.email}</div>}
              </div>
              {canManage && member.id !== selfId && member.role !== 'OWNER' ? (
                <>
                  {/* Viewer is a real role in the permission registry. The old
                      two-option native select had no entry for it, so a viewer's
                      row rendered a select with NO option matching its value —
                      showing "Admin" for a read-only member — and there was no
                      way to demote anyone to Viewer from the product. */}
                  <Select
                    value={member.role}
                    disabled={busyId === member.id}
                    onValueChange={(value) => void changeRole(member, value as 'ADMIN' | 'USER' | 'VIEWER')}
                  >
                    <SelectTrigger className="h-8 w-[7.5rem] text-xs" aria-label={`Role for ${member.name || member.email}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((role) => (
                        <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    disabled={busyId === member.id}
                    onClick={() => setRemoving(member)}
                    className="rounded-md p-1.5 text-graphite-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    aria-label={`Remove ${member.name || member.email}`}
                  >
                    <UserMinus className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <Badge variant={member.role === 'ADMIN' || member.role === 'OWNER' ? 'secondary' : 'outline'}>{ROLE_LABEL[member.role] ?? 'Member'}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="space-y-3 border-t pt-4">
          <form onSubmit={sendInvite} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1 space-y-1.5">
              <Label htmlFor="invite-email">Invite by email</Label>
              <Input id="invite-email" type="email" placeholder="teammate@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
            </div>
            <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as 'ADMIN' | 'USER' | 'VIEWER')}>
              <SelectTrigger className="h-9 w-[8rem]" aria-label="Invite role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((role) => (
                  <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" loading={inviting} disabled={!inviteEmail.trim()}>Send invite</Button>
          </form>
          <p className="text-xs text-muted-foreground">
            {ASSIGNABLE_ROLES.find((role) => role.value === inviteRole)?.hint}
          </p>

          {invites.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {invites.map((invite) => (
                <li key={invite.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{invite.email}</span>
                  <Badge variant="outline">Pending · {ROLE_LABEL[invite.role] ?? 'Member'}</Badge>
                  <button
                    type="button"
                    disabled={busyId === invite.id}
                    onClick={() => void revokeInvite(invite)}
                    className="text-xs font-medium text-graphite-400 hover:text-red-600 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null) }}
        title={`Remove ${removing?.name || removing?.email || 'this member'}?`}
        description="They lose access immediately. Their flows, agents, and run history stay in the workspace."
        confirmLabel="Remove member"
        destructive
        busy={busyId === removing?.id}
        onConfirm={() => removing && remove(removing)}
      />
    </Section>
  )
}

/* ---------------------------- Notifications ----------------------------- */

type PushState = 'unknown' | 'unavailable' | 'available' | 'enabled'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

function NotificationsSection() {
  const [pushState, setPushState] = useState<PushState>('unknown')
  const [busy, setBusy] = useState(false)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    const probe = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPushState('unavailable')
      setDenied(typeof Notification !== 'undefined' && Notification.permission === 'denied')
      const res = await fetch('/api/push/key', { cache: 'no-store' }).catch(() => null)
      const data = res && res.ok ? await res.json() : null
      if (!data?.enabled || !data?.publicKey) return setPushState('unavailable')
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = reg ? await reg.pushManager.getSubscription() : null
      setPushState(sub ? 'enabled' : 'available')
    }
    probe().catch(() => setPushState('unavailable'))
  }, [])

  const enablePush = async () => {
    setBusy(true)
    try {
      const { publicKey } = await (await fetch('/api/push/key', { cache: 'no-store' })).json()
      if (!publicKey) return
      const reg = await navigator.serviceWorker.register('/sw.js')
      if ((await Notification.requestPermission()) !== 'granted') {
        setDenied(Notification.permission === 'denied')
        toast.error('Notification permission denied.')
        return
      }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      })
      setPushState('enabled')
      toast.success('Push notifications enabled.')
    } catch { toast.error('Could not enable push notifications.') }
    finally { setBusy(false) }
  }

  // Turning push OFF had no UI at all, though DELETE /api/push/subscribe has
  // always existed — so the only way to stop notifications was the browser's
  // own site settings. Unsubscribe locally AND drop the server row, or the
  // worker keeps pushing to a dead endpoint.
  const disablePush = async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = reg ? await reg.pushManager.getSubscription() : null
      if (sub) {
        await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' })
        await sub.unsubscribe()
      }
      setPushState('available')
      toast.success('Push notifications turned off.')
    } catch { toast.error('Could not turn off push notifications.') }
    finally { setBusy(false) }
  }

  return (
    <Section title="Notifications" description="How Backstory reaches you.">
      <SettingsRow
        title="Browser push"
        description={
          denied
            ? 'Blocked in your browser — allow notifications for this site in your browser settings, then reload.'
            : 'Run results, approvals, and errors, even when Backstory isn’t open.'
        }
      >
        {pushState === 'unknown' && <span className="text-xs text-muted-foreground">Checking…</span>}
        {pushState === 'enabled' && (
          <div className="flex items-center gap-2">
            <Badge variant="good">Enabled</Badge>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void disablePush()}>Turn off</Button>
          </div>
        )}
        {pushState === 'available' && (
          <Button size="sm" loading={busy} disabled={denied} onClick={() => void enablePush()}>Enable</Button>
        )}
        {pushState === 'unavailable' && <span className="text-xs text-muted-foreground">Unavailable</span>}
      </SettingsRow>
      <p className="text-xs text-muted-foreground">
        Approval requests and run failures are always shown in-app on the Approvals and Runs surfaces, whether or not
        push is on.
      </p>
    </Section>
  )
}

/* -------------------------------- Billing ------------------------------- */

function BillingSection() {
  const [plan, setPlan] = useState<string | null>(null)
  useEffect(() => {
    fetch('/api/organizations', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setPlan(data?.organizations?.[0]?.plan ?? null))
      .catch(() => {})
  }, [])

  return (
    <Section title="Billing" description="Your plan and usage.">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Current plan</span>
        <Badge variant="secondary">{PLAN_LABEL[plan ?? ''] ?? plan ?? '—'}</Badge>
      </div>
      {/* Honest: no payments provider is configured, so there is no live
          self-serve checkout. We link to a real contact channel rather than
          fake a charge. */}
      <p className="text-sm text-muted-foreground">
        Self-serve upgrades aren’t available yet. To change your plan, reach out and we’ll get you set up.
      </p>
      <Button asChild variant="outline" size="sm">
        <a href="mailto:sales@people.ai?subject=Backstory%20plan%20upgrade">Contact us to upgrade</a>
      </Button>
    </Section>
  )
}

/* ---------------------------- Data & privacy ---------------------------- */

function DataLifecycleSection({
  canExport,
  canDeleteWorkspace,
  isAdmin,
  email,
  supabase,
}: {
  canExport: boolean
  canDeleteWorkspace: boolean
  isAdmin: boolean
  email: string
  supabase: ReturnType<typeof createClient>
}) {
  const [orgName, setOrgName] = useState<string | null>(null)
  const [confirmAccount, setConfirmAccount] = useState(false)
  const [confirmWorkspace, setConfirmWorkspace] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!canDeleteWorkspace) return
    fetch('/api/organizations', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setOrgName(data?.organizations?.[0]?.name ?? null))
      .catch(() => {})
  }, [canDeleteWorkspace])

  const deleteAccount = async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/privacy/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: email }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Account deletion failed.')
      await supabase.auth.signOut()
      window.location.href = '/auth'
    } finally { setBusy(false) }
  }

  const deleteWorkspace = async () => {
    if (!orgName) return
    setBusy(true)
    try {
      const response = await fetch('/api/privacy/workspace', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: orgName }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Workspace deletion failed.')
      await supabase.auth.signOut()
      window.location.href = '/auth'
    } finally { setBusy(false) }
  }

  return (
    <Section title="Data & privacy" description="Export or permanently remove your data.">
      {canExport && (
        <SettingsRow title="Export workspace data" description="Every flow, agent, run, and connection as newline-delimited JSON.">
          <Button asChild variant="outline" size="sm">
            <a href="/api/privacy/export" download>Download export</a>
          </Button>
        </SettingsRow>
      )}

      <SettingsRow
        title="Delete my account"
        description="Removes you from this workspace and deletes your personal data. Cannot be undone."
      >
        <Button variant="destructive" size="sm" onClick={() => setConfirmAccount(true)}>Delete account</Button>
      </SettingsRow>

      {/* Gated on workspace.delete, NOT on isAdmin: the route requires the
          former, which only the platform owner holds, so an admin who clicked
          the old button always met a 403 — after typing the workspace name. */}
      {canDeleteWorkspace ? (
        <SettingsRow
          title="Delete workspace"
          description="Permanently deletes the workspace and everything in it for every member."
        >
          <Button variant="destructive" size="sm" disabled={!orgName} onClick={() => setConfirmWorkspace(true)}>
            Delete workspace
          </Button>
        </SettingsRow>
      ) : isAdmin ? (
        <SettingsRow
          title="Delete workspace"
          description="Deleting a whole workspace is handled by Backstory — contact us and we'll confirm it with you first."
        >
          <Button asChild variant="outline" size="sm">
            <a href="mailto:support@people.ai?subject=Delete%20my%20Backstory%20workspace">Contact support</a>
          </Button>
        </SettingsRow>
      ) : null}

      <ConfirmDialog
        open={confirmAccount}
        onOpenChange={setConfirmAccount}
        title="Delete your account?"
        description="This removes your profile and personal data and signs you out. It cannot be undone."
        confirmLabel="Delete my account"
        destructive
        requireText={email}
        requireTextLabel={<>Type <span className="font-mono text-foreground">{email}</span> to confirm</>}
        busy={busy}
        onConfirm={deleteAccount}
      />

      <ConfirmDialog
        open={confirmWorkspace}
        onOpenChange={setConfirmWorkspace}
        title="Delete this workspace?"
        description="Every flow, agent, run, credential, and member of this workspace is permanently deleted."
        confirmLabel="Delete workspace"
        destructive
        requireText={orgName ?? ''}
        requireTextLabel={<>Type <span className="font-mono text-foreground">{orgName}</span> to confirm</>}
        busy={busy}
        onConfirm={deleteWorkspace}
      />
    </Section>
  )
}
