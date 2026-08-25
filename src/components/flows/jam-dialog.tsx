'use client'

import { useEffect, useState } from 'react'
import { Check, Copy, Link2, Lock, Mic, RefreshCw, Send, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { HuddlePanel, type HuddleCapture, type HuddleMember } from '@/components/flows/huddle-panel'
import type { HuddleNoteRecord } from '@/lib/flows/use-huddle-capture'
import { NotebookPen } from 'lucide-react'
import type { FlowHuddle } from '@/lib/flows/use-flow-huddle'
import { cn } from '@/lib/utils'

type Visibility = 'shared' | 'view' | 'private'
type Member = { id: string; name: string | null; email: string | null; role?: string }

const OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  { value: 'shared', label: 'Everyone can edit', hint: 'Anyone in your workspace can jam on and run this flow.' },
  { value: 'view', label: 'Everyone can view, only you edit', hint: 'Your workspace can open and run it; only you make changes.' },
  { value: 'private', label: 'Only you', hint: 'Just you can see this flow.' },
]

/** Who the ONE share link works for. Anonymous is a fourth state of the same
 *  choice rather than a separate toggle+link, so the panel never shows two
 *  URLs: pick an audience, copy the link that audience needs. */
type Audience = 'workspace' | 'anyone-view' | 'anyone-edit' | 'anyone-public'
const AUDIENCES: { key: Audience; label: string }[] = [
  { key: 'workspace', label: 'Workspace only' },
  { key: 'anyone-view', label: 'Anyone can view' },
  { key: 'anyone-edit', label: 'Anyone can edit' },
  { key: 'anyone-public', label: 'Anyone, no sign-in' },
]

/**
 * Jam: the flow's live-session surface — who's here now (with a voice-huddle
 * entry point), one list of people to ping in, ONE share link for everyone
 * outside, and access control.
 *
 * Two deliberate simplifications: the roster is a single list (workspace
 * teammates + anyone who joined by link) where each row's own button is the
 * whole interaction, and the share link is one URL whose address follows the
 * chosen audience — never two links on screen at once. The workspace link
 * points straight at the flow (/flows/<id>); login return_to lands an invitee
 * here, and their invite notification deep-links here too.
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
  onFollow,
  huddle,
  huddleMembers,
  huddleStartBlocked,
  selfClientId,
  capture,
  shareToken,
  shareEnabled,
  shareRole,
  shareAnonymous,
  anonymousViews,
  onShareChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flowId: string
  flowName: string
  visibility: Visibility
  canEdit: boolean
  onChangeVisibility: (next: Visibility) => void
  /** Who else is currently in this flow, if presence is live. `label` +
   *  `needsFollow` describe a teammate on the OTHER builder view, whose cursor
   *  can't be drawn on yours — following switches you to their view. */
  presence?: {
    id: string
    /** The person behind this connection — matches them to the roster row. */
    userId?: string
    name: string
    color?: string
    inHuddle?: boolean
    view?: 'inline' | 'canvas'
    label?: string
    needsFollow?: boolean
  }[]
  /** Switch the builder to a teammate's view. */
  onFollow?: (view: 'inline' | 'canvas') => void
  /** The whole huddle surface — every voice control lives inside this dialog.
   *  Absent → the jam has no voice controls. */
  huddle?: FlowHuddle
  huddleMembers?: HuddleMember[]
  /** Why a huddle can't be started right now, or null when it can. */
  huddleStartBlocked?: string | null
  selfClientId?: string
  /** Huddle-notes capture (consent, session, upload state). */
  capture?: HuddleCapture
  /** Cross-workspace share link state (same-org editors only). */
  /** The RAW token — present only in the session that just minted or rotated
   *  it. The server stores a digest and returns the plaintext exactly once, so
   *  a reload leaves this null with the link still live. */
  shareToken?: string | null
  /** Whether a share link is currently live. Drives the audience chips, which
   *  must stay correct after a reload has dropped the raw token. */
  shareEnabled?: boolean
  shareRole?: 'view' | 'edit'
  /** Link opens without signing in (always read-only). */
  shareAnonymous?: boolean
  /** Owner-visible count of anonymous opens. */
  anonymousViews?: number
  onShareChanged?: (
    token: string | null,
    enabled: boolean,
    role: 'view' | 'edit',
    anonymous: boolean,
    anonymousViews: number,
  ) => void
}) {
  const [copied, setCopied] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  // One person at a time: a row's own button is the whole interaction, so there
  // is no select-then-send step to get wrong.
  const [pinging, setPinging] = useState<string | null>(null)
  const [pinged, setPinged] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  // Only an admin can add a NEW person to the workspace (the invitations API
  // enforces it); everyone else gets pointed at the share link instead.
  const [isAdmin, setIsAdmin] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [workspaceLink, setWorkspaceLink] = useState<string | null>(null)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const shareable = visibility !== 'private'
  const canInvite = canEdit && shareable
  const here = presence ?? []

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
        setIsAdmin(all.some((m) => m.id === data.selfId && (m.role === 'ADMIN' || m.role === 'OWNER')))
        // You can't invite yourself — drop the caller from the list.
        setMembers(all.filter((m) => m.id !== data.selfId))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [open, canInvite])

  // Huddle notes: fetched when the dialog opens; the same response says
  // whether transcription is configured (drives the capture toggle's state).
  // A freshly produced note (capture.latestNote) is merged in so the person
  // who just left the huddle sees it without reopening.
  const [notes, setNotes] = useState<HuddleNoteRecord[]>([])
  const [captureAvailable, setCaptureAvailable] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (!open || !huddle) return
    let cancelled = false
    fetch(`/api/flows/${flowId}/huddle/notes`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data.success) return
        setNotes((data.notes ?? []) as HuddleNoteRecord[])
        setCaptureAvailable(Boolean(data.captureAvailable))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [open, flowId, huddle, capture?.latestNote])
  const visibleNotes = capture?.latestNote && !notes.some((n) => n.id === capture.latestNote?.id)
    ? [capture.latestNote, ...notes]
    : notes

  /** Ping one teammate into the jam (or ring them into the live huddle). */
  const ping = async (userId: string) => {
    setPinging(userId)
    try {
      const res = await fetch(`/api/flows/${flowId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [userId], kind: huddle?.joined ? 'huddle' : 'jam' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not send that invite.')
        return
      }
      setPinged((prev) => new Set(prev).add(userId))
      toast.success(
        huddle?.joined
          ? 'Ringing them — they’ll get a notification to join the huddle.'
          : 'Pinged — they’ll get a notification linking straight to this jam.',
      )
    } finally {
      setPinging(null)
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
  const updateShare = async (
    enabled: boolean,
    role: 'view' | 'edit',
    rotate = false,
    revokeCollaborators = false,
    anonymous = shareAnonymous ?? false,
  ) => {
    setShareBusy(true)
    try {
      const res = await fetch(`/api/flows/${flowId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, role, rotate, revokeCollaborators, anonymous }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not update the share link.')
        return
      }
      onShareChanged?.(
        data.shareToken ?? null,
        Boolean(data.shareEnabled),
        data.shareRole === 'edit' ? 'edit' : 'view',
        Boolean(data.shareAnonymous),
        Number(data.anonymousViews ?? 0),
      )
      if (revokeCollaborators) setGuests([])
      toast.success(!enabled
        ? 'Share link now works for your workspace only.'
        : revokeCollaborators
          ? 'Link rotated — old links stopped working and everyone who joined by link was removed.'
          : rotate
            ? 'Link rotated — old links no longer work.'
            : 'Share link ready — anyone with it can open this flow after signing in.')
    } finally {
      setShareBusy(false)
    }
  }

  // Cross-workspace guests who accepted the share link — editors manage them
  // here, since removal is the only way to end a durable accepted grant.
  type Guest = { userId: string; role: 'view' | 'edit'; name: string | null; email: string | null }
  const [guests, setGuests] = useState<Guest[]>([])
  const [removingGuest, setRemovingGuest] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !canEdit) return
    let cancelled = false
    fetch(`/api/flows/${flowId}/collaborators`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setGuests(data.collaborators ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, canEdit, flowId])

  const removeGuest = async (userId: string) => {
    setRemovingGuest(userId)
    try {
      const res = await fetch(`/api/flows/${flowId}/collaborators`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not remove them.')
        return
      }
      setGuests((current) => current.filter((guest) => guest.userId !== userId))
      toast.success('Removed — they can no longer open this flow.')
    } finally {
      setRemovingGuest(null)
    }
  }

  // The link's current audience, as one value the chip row can render.
  const audience: Audience = !shareEnabled
    ? 'workspace'
    : shareAnonymous
      ? 'anyone-public'
      : (shareRole ?? 'view') === 'edit'
        ? 'anyone-edit'
        : 'anyone-view'
  const setAudience = (next: Audience) => {
    if (next === audience) return
    if (next === 'workspace') void updateShare(false, shareRole ?? 'view', false, false, false)
    else if (next === 'anyone-public') void updateShare(true, 'view', false, false, true)
    else void updateShare(true, next === 'anyone-edit' ? 'edit' : 'view', false, false, false)
  }

  // ONE link, whichever audience is chosen. An empty string means the link is
  // live but its plaintext is gone: the server keeps only a digest and hands
  // back the raw token exactly once, so after a reload the panel says so and
  // offers a rotate rather than showing a URL it can't complete. The no-sign-in audience needs a
  // different address (the public read-only page, never the builder), so the
  // panel swaps the URL rather than showing a second one.
  const shareLink = audience === 'workspace'
    ? `${origin}/flows/${flowId}`
    : !shareToken
      ? ''
      : audience === 'anyone-public'
        ? `${origin}/share/flow/${shareToken}`
        : `${origin}/flows/${flowId}?share=${shareToken}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink)
      setCopied(true)
      toast.success('Link copied')
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  /** Everyone this jam can reach, as one list: workspace teammates first, then
   *  anyone who joined by link. `here` marks the people already in the jam, who
   *  need no ping. */
  const hereUserIds = new Set(here.map((p) => p.userId).filter(Boolean) as string[])
  const roster = [
    ...members.map((m) => ({
      id: m.id,
      label: m.name || m.email || 'Teammate',
      sub: m.name ? m.email : null,
      guest: false,
      here: hereUserIds.has(m.id),
    })),
    ...guests.map((g) => ({
      id: g.userId,
      label: g.name || g.email || 'Guest',
      sub: g.role === 'edit' ? 'joined by link · can edit' : 'joined by link · can view',
      guest: true,
      here: hereUserIds.has(g.userId),
    })),
  ]
  const needle = query.trim().toLowerCase()
  const visibleRoster = needle
    ? roster.filter((person) => `${person.label} ${person.sub ?? ''}`.toLowerCase().includes(needle))
    : roster

  const chipClass = (active: boolean) =>
    cn(
      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
      active
        ? 'border-indigo-300 bg-indigo-50/60 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200'
        : 'border-border/70 text-muted-foreground hover:bg-accent',
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] gap-0 overflow-y-auto p-0">
        {/* min-w-0: without it this grid item's min-content width is the full
            unwrapped title, which widens the track and pushes every section
            past the card edge. */}
        <DialogHeader className="min-w-0 border-b border-border/60 px-6 pb-4 pt-5 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 shrink-0 text-indigo-600" />
            <span className="min-w-0 truncate">Jam on “{flowName || 'this flow'}”</span>
          </DialogTitle>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid, so without it the unbroken mono
            invite URL sets this item's min-content width and pushes every row
            past the card edge. Sections are full-bleed and hairline-divided so
            the dialog reads as a few distinct rooms, not one long form. */}
        <div className="min-w-0 divide-y divide-border/60">
          {here.length > 0 && (
            <section className="bg-indigo-50/40 px-6 py-4 dark:bg-indigo-500/[0.06]">
              <p className="flex items-center gap-2 text-sm font-medium text-indigo-900 dark:text-indigo-200">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                In this jam now
              </p>
              {/* Every huddle control lives here — there is no separate huddle
                  bar over the canvas. Only mute is mirrored into the header. */}
              {huddle && (
                <div className="mt-2.5 border-t border-indigo-200/60 pt-2.5 dark:border-indigo-500/20">
                  <HuddlePanel
                    huddle={huddle}
                    members={huddleMembers ?? []}
                    startBlocked={huddleStartBlocked}
                    selfClientId={selfClientId ?? ''}
                    capture={capture}
                    captureAvailable={captureAvailable}
                  />
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap gap-2">
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
                    {p.needsFollow && (
                      <button
                        type="button"
                        onClick={() => onFollow?.(p.view === 'canvas' ? 'canvas' : 'inline')}
                        className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent"
                      >
                        {p.label} — follow
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </section>
          )}

          {visibleNotes.length > 0 && (
            <section className="space-y-2 px-6 py-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <NotebookPen className="h-4 w-4 text-muted-foreground" /> Huddle notes
              </p>
              <div className="max-h-48 space-y-2 overflow-y-auto">
                {visibleNotes.map((note) => (
                  <div key={note.id} className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-xs">
                    <p className="mb-1 text-[10px] font-medium text-muted-foreground">
                      {new Date(note.startedAt).toLocaleString()} · {(note.participants as string[]).join(', ')}
                    </p>
                    <p className="text-foreground">{note.summary}</p>
                    {note.decisions.length > 0 && (
                      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
                        {note.decisions.map((decision, index) => <li key={index}>{decision}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {canInvite && (
            <section className="space-y-2.5 px-6 py-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <UserPlus className="h-4 w-4 text-muted-foreground" />
                {huddle?.joined ? 'Ring people into the huddle' : 'Ping people into this jam'}
              </p>
              {roster.length > 6 && (
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search your workspace"
                  aria-label="Search your workspace"
                  className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                />
              )}
              {roster.length > 0 ? (
                <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-1">
                  {visibleRoster.map((person) => (
                    <li key={person.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold uppercase text-muted-foreground">
                        {person.label.trim().charAt(0) || '?'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{person.label}</span>
                        {person.sub && (
                          <span className="block truncate text-xs text-muted-foreground">{person.sub}</span>
                        )}
                      </span>
                      {person.here ? (
                        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                          In the jam
                        </span>
                      ) : person.guest ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
                          loading={removingGuest === person.id}
                          onClick={() => void removeGuest(person.id)}
                        >
                          Remove
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-xs"
                          loading={pinging === person.id}
                          onClick={() => void ping(person.id)}
                        >
                          {pinged.has(person.id) ? (
                            <><Check className="mr-1 h-3.5 w-3.5 text-green-600" /> Pinged</>
                          ) : (
                            <><Send className="mr-1 h-3.5 w-3.5" /> {huddle?.joined ? 'Ring' : 'Ping'}</>
                          )}
                        </Button>
                      )}
                    </li>
                  ))}
                  {visibleRoster.length === 0 && (
                    <li className="px-2 py-1.5 text-xs text-muted-foreground">Nobody by that name.</li>
                  )}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  You’re the only person in this workspace so far — add someone below, or send the link.
                </p>
              )}
              {isAdmin ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="teammate@company.com"
                    aria-label="Add someone new to your workspace"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                  />
                  <Button size="sm" onClick={() => void inviteByEmail()} loading={inviting} disabled={!inviteEmail.trim()}>
                    <UserPlus className="mr-1.5 h-4 w-4" /> Invite
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Only an admin can add people to your workspace. To bring in someone outside it, send them
                  the link below.
                </p>
              )}
              {isAdmin && (
                <p className="text-xs text-muted-foreground">
                  Someone new joins your workspace and lands straight on this flow.
                </p>
              )}
              {workspaceLink && (
                <p className="break-all rounded-lg border border-border/60 bg-muted/40 p-2 font-mono text-[11px]">{workspaceLink}</p>
              )}
            </section>
          )}

          {shareable && (
            <section className="space-y-2.5 px-6 py-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Link2 className="h-4 w-4 text-muted-foreground" /> Share link
              </p>
              {shareLink ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 py-1 pl-3 pr-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{shareLink}</span>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={copy}>
                    {copied ? <Check className="mr-1 h-3.5 w-3.5 text-green-600" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              ) : (
                <p className="rounded-lg border border-border/60 bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  The link is live, but it’s only shown once when it’s created — we don’t keep a copy. Rotate to
                  get a new one (which stops the old link working).
                </p>
              )}
              {canEdit && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {AUDIENCES.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      disabled={shareBusy}
                      aria-pressed={audience === option.key}
                      onClick={() => setAudience(option.key)}
                      className={chipClass(audience === option.key)}
                    >
                      {option.label}
                    </button>
                  ))}
                  {shareEnabled && (
                    <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" disabled={shareBusy} onClick={() => void updateShare(true, shareRole ?? 'view', true)}>
                      <RefreshCw className="mr-1 h-3 w-3" /> Rotate
                    </Button>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {audience === 'workspace'
                  ? 'Only people in your workspace can open this link.'
                  : audience === 'anyone-public'
                    ? `Anyone with this link sees a read-only picture of the steps — no settings, connected accounts, prompts or run history, and they can never edit or run it. ${
                        anonymousViews
                          ? `Opened ${anonymousViews} time${anonymousViews === 1 ? '' : 's'}.`
                          : 'Not opened yet.'
                      }`
                    : `Anyone with this link can sign in and ${audience === 'anyone-edit' ? 'edit' : 'view and run'} this flow. Rotating makes old links stop working; people who already accepted keep access until you remove them above.`}
              </p>
              {/* Only while a link is live: rotating re-mints one, so offering it
                  on a workspace-only flow would silently re-open the flow.
                  Guests can always be removed one at a time in the list above. */}
              {canEdit && shareEnabled && guests.length > 0 && (
                <button
                  type="button"
                  disabled={shareBusy}
                  onClick={() => void updateShare(true, shareRole ?? 'view', true, true)}
                  className="text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-destructive hover:underline"
                >
                  Rotate the link and remove everyone who joined by it
                </button>
              )}
            </section>
          )}

          {canEdit && !shareable && (
            <section className="px-6 py-4">
              <p className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
                This flow is private, so there is nothing to share yet. Choose “Everyone can view” or
                “Everyone can edit” below to invite teammates.
              </p>
            </section>
          )}

          <section className="space-y-2.5 px-6 py-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Lock className="h-4 w-4 text-muted-foreground" /> Workspace access
            </p>
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
                        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
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
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
