'use client'

import { useEffect, useState } from 'react'
import { Check, Copy, Link2, Mic, RefreshCw, Send, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

type Visibility = 'shared' | 'view' | 'private'
type Member = { id: string; name: string | null; email: string | null; role?: string }

const OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  { value: 'shared', label: 'Everyone can edit', hint: 'Anyone in your workspace can jam on and run this flow.' },
  { value: 'view', label: 'Everyone can view, only you edit', hint: 'Your workspace can open and run it; only you make changes.' },
  { value: 'private', label: 'Only you', hint: 'Just you can see this flow.' },
]

/**
 * Jam: the flow's live-session surface — who's here now (with a voice-huddle
 * entry point), the invite link, teammate invites, and access control. The
 * invite link points straight at the flow (/flows/<id>); login return_to
 * lands an invitee here, and their invite notification deep-links here too.
 */
export function JamDialog({
  open,
  onOpenChange,
  flowId,
  flowName,
  visibility,
  canEdit,
  onChangeVisibility,
  presence,
  onJoinHuddle,
  huddleJoined,
  shareToken,
  shareRole,
  onShareChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flowId: string
  flowName: string
  visibility: Visibility
  canEdit: boolean
  onChangeVisibility: (next: Visibility) => void
  /** Who else is currently in this flow, if presence is live. */
  presence?: { id: string; name: string; color?: string; inHuddle?: boolean }[]
  /** Starts/joins the voice huddle (closes the dialog first at the call site). */
  onJoinHuddle?: () => void
  huddleJoined?: boolean
  /** Cross-workspace share link state (same-org editors only). */
  shareToken?: string | null
  shareRole?: 'view' | 'edit'
  onShareChanged?: (token: string | null, role: 'view' | 'edit') => void
}) {
  const [copied, setCopied] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  // Only an admin can add a NEW person to the workspace (the invitations API
  // enforces it); everyone else gets pointed at the share link instead.
  const [isAdmin, setIsAdmin] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [workspaceLink, setWorkspaceLink] = useState<string | null>(null)
  const inviteLink = typeof window !== 'undefined'
    ? `${window.location.origin}/flows/${flowId}${shareToken ? `?share=${shareToken}` : ''}`
    : `/flows/${flowId}`
  const shareable = visibility !== 'private'
  const canInvite = canEdit && shareable
  const here = presence ?? []
  const huddleLive = here.some((p) => p.inHuddle)

  // Load workspace members to invite (once the dialog opens, for editors of a
  // shareable flow).
  useEffect(() => {
    if (!open || !canInvite) return
    let cancelled = false
    fetch('/api/organizations/members', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data.success) return
        const all = (data.members ?? []) as Member[]
        setIsAdmin(all.some((m) => m.id === data.selfId && m.role === 'ADMIN'))
        // You can't invite yourself — drop the caller from the list.
        setMembers(all.filter((m) => m.id !== data.selfId))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [open, canInvite])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const sendInvites = async () => {
    if (selected.size === 0) return
    setSending(true)
    try {
      const res = await fetch(`/api/flows/${flowId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: Array.from(selected) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not send invites.')
        return
      }
      toast.success(`Invited ${data.invited} ${data.invited === 1 ? 'person' : 'people'} — they’ll get a notification linking to this flow.`)
      setSelected(new Set())
    } finally {
      setSending(false)
    }
  }

  // Invite a person who has no account yet: a workspace invitation whose
  // acceptance lands them on THIS flow. Admin-only — the API enforces it too.
  const inviteByEmail = async () => {
    const email = inviteEmail.trim()
    if (!email) return
    setInviting(true)
    try {
      const res = await fetch('/api/organizations/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, next: `/flows/${flowId}` }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not send that invitation.')
        return
      }
      setWorkspaceLink(data.link ?? null)
      setInviteEmail('')
      toast.success(data.emailSent
        ? `Invitation emailed to ${email} — it opens this flow once they join.`
        : `Invitation created for ${email} — copy the link below and send it to them.`)
    } finally {
      setInviting(false)
    }
  }

  const [shareBusy, setShareBusy] = useState(false)
  const updateShare = async (enabled: boolean, role: 'view' | 'edit', rotate = false) => {
    setShareBusy(true)
    try {
      const res = await fetch(`/api/flows/${flowId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, role, rotate }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not update the share link.')
        return
      }
      onShareChanged?.(data.shareToken ?? null, data.shareRole === 'edit' ? 'edit' : 'view')
      toast.success(!enabled
        ? 'Share link turned off.'
        : rotate
          ? 'Link rotated — old links no longer work.'
          : 'Share link ready — anyone with it can open this flow after signing in.')
    } finally {
      setShareBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      toast.success('Invite link copied')
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-indigo-600" />
            <span className="min-w-0 truncate">Jam on “{flowName || 'this flow'}”</span>
          </DialogTitle>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid, so without it the unbroken mono
            invite URL sets this item's min-content width and pushes every row
            past the card edge. */}
        <div className="min-w-0 space-y-5">
          {here.length > 0 && (
            <div className="rounded-xl border border-indigo-200/70 bg-indigo-50/50 p-3 dark:border-indigo-500/25 dark:bg-indigo-500/10">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-indigo-800 dark:text-indigo-200">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  In this jam now
                </p>
                {onJoinHuddle && !huddleJoined && (
                  <Button size="sm" variant="outline" className="h-7 rounded-full" onClick={onJoinHuddle}>
                    <Mic className="mr-1.5 h-3.5 w-3.5" />
                    {huddleLive ? 'Join huddle' : 'Start huddle'}
                  </Button>
                )}
                {huddleJoined && (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    <Mic className="h-3.5 w-3.5" /> In huddle
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {here.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs">
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                      style={{ backgroundColor: p.color || '#6366f1' }}
                    >
                      {p.name.trim().charAt(0).toUpperCase() || '?'}
                    </span>
                    {p.name}
                    {p.inHuddle && <Mic className="h-3 w-3 text-emerald-600" />}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Invite link</p>
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 py-1 pl-3 pr-1">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{inviteLink}</span>
              <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={copy}>
                {copied ? <Check className="mr-1 h-3.5 w-3.5 text-green-600" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            {shareToken ? (
              <p className="text-xs text-muted-foreground">
                Anyone with this link can sign in and {shareRole === 'edit' ? 'edit' : 'view and run'} this flow.
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  Right now only people in your workspace can open this link — anyone else gets “not found”.
                </p>
                {canEdit && shareable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-full text-xs"
                    disabled={shareBusy}
                    onClick={() => void updateShare(true, 'edit')}
                  >
                    Make this link work for anyone I send it to
                  </Button>
                )}
              </div>
            )}
          </div>

          {canInvite && isAdmin && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Invite someone new</p>
              <div className="flex items-center gap-1.5">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="teammate@company.com"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                />
                <Button size="sm" onClick={() => void inviteByEmail()} loading={inviting} disabled={!inviteEmail.trim()}>
                  <UserPlus className="mr-1.5 h-4 w-4" /> Invite
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                They join your workspace and land straight on this flow.
              </p>
              {workspaceLink && (
                <p className="break-all rounded-lg border border-border/60 bg-muted/40 p-2 font-mono text-[11px]">{workspaceLink}</p>
              )}
            </div>
          )}
          {canInvite && !isAdmin && (
            <p className="rounded-lg border border-border/70 bg-muted/40 p-3 text-xs text-muted-foreground">
              Only an admin can add people to your workspace. To bring in someone else, turn on the
              share link below and send them that.
            </p>
          )}

          {canInvite && members.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Invite teammates</p>
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-1">
                {members.map((m) => {
                  const label = m.name || m.email || 'Teammate'
                  const checked = selected.has(m.id)
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggle(m.id)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                    >
                      <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-indigo-500 bg-indigo-500' : 'border-muted-foreground/40')}>
                        {checked && <Check className="h-3 w-3 text-white" />}
                      </span>
                      <span className="truncate">{label}</span>
                    </button>
                  )
                })}
              </div>
              <Button size="sm" className="w-full" onClick={sendInvites} loading={sending} disabled={selected.size === 0}>
                <Send className="mr-1.5 h-4 w-4" />
                {selected.size === 0
                  ? 'Select teammates to invite'
                  : `Send invite to ${selected.size} ${selected.size === 1 ? 'teammate' : 'teammates'}`}
              </Button>
            </div>
          )}
          {canEdit && !shareable && (
            <p className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
              This flow is private. Set it to “Everyone can view” or “edit” below to invite teammates.
            </p>
          )}

          {canEdit && shareable && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Anyone with the link</p>
                <Switch
                  checked={Boolean(shareToken)}
                  disabled={shareBusy}
                  onCheckedChange={(on) => void updateShare(on, shareRole ?? 'view')}
                  aria-label="Share with people outside your workspace"
                />
              </div>
              {shareToken ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    {(['view', 'edit'] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        disabled={shareBusy}
                        onClick={() => void updateShare(true, r)}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                          (shareRole ?? 'view') === r
                            ? 'border-indigo-300 bg-indigo-50/60 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200'
                            : 'border-border/70 text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {r === 'view' ? 'Can view' : 'Can edit'}
                      </button>
                    ))}
                    <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" disabled={shareBusy} onClick={() => void updateShare(true, shareRole ?? 'view', true)}>
                      <RefreshCw className="mr-1 h-3 w-3" /> Rotate
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    People outside your workspace can open this flow with the link above after signing in.
                    Rotating makes old links stop working; people who already accepted keep access.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Off — only your workspace can open this flow.</p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Who can access</p>
            {canEdit ? (
              <div className="space-y-1.5">
                {OPTIONS.map((option) => {
                  const active = visibility === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onChangeVisibility(option.value)}
                      aria-pressed={active}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                        active
                          ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-500/40 dark:bg-indigo-500/10'
                          : 'border-border/70 hover:bg-accent',
                      )}
                    >
                      <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-indigo-500 bg-indigo-500' : 'border-muted-foreground/40')}>
                        {active && <Check className="h-3 w-3 text-white" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{option.label}</span>
                        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{option.hint}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-border/70 bg-muted/40 p-3 text-sm text-muted-foreground">
                {OPTIONS.find((o) => o.value === visibility)?.hint ?? 'Only the owner can change who can access this flow.'}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
