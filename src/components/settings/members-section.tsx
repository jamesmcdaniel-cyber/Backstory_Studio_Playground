'use client'

/**
 * Settings → Members. The workspace roster and the RBAC control for it.
 *
 * SUPER ADMIN is the top rank of the same select. It is not a fourth workspace
 * role — it is the platform tier (`platformRole = 'reviewer'`) riding on top of
 * Admin, which is why every write here sends BOTH columns and why the mapping
 * lives in src/lib/authz/platform-roles.ts rather than inline. Presenting it as
 * a rank is deliberate: "make them a super admin" is one decision to the person
 * making it, and it was previously buried in a tab of the Reviews console.
 *
 * The rank is only offered to a caller who already holds it (platform.administer),
 * and both routes re-check that — this is affordance, not authorization.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { UserMinus } from 'lucide-react'
import {
  invitePayload,
  isSuperAdminPlatformRole,
  memberRoleOption,
  memberRolePatch,
  workspaceRoleFor,
  type AssignableMemberRole,
} from '@/lib/authz/platform-roles'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { Section } from '@/components/settings/section'

export type MemberRole = 'ADMIN' | 'USER' | 'OWNER' | 'VIEWER'
export type Member = {
  id: string
  name: string | null
  email: string | null
  role: MemberRole
  platformRole?: string | null
}

export const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  SUPER_ADMIN: 'Super admin',
  ADMIN: 'Admin',
  USER: 'Member',
  VIEWER: 'Viewer',
}

const SUPER_ADMIN_ROLE = {
  value: 'SUPER_ADMIN' as const,
  label: 'Super admin',
  hint: 'Everything an admin can do, plus reviewing catalogue submissions and managing platform settings.',
}

/** Ordinary ranks, highest first. OWNER is reserved to the platform owner identity. */
const ASSIGNABLE_ROLES: Array<{ value: 'ADMIN' | 'USER' | 'VIEWER'; label: string; hint: string }> = [
  { value: 'ADMIN', label: 'Admin', hint: 'Manages the workspace, members, security, and billing.' },
  { value: 'USER', label: 'Member', hint: 'Builds and runs flows and agents.' },
  { value: 'VIEWER', label: 'Viewer', hint: 'Read-only access to flows and agents.' },
]

// Viewer invitations are real: /api/organizations/invitations accepts the full
// role enum and the accept route maps it through INVITABLE_ROLES.
type Invite = {
  id: string
  email: string
  role: MemberRole
  createdAt: string
  expiresAt: string
  /** Set when the invite also parks a super-admin grant against the address. */
  platformRole?: string | null
}

export function MembersSection({
  canManage,
  canManageSuperAdmins,
  selfId,
}: {
  canManage: boolean
  canManageSuperAdmins: boolean
  selfId: string | null
}) {
  const [members, setMembers] = useState<Member[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<AssignableMemberRole>('USER')
  const [inviting, setInviting] = useState(false)
  const [removing, setRemoving] = useState<Member | null>(null)

  // Super admin sits above Admin, and only for someone who already holds it.
  const roleOptions = canManageSuperAdmins ? [SUPER_ADMIN_ROLE, ...ASSIGNABLE_ROLES] : ASSIGNABLE_ROLES

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
        body: JSON.stringify(invitePayload(inviteEmail.trim(), inviteRole)),
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

  const changeRole = async (member: Member, option: AssignableMemberRole) => {
    const body = memberRolePatch(option, member.platformRole)
    const role = workspaceRoleFor(option)

    setBusyId(member.id)
    setMembers((prev) =>
      prev.map((m) => (m.id === member.id ? { ...m, role, platformRole: 'platformRole' in body ? body.platformRole : m.platformRole } : m)),
    )
    try {
      const res = await fetch(`/api/organizations/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, role: member.role, platformRole: member.platformRole } : m)))
        toast.error(data.error || 'Could not change role.')
        return
      }
      setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, ...data.member } : m)))
      if (data.warning) toast.warning(data.warning)
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
                      way to demote anyone to Viewer from the product. Super
                      admin has the same failure mode, hence the second branch. */}
                  <Select
                    value={memberRoleOption(member.role, member.platformRole)}
                    disabled={busyId === member.id}
                    onValueChange={(value) => void changeRole(member, value as AssignableMemberRole)}
                  >
                    <SelectTrigger className="h-8 w-[9rem] text-xs" aria-label={`Role for ${member.name || member.email}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {/* A member who IS a super admin keeps the option in their
                          own select even for a caller who cannot grant it —
                          otherwise the select holds a value with no matching
                          option and silently reads as Admin. */}
                      {(isSuperAdminPlatformRole(member.platformRole) ? [SUPER_ADMIN_ROLE, ...ASSIGNABLE_ROLES] : roleOptions).map((role) => (
                        <SelectItem key={role.value} value={role.value} disabled={role.value === 'SUPER_ADMIN' && !canManageSuperAdmins}>
                          {role.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    disabled={busyId === member.id}
                    onClick={() => setRemoving(member)}
                    className="rounded-md p-1.5 text-fg-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    aria-label={`Remove ${member.name || member.email}`}
                  >
                    <UserMinus className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <Badge variant={member.role === 'ADMIN' || member.role === 'OWNER' ? 'secondary' : 'outline'}>
                  {ROLE_LABEL[memberRoleOption(member.role, member.platformRole)] ?? 'Member'}
                </Badge>
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
            <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as AssignableMemberRole)}>
              <SelectTrigger className="h-9 w-[9.5rem]" aria-label="Invite role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((role) => (
                  <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" loading={inviting} disabled={!inviteEmail.trim()}>Send invite</Button>
          </form>
          <p className="text-xs text-muted-foreground">
            {roleOptions.find((role) => role.value === inviteRole)?.hint}
          </p>

          {invites.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {invites.map((invite) => (
                <li key={invite.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{invite.email}</span>
                  <Badge variant="outline">
                    Pending · {ROLE_LABEL[memberRoleOption(invite.role, invite.platformRole)] ?? 'Member'}
                  </Badge>
                  <button
                    type="button"
                    disabled={busyId === invite.id}
                    onClick={() => void revokeInvite(invite)}
                    className="text-xs font-medium text-fg-muted hover:text-red-600 disabled:opacity-50"
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
