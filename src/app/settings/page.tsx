'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Bell, ImagePlus, Trash2, UserMinus } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { resizeImageToDataUrl } from '@/lib/client/image'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

type Organization = { id: string; name: string; slug: string; plan: string; logoUrl?: string | null }
type Member = { id: string; name: string | null; email: string | null; role: 'ADMIN' | 'USER' | 'OWNER' | 'VIEWER' }

const ROLE_LABEL: Record<Member['role'], string> = { OWNER: 'Owner', ADMIN: 'Admin', USER: 'Member', VIEWER: 'Viewer' }

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

export default function SettingsPage() {
  const { user, isAdmin, userId } = useAuth()
  const supabase = createClient()

  return (
    // Settings is a form column, so it keeps a narrower reading measure — but it
    // narrows INSIDE the shell's container (same left edge and gutters as every
    // other page) rather than centering itself against a different width.
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="mt-0.5 text-sm text-gray-500">Manage your account, workspace, and team.</p>
      </div>

      <AccountSection
        supabase={supabase}
        firstName={user?.firstName ?? ''}
        lastName={user?.lastName ?? ''}
        email={user?.emailAddress ?? ''}
      />
      <WorkspaceSection isAdmin={isAdmin} />
      {isAdmin && <EnterpriseSecuritySection />}
      {isAdmin && <DeveloperApiSection />}
      <MembersSection isAdmin={isAdmin} selfId={userId} />
      <NotificationsSection />
      <BillingSection />
      <DataLifecycleSection isAdmin={isAdmin} email={user?.emailAddress ?? ''} supabase={supabase} />
    </div>
  )
}

function EnterpriseSecuritySection() {
  const [policy, setPolicy] = useState<{ mfaPolicy: string; ssoEnforced: boolean } | null>(null)
  const [domains, setDomains] = useState<Array<{ id: string; domain: string; status: string; verificationToken: string }>>([])
  const load = useCallback(async () => {
    const data = await fetch('/api/organizations/security', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    if (data?.success) { setPolicy(data.policy); setDomains(data.domains ?? []) }
  }, [])
  useEffect(() => { void load() }, [load])
  const update = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/organizations/security', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return toast.error(data.error || 'Security policy update failed.')
    setPolicy(data.policy); toast.success('Security policy saved.')
  }
  const claim = async () => {
    const domain = window.prompt('Domain to claim (for example, example.com)')?.trim()
    if (!domain) return
    const response = await fetch('/api/organizations/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return toast.error(data.error || 'Could not claim domain.')
    await navigator.clipboard.writeText(`${data.dns.name} TXT ${data.dns.value}`).catch(() => undefined)
    toast.success('DNS TXT challenge copied. Add it, then verify.'); void load()
  }
  const verify = async (id: string) => {
    const response = await fetch(`/api/organizations/domains/${id}/verify`, { method: 'POST' })
    const data = await response.json().catch(() => ({}))
    if (response.ok) toast.success('Domain verified.')
    else toast.error(data.error || 'TXT record not found yet.')
    void load()
  }
  const mintScim = async () => {
    const name = window.prompt('Name this SCIM token')?.trim()
    if (!name) return
    const response = await fetch('/api/organizations/scim-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return toast.error(data.error || 'Could not create token.')
    await navigator.clipboard.writeText(data.token.secret).catch(() => undefined)
    window.prompt('Copy this token now; it will not be shown again.', data.token.secret)
  }
  return (
    <Section title="Enterprise security" description="SAML/OIDC SSO, verified domains, SCIM 2.0, and workspace MFA.">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void update({ mfaPolicy: policy?.mfaPolicy === 'required' ? 'optional' : 'required' })}>MFA: {policy?.mfaPolicy ?? 'loading'}</Button>
        <Button variant="outline" onClick={() => void update({ ssoEnforced: !policy?.ssoEnforced })}>SSO enforcement: {policy?.ssoEnforced ? 'on' : 'off'}</Button>
        <Button variant="outline" onClick={claim}>Claim domain</Button>
        <Button variant="outline" onClick={mintScim}>Create SCIM token</Button>
      </div>
      {domains.map((domain) => <div key={domain.id} className="flex items-center justify-between rounded border p-2 text-sm"><span>{domain.domain} · {domain.status}</span>{domain.status !== 'verified' && <Button size="sm" variant="ghost" onClick={() => void verify(domain.id)}>Verify DNS</Button>}</div>)}
      <p className="text-xs text-gray-500">SCIM base URL: <code>/api/scim/v2</code>. Configure the SAML/OIDC provider in Supabase Auth, then verify a domain here before enforcing SSO.</p>
    </Section>
  )
}

function DeveloperApiSection() {
  const [keys, setKeys] = useState<Array<{ id: string; name: string; prefix: string; revokedAt: string | null }>>([])
  const load = useCallback(async () => { const data = await fetch('/api/api-keys', { cache: 'no-store' }).then((r) => r.json()).catch(() => null); if (data?.success) setKeys(data.keys ?? []) }, [])
  useEffect(() => { void load() }, [load])
  const create = async () => {
    const name = window.prompt('Name this API key')?.trim(); if (!name) return
    const response = await fetch('/api/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scopes: ['flows:read', 'flows:write', 'flows:run'] }) })
    const data = await response.json().catch(() => ({})); if (!response.ok) return toast.error(data.error || 'Could not create API key.')
    await navigator.clipboard.writeText(data.key.secret).catch(() => undefined); window.prompt('Copy this key now; it will not be shown again.', data.key.secret); void load()
  }
  return <Section title="Developer API" description="Scoped credentials for native workflow import, export, management, and execution."><Button variant="outline" onClick={create}>Create API key</Button>{keys.filter((key) => !key.revokedAt).map((key) => <div key={key.id} className="text-sm text-gray-600">{key.name} · <code>{key.prefix}…</code></div>)}</Section>
}

function DataLifecycleSection({ isAdmin, email, supabase }: { isAdmin: boolean; email: string; supabase: ReturnType<typeof createClient> }) {
  const deleteAccount = async () => {
    const confirmation = window.prompt(`Type ${email} to permanently delete your account.`); if (!confirmation) return
    const response = await fetch('/api/privacy/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation }) })
    const data = await response.json().catch(() => ({})); if (!response.ok) return toast.error(data.error || 'Account deletion failed.')
    await supabase.auth.signOut(); window.location.href = '/auth'
  }
  const deleteWorkspace = async () => {
    const org = await fetch('/api/organizations').then((r) => r.json()).catch(() => null); const name = org?.organizations?.[0]?.name
    const confirmation = window.prompt(`Type ${name} to permanently delete this workspace.`); if (!confirmation) return
    const response = await fetch('/api/privacy/workspace', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation }) })
    const data = await response.json().catch(() => ({})); if (!response.ok) return toast.error(data.error || 'Workspace deletion failed.')
    await supabase.auth.signOut(); window.location.href = '/auth'
  }
  return <Section title="Data lifecycle" description="Export or permanently remove customer data."><div className="flex flex-wrap gap-2">{isAdmin && <Button asChild variant="outline"><a href="/api/privacy/export" download>Export workspace data</a></Button>}<Button variant="destructive" onClick={deleteAccount}>Delete my account</Button>{isAdmin && <Button variant="destructive" onClick={deleteWorkspace}>Delete workspace</Button>}</div></Section>
}

/* ------------------------------- Account -------------------------------- */

function AccountSection({
  supabase,
  firstName,
  lastName,
  email,
}: {
  supabase: ReturnType<typeof createClient>
  firstName: string
  lastName: string
  email: string
}) {
  const [first, setFirst] = useState(firstName)
  const [last, setLast] = useState(lastName)
  const [savingName, setSavingName] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

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
      </div>
      <Button onClick={saveName} loading={savingName} disabled={!first.trim() || (first === firstName && last === lastName)}>
        Save name
      </Button>

      <form onSubmit={savePassword} className="space-y-4 border-t pt-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" minLength={6} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm</Label>
            <Input id="confirm-password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" minLength={6} />
          </div>
        </div>
        <Button type="submit" variant="outline" loading={savingPassword} disabled={!password || !confirm}>
          Update password
        </Button>
      </form>
    </Section>
  )
}

/* ------------------------------ Workspace ------------------------------- */

function WorkspaceSection({ isAdmin }: { isAdmin: boolean }) {
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
    catch (err: any) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  const uploadLogo = async (file: File) => {
    setUploading(true)
    try {
      const logoUrl = await resizeImageToDataUrl(file)
      await patch({ logoUrl })
      toast.success('Workspace logo updated.')
    } catch (err: any) { toast.error(err.message || 'Could not upload that image.') }
    finally { setUploading(false) }
  }

  return (
    <Section title="Workspace" description="Your team’s shared workspace.">
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={org?.logoUrl || DEFAULT_ORG_LOGO} alt="" className="h-12 w-12 rounded-lg border object-cover" />
        {isAdmin && (
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
        <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} readOnly={!isAdmin} />
        {!isAdmin && <p className="text-xs text-gray-400">Only workspace admins can change this.</p>}
      </div>
      {isAdmin && (
        <Button onClick={saveName} loading={saving} disabled={!name.trim() || name === org?.name}>Save workspace name</Button>
      )}

      <div className="flex items-center gap-2 border-t pt-4 text-sm">
        <span className="text-gray-500">Plan</span>
        <Badge variant="secondary">{PLAN_LABEL[org?.plan ?? ''] ?? org?.plan ?? '—'}</Badge>
      </div>
    </Section>
  )
}

/* ------------------------------- Members -------------------------------- */

type Invite = { id: string; email: string; role: 'ADMIN' | 'USER'; createdAt: string; expiresAt: string }

function MembersSection({ isAdmin, selfId }: { isAdmin: boolean; selfId: string | null }) {
  const [members, setMembers] = useState<Member[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'USER'>('USER')
  const [inviting, setInviting] = useState(false)

  const load = useCallback(async () => {
    const data = await fetch('/api/organizations/members', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (data?.success) setMembers(data.members ?? [])
    setLoaded(true)
  }, [])
  const loadInvites = useCallback(async () => {
    if (!isAdmin) return
    const data = await fetch('/api/organizations/invitations', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (data?.success) setInvites(data.invitations ?? [])
  }, [isAdmin])
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

  const changeRole = async (member: Member, role: 'ADMIN' | 'USER') => {
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
    if (!window.confirm(`Remove ${member.name || member.email} from this workspace?`)) return
    setBusyId(member.id)
    try {
      const res = await fetch(`/api/organizations/members/${member.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(data.error || 'Could not remove member.')
      else { setMembers((prev) => prev.filter((m) => m.id !== member.id)); toast.success('Member removed.') }
    } finally { setBusyId(null) }
  }

  return (
    <Section title="Members" description="People in your workspace.">
      {!loaded ? (
        <p className="text-sm text-gray-400">Loading members…</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600">
                {(member.name || member.email || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {member.name || member.email}
                  {member.id === selfId && <span className="ml-1.5 text-xs font-normal text-gray-400">(You)</span>}
                </div>
                {member.name && member.email && <div className="truncate text-xs text-gray-400">{member.email}</div>}
              </div>
              {isAdmin && member.id !== selfId && member.role !== 'OWNER' ? (
                <>
                  <select
                    value={member.role}
                    disabled={busyId === member.id}
                    onChange={(e) => void changeRole(member, e.target.value as 'ADMIN' | 'USER')}
                    className="rounded-md border bg-white px-2 py-1 text-xs text-gray-700 disabled:opacity-50"
                  >
                    <option value="ADMIN">Admin</option>
                    <option value="USER">Member</option>
                  </select>
                  <button
                    type="button"
                    disabled={busyId === member.id}
                    onClick={() => void remove(member)}
                    className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    aria-label="Remove member"
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
      {isAdmin && (
        <div className="space-y-3 border-t pt-4">
          <form onSubmit={sendInvite} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1 space-y-1.5">
              <Label htmlFor="invite-email">Invite by email</Label>
              <Input id="invite-email" type="email" placeholder="teammate@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
            </div>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'ADMIN' | 'USER')}
              className="h-9 rounded-md border bg-white px-2 text-sm text-gray-700"
              aria-label="Invite role"
            >
              <option value="USER">Member</option>
              <option value="ADMIN">Admin</option>
            </select>
            <Button type="submit" loading={inviting} disabled={!inviteEmail.trim()}>Send invite</Button>
          </form>

          {invites.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {invites.map((invite) => (
                <li key={invite.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-gray-700">{invite.email}</span>
                  <Badge variant="outline">Pending · {invite.role === 'ADMIN' ? 'Admin' : 'Member'}</Badge>
                  <button
                    type="button"
                    disabled={busyId === invite.id}
                    onClick={() => void revokeInvite(invite)}
                    className="text-xs font-medium text-gray-400 hover:text-red-600 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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

  useEffect(() => {
    const probe = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPushState('unavailable')
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
      if ((await Notification.requestPermission()) !== 'granted') { toast.error('Notification permission denied.'); return }
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

  return (
    <Section title="Notifications" description="How Backstory reaches you.">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-2">
          <Bell className="mt-0.5 h-4 w-4 text-gray-400" />
          <div>
            <div className="text-sm font-medium text-gray-900">Browser push</div>
            <div className="text-xs text-gray-500">Get notified about runs, approvals, and errors even when Backstory isn’t open.</div>
          </div>
        </div>
        {pushState === 'enabled' && <Badge variant="good">Enabled</Badge>}
        {pushState === 'available' && <Button size="sm" loading={busy} onClick={enablePush}>Enable</Button>}
        {pushState === 'unavailable' && <span className="text-xs text-gray-400">Unavailable</span>}
      </div>
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
        <span className="text-gray-500">Current plan</span>
        <Badge variant="secondary">{PLAN_LABEL[plan ?? ''] ?? plan ?? '—'}</Badge>
      </div>
      {/* Honest: no payments provider is configured, so there is no live
          self-serve checkout. We link to a real contact channel rather than
          fake a charge. */}
      <p className="text-sm text-gray-500">
        Self-serve upgrades aren’t available yet. To change your plan, reach out and we’ll get you set up.
      </p>
      <Button asChild variant="outline" size="sm">
        <a href="mailto:sales@people.ai?subject=Backstory%20plan%20upgrade">Contact us to upgrade</a>
      </Button>
    </Section>
  )
}
