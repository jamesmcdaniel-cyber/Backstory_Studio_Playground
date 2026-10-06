'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronUp, History, Loader2, MessageSquare, Plug, Settings2, Sparkles, SquarePen, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { indentOnTab } from '@/components/ui/textarea'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { cn } from '@/lib/utils'
import type { ArtifactChatMessage, ArtifactView, CopilotMcpServerView, GuestCopilotView } from '@/lib/artifacts/types'
import { RunFeed } from '@/components/runs/run-feed'
import { McpConnectionDialog, draftAuthPayload, type McpAuthMode, type McpConnectionDraft } from '@/app/connections/mcp-connection-dialog'
import { useAgentExecStream } from '@/components/runs/use-agent-exec-stream'
import { ARTIFACT_FRAME_SANDBOX, StatefulArtifactFrame } from './stateful-artifact-frame'

/** Set before the sign-in redirect so the panel reopens on the way back. Only
 *  an explicit click writes it — a link alone can never create a copy. */
const RESUME_KEY = 'backstory:template-copilot'

/**
 * The copy the copilot works on. Someone signed in gets one in their own
 * workspace (the app's artifact APIs); anyone else gets a guest copy held by
 * the sender's workspace, reached only through this link's public endpoints.
 */
export type TemplateCopy =
  | { kind: 'member'; id: string; artifact: ArtifactView | null }
  | { kind: 'guest'; view: GuestCopilotView }
type Copy = TemplateCopy

/**
 * A shared template's public page with its copilot in place: the launcher sits
 * where Ask Backstory sits in the app, and the conversation opens over the
 * page — no account, no trip into the platform, no second page or window for
 * "their copy". Opening it makes (or finds) the visitor's own copy behind the
 * scenes and changes nothing on screen: the page they are looking at simply
 * becomes editable. `children` is the original, which is what an unedited copy
 * is; the frame moves to the copy only once the copilot has changed it.
 */
export function SharedTemplateCopilot({ token, isPage = true, returning = false, initialCopy, children }: { token: string; isPage?: boolean; returning?: boolean; /** The visitor's existing copy as the server resolved it (null: none) — the page then paints their latest version first, with no flash of the original. Left out, the copy is looked up after load. */ initialCopy?: TemplateCopy | null; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [copy, setCopy] = useState<Copy | null>(initialCopy ?? null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [markdown, setMarkdown] = useState<{ url: string; text: string } | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loading = useRef(false)
  const copyRef = useRef(copy)
  copyRef.current = copy
  const guestUrl = `/api/share/artifacts/${encodeURIComponent(token)}/copilot`

  const refresh = useCallback(async () => {
    const current = copyRef.current
    if (!current || loading.current) return // coalesce timer and run events
    loading.current = true
    try {
      const response = await fetch(current.kind === 'member' ? `/api/artifacts/${encodeURIComponent(current.id)}` : guestUrl, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; copilot?: GuestCopilotView | null; error?: string }
      if (current.kind === 'member') {
        if (!response.ok || !data.artifact) throw new Error(data.error || 'Could not load the copilot.')
        setCopy({ kind: 'member', id: current.id, artifact: data.artifact })
      } else {
        if (!response.ok || !data.copilot) throw new Error(data.error || 'Could not load the copilot.')
        setCopy({ kind: 'guest', view: data.copilot })
      }
      setError('')
    } catch (caught) {
      setError(caught instanceof Error && caught.name !== 'TimeoutError' ? caught.message : 'Could not load the copilot.')
    } finally { loading.current = false }
  }, [guestUrl])

  const openCopy = useCallback(async (resuming = false) => {
    setOpening(true)
    setError('')
    try {
      // Signed in: a copy of their own, in their workspace.
      const member = await fetch(`/api/share/artifacts/${encodeURIComponent(token)}/copy`, { method: 'POST' })
      if (member.status !== 401) {
        const data = await member.json().catch(() => ({})) as { artifactId?: string; error?: string }
        if (!member.ok || typeof data.artifactId !== 'string') throw new Error(data.error || 'Could not open the copilot. Please try again.')
        const next: Copy = { kind: 'member', id: data.artifactId, artifact: null }
        copyRef.current = next
        setCopy(next)
        await refresh()
        return
      }
      // No account: a guest copy, right here.
      const guest = await fetch(guestUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'open' }) })
      const data = await guest.json().catch(() => ({})) as { copilot?: GuestCopilotView; error?: string; code?: string }
      if (guest.ok && data.copilot) { setCopy({ kind: 'guest', view: data.copilot }); return }
      if (data.code !== 'SIGN_IN_REQUIRED') throw new Error(data.error || 'Could not open the copilot. Please try again.')
      // Nobody can host a guest copy on this template: signing in is the way.
      // Back from an abandoned sign-in, stay on the page rather than loop.
      if (resuming) { setOpen(false); return }
      try { window.sessionStorage.setItem(RESUME_KEY, token) } catch { /* storage blocked: they click once more */ }
      window.location.assign(`/auth/login?return_to=${encodeURIComponent(`/share/artifact/${token}`)}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open the copilot.')
    } finally { setOpening(false) }
  }, [token, guestUrl, refresh])

  useEffect(() => {
    let resume = false
    try {
      resume = window.sessionStorage.getItem(RESUME_KEY) === token
      if (resume) window.sessionStorage.removeItem(RESUME_KEY)
    } catch { /* storage blocked */ }
    if (resume) { setOpen(true); void openCopy(true); return }
    if (initialCopy !== undefined) return // the server already looked
    // Someone coming back sees the copy they already changed — its latest
    // version, panel closed — without having to open the copilot first.
    // Looking never creates a copy; only opening the copilot does.
    let cancelled = false
    void (async () => {
      try {
        // Signed in: their own copy, if they have made one.
        const member = await fetch(`/api/share/artifacts/${encodeURIComponent(token)}/copy`, { cache: 'no-store' })
        if (member.ok) {
          const data = await member.json().catch(() => ({})) as { artifactId?: string | null }
          if (cancelled || typeof data.artifactId !== 'string' || copyRef.current) return
          const next: Copy = { kind: 'member', id: data.artifactId, artifact: null }
          copyRef.current = next
          setCopy(next)
          await refresh()
          return
        }
        // No account: the guest copy this browser's cookie opens.
        if (!returning) return
        const guest = await fetch(guestUrl, { cache: 'no-store' })
        const data = guest.ok ? await guest.json() as { copilot?: GuestCopilotView | null } : null
        if (!cancelled && data?.copilot) setCopy((current) => current ?? { kind: 'guest', view: data.copilot! })
      } catch { /* the original stays on screen */ }
    })()
    return () => { cancelled = true }
  }, [token, returning, initialCopy, guestUrl, openCopy, refresh])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !copy && !opening) void openCopy()
  }

  const artifact = copy?.kind === 'member' ? copy.artifact : null
  const loaded = copy?.kind === 'guest' || Boolean(artifact)
  const chat: Array<Pick<ArtifactChatMessage, 'role' | 'content' | 'status' | 'createdAt' | 'executionId' | 'question' | 'versionId'>> = copy?.kind === 'guest' ? copy.view.chat : artifact?.chat ?? []
  const latestVersionId = copy?.kind === 'guest' ? copy.view.versionId : artifact?.currentVersionId ?? null
  const title = copy?.kind === 'guest' ? copy.view.title : artifact?.title ?? ''
  // An untouched copy IS the original: keep the page the visitor is already
  // looking at (and whatever they did in it) until there is a change to show.
  const edited = copy?.kind === 'guest' ? copy.view.edited : (artifact?.versionCount ?? 1) > 1
  const pending = chat.find((m) => m.status === 'pending')
  const busy = Boolean(pending)
  // The page moves to a new version ONCE, when the copilot has finished: a run
  // that saves several times on the way would otherwise reload it under the
  // visitor at every save.
  const [versionId, setVersionId] = useState<string | null>(latestVersionId)
  useEffect(() => { setVersionId((shown) => (!busy || shown === null ? latestVersionId : shown)) }, [busy, latestVersionId])
  // Version history: the copy's versions, newest first. Looking at an older
  // one is a view (`viewId`); the page otherwise follows the latest.
  const [chosenTab, setTab] = useState<'chat' | 'history' | 'settings'>('chat')
  const [viewId, setViewId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const versions = (copy?.kind === 'guest' ? copy.view.versions : artifact?.versions) ?? []
  const viewed = viewId ? versions.find((version) => version.id === viewId) ?? null : null
  const shownId = viewed && viewed.id !== latestVersionId ? viewed.id : versionId
  const viewingOlder = Boolean(viewed && shownId === viewed.id)
  const latestNumber = (copy?.kind === 'member' ? artifact?.versionCount : undefined) ?? versions[0]?.number ?? 1
  const viewVersion = (id: string) => setViewId(id === latestVersionId ? null : id)
  // History appears once there is one: an untouched copy has a single version.
  const tab = chosenTab === 'history' && versions.length <= 1 ? 'chat' : chosenTab
  // Settings: MCP servers the person connected themselves. A guest's arrive
  // with their copy; a member's are read when the tab is first opened.
  const [memberServers, setMemberServers] = useState<CopilotMcpServerView[] | null>(null)
  const servers = copy?.kind === 'guest' ? copy.view.mcpServers ?? [] : memberServers ?? []
  const memberCopyId = copy?.kind === 'member' ? copy.id : null
  useEffect(() => {
    if (tab !== 'settings' || !memberCopyId || memberServers) return
    let cancelled = false
    fetch(`/api/artifacts/${encodeURIComponent(memberCopyId)}/copilot-mcp`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { servers?: CopilotMcpServerView[] } | null) => { if (!cancelled) setMemberServers(data?.servers ?? []) })
      .catch(() => { if (!cancelled) setMemberServers([]) })
    return () => { cancelled = true }
  }, [tab, memberCopyId, memberServers])
  // The copilot paused on a question: it is asked and answered right here.
  const awaiting = pending?.question ?? null
  const hasCopy = Boolean(copy)
  // Only the person who owns the agent behind this copy can open its runs.
  // An anonymous visitor never can (their copilot runs as the sender), and
  // has no run feed at all.
  const ownsAgent = copy?.kind === 'member' && artifact?.permissions?.reason === 'owner'
  const canAsk = copy?.kind === 'guest' || (Boolean(artifact?.agent) && artifact?.permissions?.canEdit !== false && !artifact?.archivedAt)

  useEffect(() => (hasCopy && busy ? startVisibleInterval(() => void refresh(), 3_000) : undefined), [hasCopy, busy, refresh])
  useAgentExecStream(pending?.executionId, () => void refresh(), copy?.kind === 'member' && Boolean(pending?.executionId))
  useEffect(() => { if (open) chatEnd.current?.scrollIntoView({ block: 'nearest' }) }, [open, chat.length, pending])
  useEffect(() => { if (open && loaded) inputRef.current?.focus() }, [open, loaded, awaiting])

  // Where the copy's current version is served from. A guest copy is framed
  // from the public route; a member's goes through the app's stateful frame.
  const guestContentUrl = copy?.kind === 'guest' && shownId ? `${guestUrl}/content?copy=${encodeURIComponent(copy.view.copyId)}&v=${encodeURIComponent(shownId)}` : null
  const memberMarkdown = artifact?.versions.find((v) => v.id === shownId)?.format === 'markdown'
  const markdownUrl = copy?.kind === 'guest' ? (isPage ? null : guestContentUrl) : memberMarkdown && copy && shownId ? `/api/artifacts/${copy.id}/versions/${shownId}/content` : null
  useEffect(() => {
    if (!markdownUrl) return
    let cancelled = false
    fetch(markdownUrl, { cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('Could not load the document.'))))
      .then((text) => { if (!cancelled) setMarkdown({ url: markdownUrl, text }) })
      .catch(() => { if (!cancelled) setMarkdown({ url: markdownUrl, text: '_The document could not be loaded._' }) })
    return () => { cancelled = true }
  }, [markdownUrl])

  const send = async (event: React.FormEvent | null) => {
    event?.preventDefault()
    const outgoing = message.trim()
    if (!outgoing || sending || (busy && !awaiting) || !copy) return
    setSending(true)
    setError('')
    try {
      // While the copilot waits on its question, what is typed is the answer.
      const response = copy.kind === 'member'
        ? await fetch(`/api/artifacts/${encodeURIComponent(copy.id)}/${awaiting ? 'reply' : 'chat'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(awaiting ? { message: outgoing } : { message: outgoing, mode: 'auto' }) })
        : await fetch(guestUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: awaiting ? 'reply' : 'ask', message: outgoing }) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; copilot?: GuestCopilotView; error?: string }
      if (copy.kind === 'member' && response.ok && data.artifact) setCopy({ kind: 'member', id: copy.id, artifact: data.artifact })
      else if (copy.kind === 'guest' && response.ok && data.copilot) setCopy({ kind: 'guest', view: data.copilot })
      else throw new Error(data.error || 'The message could not be sent.')
      setMessage('')
      setViewId(null) // a new request works on, and shows, the latest version
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The message could not be sent.')
    } finally { setSending(false) }
  }

  // Start a new chat: the conversation is cleared; the page and its version
  // history stay as they are.
  const [clearing, setClearing] = useState(false)
  const newChat = async () => {
    if (!copy || clearing || busy || !chat.length) return
    setClearing(true)
    setError('')
    try {
      const response = copy.kind === 'member'
        ? await fetch(`/api/artifacts/${encodeURIComponent(copy.id)}/chat`, { method: 'DELETE' })
        : await fetch(guestUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'new_chat' }) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; copilot?: GuestCopilotView; error?: string }
      if (copy.kind === 'member' && response.ok && data.artifact) setCopy({ kind: 'member', id: copy.id, artifact: data.artifact })
      else if (copy.kind === 'guest' && response.ok && data.copilot) setCopy({ kind: 'guest', view: data.copilot })
      else throw new Error(data.error || 'A new chat could not be started.')
      setMessage('')
      setTab('chat')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'A new chat could not be started.')
    } finally { setClearing(false) }
  }

  // Put an earlier version back: it becomes a new version on top, so nothing
  // in the history is lost.
  const restore = async (target: string): Promise<string | null> => {
    if (!copy || restoring || busy) return null
    setRestoring(target)
    setError('')
    try {
      const response = copy.kind === 'member'
        ? await fetch(`/api/artifacts/${encodeURIComponent(copy.id)}/versions/${encodeURIComponent(target)}/restore`, { method: 'POST' })
        : await fetch(guestUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restore', versionId: target }) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; copilot?: GuestCopilotView; error?: string }
      if (copy.kind === 'member' && response.ok && data.artifact) setCopy({ kind: 'member', id: copy.id, artifact: data.artifact })
      else if (copy.kind === 'guest' && response.ok && data.copilot) setCopy({ kind: 'guest', view: data.copilot })
      else throw new Error(data.error || 'The version could not be restored.')
      setViewId(null)
      return null
    } catch (caught) {
      const failed = caught instanceof Error ? caught.message : 'The version could not be restored.'
      setError(failed)
      return failed
    } finally { setRestoring(null) }
  }

  // Connect or disconnect one of the person's own MCP servers. Resolves to an
  // error message, or null when it worked.
  const changeServers = async (change: { add: Record<string, unknown> } | { remove: string }): Promise<string | null> => {
    if (!copy) return 'Open the copilot again to continue.'
    try {
      const response = copy.kind === 'member'
        ? await fetch(`/api/artifacts/${encodeURIComponent(copy.id)}/copilot-mcp`, { method: 'add' in change ? 'POST' : 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify('add' in change ? change.add : { serverId: change.remove }) })
        : await fetch(guestUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify('add' in change ? { action: 'mcp_add', server: change.add } : { action: 'mcp_remove', serverId: change.remove }) })
      const data = await response.json().catch(() => ({})) as { servers?: CopilotMcpServerView[]; copilot?: GuestCopilotView; error?: string }
      if (copy.kind === 'member' && response.ok && data.servers) setMemberServers(data.servers)
      else if (copy.kind === 'guest' && response.ok && data.copilot) setCopy({ kind: 'guest', view: data.copilot })
      else return data.error || 'That did not work. Please try again.'
      return null
    } catch {
      return 'That did not work. Please try again.'
    }
  }

  // "Test connection": ask the server for its tools with what was entered; nothing is stored.
  const testServer = async (server: Record<string, unknown>): Promise<{ ok: true; toolCount: number; toolNames: string[] } | { ok: false; error: string }> => {
    if (!copy) return { ok: false, error: 'Open the copilot again to continue.' }
    try {
      const response = copy.kind === 'member'
        ? await fetch(`/api/artifacts/${encodeURIComponent(copy.id)}/copilot-mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...server, test: true }) })
        : await fetch(guestUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'mcp_test', server }) })
      const data = await response.json().catch(() => ({})) as { test?: { toolCount: number; toolNames: string[] }; error?: string }
      return response.ok && data.test ? { ok: true, ...data.test } : { ok: false, error: data.error || 'Connection failed' }
    } catch {
      return { ok: false, error: 'Network error — check the server URL' }
    }
  }

  return (
    <>
      {copy && loaded && shownId && edited ? (
        markdownUrl ? (
          <div className="prose prose-sm mx-auto w-full max-w-3xl p-6 dark:prose-invert">
            {markdown?.url === markdownUrl ? <Markdown>{markdown.text}</Markdown> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</p>}
          </div>
        ) : copy.kind === 'guest' ? (
          <iframe key={shownId} title={title} src={guestContentUrl!} sandbox={ARTIFACT_FRAME_SANDBOX} className="block h-dvh w-full border-0" />
        ) : (
          <StatefulArtifactFrame key={copy.id} artifactId={copy.id} versionId={shownId} writable={canAsk && shownId === latestVersionId} title={title} className="h-dvh w-full" />
        )
      ) : children}

      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="AI Copilot"
          // Sized like the assistant panel beside an artifact in the app: tall
          // enough to read a conversation and a version history without scrolling
          // a letterbox.
          className="fixed bottom-4 right-4 z-40 flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[440px] flex-col overflow-hidden rounded-2xl border border-graphite-200 bg-white shadow-4 motion-safe:animate-fade-in-up sm:bottom-24 sm:h-[min(860px,calc(100dvh-8rem))]"
        >
          <header className="flex items-center gap-2 border-b border-graphite-200 px-4 py-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-horizon-50 text-horizon-600"><Sparkles className="h-4 w-4" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-graphite-900">AI Copilot</p>
              <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">Edits stay on your view of this page</p>
            </div>
            {loaded && canAsk && chat.length > 0 && (
              <button type="button" onClick={() => void newChat()} disabled={busy || clearing} title={busy ? 'Wait for the copilot to finish' : 'Start a new chat — the page and its versions are kept'} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900 disabled:opacity-50">
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <SquarePen className="h-3.5 w-3.5" aria-hidden />}New chat
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900" aria-label="Close AI Copilot">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          {loaded && (
            <div role="tablist" aria-label="Copilot views" className="flex border-b border-graphite-200 text-xs font-medium">
              {(['chat', 'history', 'settings'] as const).filter((option) => (option !== 'history' || versions.length > 1) && (option !== 'settings' || canAsk)).map((option) => (
                <button key={option} type="button" role="tab" aria-selected={tab === option} onClick={() => setTab(option)} className={cn('-mb-px inline-flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2', tab === option ? 'border-horizon-600 text-graphite-900' : 'border-transparent text-fg-muted hover:text-graphite-900')}>
                  {option === 'chat' ? <MessageSquare className="h-3.5 w-3.5" aria-hidden /> : option === 'history' ? <History className="h-3.5 w-3.5" aria-hidden /> : <Settings2 className="h-3.5 w-3.5" aria-hidden />}
                  {option === 'chat' ? 'Chat' : option === 'history' ? `History (${latestNumber})` : 'Settings'}
                </button>
              ))}
            </div>
          )}
          {viewed && viewingOlder && (
            <p role="status" className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
              <span>Viewing version {viewed.number} — not the latest.</span>
              <button type="button" onClick={() => setViewId(null)} className="font-medium underline underline-offset-2">Back to latest</button>
            </p>
          )}

          {tab === 'settings' && loaded && canAsk ? (
            <CopilotSettings servers={servers} loading={copy?.kind === 'member' && memberServers === null} busy={busy} onChange={changeServers} onTest={testServer} />
          ) : tab === 'history' ? (
            <VersionList
              label="Version history"
              versions={versions}
              latestId={latestVersionId}
              shownId={shownId}
              canRestore={canAsk}
              restoring={restoring}
              busy={busy}
              onView={viewVersion}
              onRestore={(id) => void restore(id)}
              className="min-h-0 flex-1"
            >
              {error && <li role="alert" className="px-4 py-3 text-sm text-destructive">{error}</li>}
            </VersionList>
          ) : (
          <div aria-label="Copilot conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto break-words px-4 py-3">
            {opening && <p className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Opening the copilot…</p>}
            {loaded && !chat.length && (
              <p className="text-sm text-fg-muted">
                {canAsk ? 'Ask a question about this page or describe a change. Your changes appear right here and only for you — the original stays as it was shared.' : 'This copy can’t be changed right now.'}
              </p>
            )}
            {chat.map((m, index) => (
              <div key={`${m.createdAt}-${index}`} className={cn('text-sm', m.role === 'user' && 'ml-6 rounded-xl bg-horizon-50 px-3 py-2')}>
                {m.role === 'agent' && m.status === 'pending' && m.question ? (
                  <div role="status" className="rounded-xl border border-horizon-200 bg-horizon-50/60 px-3 py-2">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-horizon-700">The copilot needs an answer</p>
                    <Markdown>{m.question}</Markdown>
                  </div>
                ) : m.role === 'agent' && m.status === 'pending' ? (
                  // The run feed reads the app's run APIs, which a guest has no session for.
                  m.executionId && copy?.kind === 'member' ? <RunFeed executionId={m.executionId} status="running" compact quietUntilWork runsLink={ownsAgent} onStatusChange={() => void refresh()} /> :
                    <div className="flex items-center gap-2 text-fg-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Working on it…</div>
                ) : m.role === 'agent' ? (
                  <div className={cn(m.status === 'failed' && 'text-destructive')}>
                    <Markdown>{m.content}</Markdown>
                    {/* The version this reply made, one click away — as in the app. */}
                    {m.versionId && m.versionId !== shownId && versions.some((version) => version.id === m.versionId) && (
                      <button type="button" onClick={() => viewVersion(m.versionId!)} className="mt-1 text-xs font-medium text-horizon-700 underline underline-offset-2">View this version</button>
                    )}
                  </div>
                ) : (
                  <p>{m.content}</p>
                )}
              </div>
            ))}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}{' '}
                {!loaded && !opening && <button type="button" onClick={() => void (copy ? refresh() : openCopy())} className="underline">Try again</button>}
              </p>
            )}
            <div ref={chatEnd} />
          </div>
          )}

          {loaded && canAsk && tab === 'chat' && (
            <form onSubmit={send} className="border-t border-graphite-200 p-3">
              <label htmlFor="template-copilot-message" className="sr-only">Message</label>
              <div className="flex items-end gap-2">
                <textarea
                  id="template-copilot-message"
                  ref={inputRef}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => { indentOnTab(event); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) } }}
                  rows={2}
                  maxLength={2000}
                  disabled={busy && !awaiting}
                  placeholder={awaiting ? 'Type your answer' : busy ? 'Waiting for the copilot…' : 'Ask a question or describe a change'}
                  className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                />
                <Button type="submit" size="icon" disabled={!message.trim() || sending || (busy && !awaiting)} aria-label={awaiting ? 'Send answer' : 'Send message'}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
                </Button>
              </div>
              {/* A visitor's daily allowance on a shared link, so a limit is never a surprise. */}
              {copy?.kind === 'guest' && copy.view.usage && (() => {
                const questions = Math.max(0, copy.view.usage.queries.limit - copy.view.usage.queries.used)
                const changes = Math.max(0, copy.view.usage.changes.limit - copy.view.usage.changes.used)
                return (
                  <p className={cn('mt-1.5 text-[11px]', questions === 0 || changes === 0 ? 'text-amber-700' : 'text-fg-muted')}>
                    {questions === 0
                      ? `Today’s ${copy.view.usage.queries.limit} questions are used — more tomorrow.`
                      : `${questions} of ${copy.view.usage.queries.limit} questions and ${changes} of ${copy.view.usage.changes.limit} changes left today.`}
                  </p>
                )
              })()}
            </form>
          )}
        </div>
      )}

      {/* Version control on the page itself once the copy has changed, so the
          visitor's versions are in reach with the copilot closed. While the
          panel is open its History tab is the version control instead. */}
      {copy && loaded && versions.length > 1 && !open && (
        <VersionControl
          versions={versions}
          latestId={latestVersionId}
          latestNumber={latestNumber}
          shownId={shownId}
          viewingOlder={viewingOlder}
          canRestore={canAsk}
          restoring={restoring}
          busy={busy}
          onView={viewVersion}
          onLatest={() => setViewId(null)}
          onRestore={restore}
        />
      )}

      {/* Ask Backstory's launcher, to the pixel: same corner, same pill. Hidden
          while the panel is open on a phone, where the panel covers it. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? 'Close AI Copilot' : 'AI Copilot'}
        className={cn(
          'fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-graphite-200 bg-white py-2.5 pl-3 pr-4 text-sm font-medium text-graphite-900 shadow-3 transition-[transform,box-shadow,border-color] duration-base hover:-translate-y-0.5 hover:border-horizon-300 hover:shadow-4',
          open && 'hidden sm:flex',
        )}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-horizon-50 text-horizon-600">
          {open ? <X className="h-3.5 w-3.5" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
        </span>
        <span className="hidden sm:inline">{open ? 'Close' : 'AI Copilot'}</span>
      </button>
    </>
  )
}

type VersionRow = { id: string; number: number; request?: string | null; createdAt: string; source?: string }

/**
 * The copy's versions, newest first: any one can be viewed, and an earlier one
 * restored as a new version on top, so nothing is lost. The copilot's History
 * tab and the on-page version control both list them this way.
 */
function VersionList({ label, versions, latestId, shownId, canRestore, restoring, busy, onView, onRestore, className, children }: {
  label: string
  versions: VersionRow[]
  latestId: string | null
  shownId: string | null
  canRestore: boolean
  restoring: string | null
  busy: boolean
  onView: (id: string) => void
  onRestore: (id: string) => void
  className?: string
  children?: ReactNode
}) {
  return (
    <ol aria-label={label} className={cn('divide-y divide-graphite-200 overflow-y-auto', className)}>
      {versions.map((version) => {
        const isCurrent = version.id === latestId
        const isShown = version.id === shownId
        return (
          <li key={version.id} className={cn('px-4 py-3 text-xs', isShown && 'bg-graphite-50')}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-graphite-900">Version {version.number}</span>
              {isCurrent && <span className="rounded-full bg-horizon-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">Current</span>}
            </div>
            <p className="mt-0.5 text-fg-muted">
              {new Date(version.createdAt).toLocaleString()}{' · '}{version.source === 'created' ? 'As shared' : version.source === 'restore' ? 'Restored' : 'Copilot'}
            </p>
            {version.request && version.source !== 'created' && <p className="mt-1 line-clamp-3 text-graphite-900">{version.request}</p>}
            <div className="mt-2 flex flex-wrap gap-3">
              {!isShown && <button type="button" onClick={() => onView(version.id)} className="font-medium text-horizon-700 underline underline-offset-2">View</button>}
              {!isCurrent && canRestore && (
                <button type="button" disabled={restoring !== null || busy} onClick={() => onRestore(version.id)} className="font-medium text-horizon-700 underline underline-offset-2 disabled:opacity-50">
                  {restoring === version.id ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </div>
          </li>
        )
      })}
      {children}
    </ol>
  )
}

/**
 * Version control on the shared page, once the visitor's copy has changed: the
 * version on screen, the list of every version, and — while an older one is
 * shown — Restore and the way back to the latest. It sits in the corner
 * opposite the copilot's launcher, in the same pill.
 */
function VersionControl({ versions, latestId, latestNumber, shownId, viewingOlder, canRestore, restoring, busy, onView, onLatest, onRestore }: {
  versions: VersionRow[]
  latestId: string | null
  latestNumber: number
  shownId: string | null
  viewingOlder: boolean
  canRestore: boolean
  restoring: string | null
  busy: boolean
  onView: (id: string) => void
  onLatest: () => void
  onRestore: (id: string) => Promise<string | null>
}) {
  const [expanded, setExpanded] = useState(false)
  const [problem, setProblem] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const shown = versions.find((version) => version.id === shownId) ?? versions[0]

  // The list closes on Escape (focus back on its toggle) or a click elsewhere.
  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setExpanded(false); toggleRef.current?.focus() } }
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setExpanded(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer) }
  }, [expanded])

  // Viewing or restoring closes the list, so the page it changed is in sight.
  const view = (id: string) => { setProblem(''); onView(id); setExpanded(false) }
  const restore = async (id: string) => {
    setProblem('')
    const failed = await onRestore(id)
    if (failed) setProblem(failed)
    else setExpanded(false)
  }
  const action = 'px-3 py-2.5 text-sm font-medium underline-offset-2 transition-colors hover:underline disabled:opacity-50'

  return (
    <div ref={root} role="group" aria-label="Your versions" className="fixed bottom-4 left-4 z-40 flex max-w-[calc(100vw-6rem)] flex-col items-start gap-2">
      {expanded && (
        <div id={listId} className="flex max-h-[min(28rem,calc(100dvh-6rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-graphite-200 bg-white shadow-4 motion-safe:animate-fade-in-up">
          <div className="border-b border-graphite-200 px-4 py-3">
            <p className="text-sm font-semibold text-graphite-900">Your versions</p>
            <p className="mt-0.5 text-xs text-fg-muted">Only you see these changes. Version 1 is the page as it was shared.</p>
          </div>
          <VersionList label="Versions of your copy" versions={versions} latestId={latestId} shownId={shownId} canRestore={canRestore} restoring={restoring} busy={busy} onView={view} onRestore={(id) => void restore(id)} className="min-h-0 flex-1" />
        </div>
      )}
      {problem && <p role="alert" className="rounded-lg border border-graphite-200 bg-white px-3 py-2 text-xs text-destructive shadow-2">{problem}</p>}
      <div className={cn('flex items-center rounded-full border shadow-3', viewingOlder ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-graphite-200 bg-white text-graphite-900')}>
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          title={viewingOlder ? 'An earlier version of your copy is on screen' : 'Your copy’s versions'}
          className="flex min-w-0 items-center gap-2 rounded-full py-2.5 pl-3 pr-3 text-sm font-medium transition-colors hover:bg-black/[0.03]"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-horizon-50 text-horizon-600">
            {busy && !viewingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <History className="h-3.5 w-3.5" aria-hidden />}
          </span>
          <span className="truncate"><span className="sr-only sm:not-sr-only">Version </span>{shown.number} of {latestNumber}</span>
          <ChevronUp className={cn('h-3.5 w-3.5 shrink-0 transition-transform', !expanded && 'rotate-180')} aria-hidden />
        </button>
        {viewingOlder && (
          <>
            {canRestore && (
              <button type="button" disabled={restoring !== null || busy} onClick={() => void restore(shown.id)} className={cn(action, 'border-l border-amber-300')}>
                {restoring === shown.id ? 'Restoring…' : 'Restore'}
              </button>
            )}
            <button type="button" onClick={() => { setProblem(''); onLatest() }} aria-label="Back to latest" className={cn(action, 'border-l border-amber-300 pr-4')}>
              <span className="sm:hidden">Latest</span><span className="hidden sm:inline">Back to latest</span>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const AUTH_LABEL: Record<CopilotMcpServerView['authType'], string> = { none: 'No sign-in', api_key: 'Access token', oauth2: 'Client credentials' }
// No 'sso': an OAuth redirect needs a signed-in session to come back to, and
// the person here brings a credential they already hold.
const COPILOT_AUTH_MODES: McpAuthMode[] = ['none', 'api_key', 'client_credentials']

/** The dialog's draft as the copilot endpoints take it. */
const serverPayload = (draft: McpConnectionDraft): Record<string, unknown> => ({
  serverUrl: draft.serverUrl.trim(),
  ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
  ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
  ...draftAuthPayload(draft),
})

/**
 * The copilot's settings: the person's own MCP servers, added through the
 * same dialog the platform's MCP Servers page uses. Connecting one makes it
 * the copilot's data source for their copy — in place of the demo data the
 * link came with — using a credential they already hold for that server.
 */
function CopilotSettings({ servers, loading, busy, onChange, onTest }: {
  servers: CopilotMcpServerView[]
  loading: boolean
  busy: boolean
  onChange: (change: { add: Record<string, unknown> } | { remove: string }) => Promise<string | null>
  onTest: (server: Record<string, unknown>) => Promise<{ ok: true; toolCount: number; toolNames: string[] } | { ok: false; error: string }>
}) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [problem, setProblem] = useState('')

  const remove = async (id: string) => {
    if (removing) return
    setRemoving(id)
    setProblem('')
    const failed = await onChange({ remove: id })
    if (failed) setProblem(failed)
    setRemoving(null)
  }

  return (
    <div aria-label="Copilot settings" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
      <div>
        <p className="flex items-center gap-1.5 font-semibold text-graphite-900"><Plug className="h-4 w-4 text-horizon-600" aria-hidden /> Your data</p>
        <p className="mt-1 text-xs text-fg-muted">
          Connect your own MCP server and the copilot uses it — instead of the demo data — when it changes this page. Your credential is encrypted, used only for your copy, and never shown again.
        </p>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-fg-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading…</p>
      ) : servers.length > 0 ? (
        <ul aria-label="Connected servers" className="space-y-2">
          {servers.map((server) => (
            <li key={server.id} className="flex items-center justify-between gap-2 rounded-lg border border-graphite-200 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium text-graphite-900">{server.name}</span>
                {server.description && <span className="block truncate text-xs text-fg-muted">{server.description}</span>}
                <span className="block truncate text-xs text-fg-muted">{server.serverUrl}</span>
                <span className="block text-xs text-fg-muted">{AUTH_LABEL[server.authType]} · {server.toolCount} tool{server.toolCount === 1 ? '' : 's'}</span>
              </span>
              <button type="button" disabled={removing !== null || busy} onClick={() => void remove(server.id)} aria-label={`Remove ${server.name}`} className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-destructive disabled:opacity-50">
                {removing === server.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-graphite-200 px-3 py-2 text-xs text-fg-muted">No server connected — the copilot is using the demo data this link came with.</p>
      )}
      {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}

      {!loading && servers.length < 3 && (
        <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}><Plug className="mr-1.5 h-3.5 w-3.5" aria-hidden />Add MCP server</Button>
      )}

      <McpConnectionDialog
        open={adding}
        onOpenChange={setAdding}
        authModes={COPILOT_AUTH_MODES}
        showSaveErrors
        onTest={(draft) => onTest(serverPayload(draft))}
        onSave={async (draft) => {
          const failed = await onChange({ add: serverPayload(draft) })
          if (failed) throw new Error(failed)
        }}
      />
    </div>
  )
}
