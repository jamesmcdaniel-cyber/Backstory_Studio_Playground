'use client'

import { GUEST_COPILOT_LIMITS } from '@/lib/artifacts/template-policy'
import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Globe, Link2, Loader2, RefreshCw, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type Person = { id: string; name: string | null; email: string | null }
type Sharing = {
  shareTemplate: boolean
  copilotSources?: string[]
  workspaceAccess: 'edit' | 'view'
  owner: Person | null
  editors: Person[]
  link: { enabled: boolean; url: string | null; views: number }
  permissions: { canEdit: boolean; canShare: boolean; reason: string }
}

const nameOf = (person: Person) => person.name || person.email || 'Unknown'

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check className="mr-1.5 h-3.5 w-3.5 text-green-600" aria-hidden /> : <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

/**
 * Share an artifact: its link for the workspace, who can edit it, and an
 * optional view-only public link. Every change saves as it is made.
 */
export function ShareDialog({ artifactId, title, open, onOpenChange }: { artifactId: string; title: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [sharing, setSharing] = useState<Sharing | null>(null)
  const [members, setMembers] = useState<Person[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch(`/api/artifacts/${artifactId}/sharing`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => { if (!cancelled && data.success) setSharing(data as Sharing) })
      .catch(() => undefined)
    fetch('/api/organizations/members', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { members?: Person[] }) => { if (!cancelled) setMembers(data.members ?? []) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [open, artifactId])

  const update = async (patch: Record<string, unknown>, success?: string) => {
    setBusy(true)
    try {
      const response = await fetch(`/api/artifacts/${artifactId}/sharing`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Sharing could not be changed.')
      setSharing(data as Sharing)
      if (success) toast.success(success)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const workspaceUrl = typeof window !== 'undefined' ? `${window.location.origin}/artifacts/${artifactId}` : ''
  const canShare = sharing?.permissions.canShare ?? false
  const editorIds = useMemo(() => new Set(sharing?.editors.map((editor) => editor.id) ?? []), [sharing])
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return members
      .filter((member) => member.id !== sharing?.owner?.id && !editorIds.has(member.id))
      .filter((member) => `${member.name ?? ''} ${member.email ?? ''}`.toLowerCase().includes(q))
      .slice(0, 6)
  }, [members, query, sharing, editorIds])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{title}”</DialogTitle>
          <DialogDescription>Everyone in your workspace can open it with the link. Choose who can change it, and whether anyone outside can view it.</DialogDescription>
        </DialogHeader>
        {!sharing ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>
        ) : (
          <div className="space-y-6">
            <section className="space-y-2">
              <p className="flex items-center gap-1.5 text-sm font-medium"><Link2 className="h-4 w-4" aria-hidden /> Workspace link</p>
              <div className="flex items-center gap-2">
                <Input readOnly value={workspaceUrl} aria-label="Workspace link" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                <CopyButton value={workspaceUrl} label="Copy" />
              </div>
              <label htmlFor="share-workspace-access" className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Everyone in the workspace can</span>
                <select
                  id="share-workspace-access"
                  value={sharing.workspaceAccess}
                  disabled={!canShare || busy}
                  onChange={(event) => void update({ workspaceAccess: event.target.value }, event.target.value === 'edit' ? 'Workspace members can now edit.' : 'Workspace members can now only view.')}
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
                >
                  <option value="edit">edit</option>
                  <option value="view">view</option>
                </select>
              </label>
            </section>

            <section className="space-y-2">
              <p className="flex items-center gap-1.5 text-sm font-medium"><Users className="h-4 w-4" aria-hidden /> People who can edit</p>
              {canShare && (
                <div className="relative">
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Add people by name or email" aria-label="Add an editor" disabled={busy} />
                  {candidates.length > 0 && (
                    <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
                      {candidates.map((member) => (
                        <li key={member.id}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                            onClick={() => { setQuery(''); void update({ editorIds: [...editorIds, member.id] }, `${nameOf(member)} can now edit — they've been notified.`) }}
                          >
                            <span className="truncate">{nameOf(member)}</span>
                            <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <ul className="divide-y divide-border rounded-md border border-border text-sm">
                {sharing.owner && (
                  <li className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 truncate">{nameOf(sharing.owner)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">Owner</span>
                  </li>
                )}
                {sharing.editors.map((editor) => (
                  <li key={editor.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 truncate">{nameOf(editor)} <span className="text-xs text-muted-foreground">{editor.email}</span></span>
                    {canShare ? (
                      <button type="button" disabled={busy} onClick={() => void update({ editorIds: [...editorIds].filter((id) => id !== editor.id) })} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remove ${nameOf(editor)}`}>
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : <span className="shrink-0 text-xs text-muted-foreground">Editor</span>}
                  </li>
                ))}
                {sharing.workspaceAccess === 'edit' && <li className="px-3 py-2 text-xs text-muted-foreground">Plus every workspace member whose role can edit.</li>}
              </ul>
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-1.5 text-sm font-medium"><Globe className="h-4 w-4" aria-hidden /> Anyone with the link can view</p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={sharing.link.enabled}
                  aria-label="Anyone with the link can view"
                  disabled={!canShare || busy}
                  onClick={() => void update({ link: sharing.link.enabled ? 'disable' : 'enable' }, sharing.link.enabled ? 'Public link turned off.' : 'Public link is on — anyone with it can view.')}
                  className={cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', sharing.link.enabled ? 'bg-horizon-600' : 'bg-muted-foreground/30')}
                >
                  <span className={cn('block h-4 w-4 rounded-full bg-white shadow transition-transform', sharing.link.enabled ? 'translate-x-4' : 'translate-x-0.5')} />
                </button>
              </div>
              <p className="text-xs text-muted-foreground">No sign-in needed. They see the current version only — no assistant, history or anything else in the workspace. The data on it leaves the workspace, so share with care.</p>
              {sharing.link.enabled && <div className="space-y-2 rounded-lg border border-border p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={sharing.shareTemplate} disabled={!canShare || busy} onChange={event => void update({ shareTemplate: event.target.checked })} />
                  Offer as a template with AI Copilot
                </label>
                <p className="text-xs text-muted-foreground">Anyone with the link can open the AI Copilot on it — no sign-in — and change their own copy of the published source, including data embedded in it. The original never changes. Visitors without an account work in a hidden copy in this workspace: their copilot runs count toward this workspace’s usage, up to {GUEST_COPILOT_LIMITS.messagesPerVisitor} messages a visitor and {GUEST_COPILOT_LIMITS.messagesPerTemplate} a day per link. Signed-in recipients get a copy in their own workspace with its own agent. Your integrations, private app state and history are not copied. Turning this off stops the copilot for visitors and new copies; signed-in recipients keep theirs.</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Data the copilot can query: </span>
                  {sharing.copilotSources?.length
                    ? <>{sharing.copilotSources.join(', ')} only — the MCP servers marked shareable. No live Backstory data, other MCP servers or integrations.</>
                    : <>none — it can only edit the page. To give it demo data, mark an MCP server as shareable under Integrations → MCP Servers. Live Backstory data, other MCP servers and integrations are never available to it.</>}
                </p>
              </div>}
              {sharing.link.enabled && sharing.link.url && (
                <div className="flex items-center gap-2">
                  <Input readOnly value={sharing.link.url} aria-label="Public link" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                  <CopyButton value={sharing.link.url} label="Copy" />
                  {canShare && (
                    <Button type="button" variant="ghost" size="sm" disabled={busy} title="Replace the link — the old one stops working" onClick={() => void update({ link: 'rotate' }, 'New link made; the old one no longer works.')}>
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">Reset link</span>
                    </Button>
                  )}
                </div>
              )}
              {sharing.link.enabled && <p className="text-xs text-muted-foreground">{sharing.link.views.toLocaleString()} view{sharing.link.views === 1 ? '' : 's'} so far.</p>}
            </section>

            {!canShare && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">You can view this artifact. Its owner or an editor can give you edit access.</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
