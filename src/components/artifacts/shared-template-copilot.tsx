'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Loader2, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { indentOnTab } from '@/components/ui/textarea'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { cn } from '@/lib/utils'
import type { ArtifactChatMessage, ArtifactView, GuestCopilotView } from '@/lib/artifacts/types'
import { RunFeed } from '@/components/runs/run-feed'
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
type Copy =
  | { kind: 'member'; id: string; artifact: ArtifactView | null }
  | { kind: 'guest'; view: GuestCopilotView }

/**
 * A shared template's public page with its copilot in place: the launcher sits
 * where Ask Backstory sits in the app, and the conversation opens over the
 * page — no account, no trip into the platform, no second page or window for
 * "their copy". Opening it makes (or finds) the visitor's own copy behind the
 * scenes and changes nothing on screen: the page they are looking at simply
 * becomes editable. `children` is the original, which is what an unedited copy
 * is; the frame moves to the copy only once the copilot has changed it.
 */
export function SharedTemplateCopilot({ token, isPage = true, returning = false, children }: { token: string; isPage?: boolean; returning?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [copy, setCopy] = useState<Copy | null>(null)
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
    if (!returning) return
    // A returning visitor sees the copy they already changed, panel closed.
    let cancelled = false
    fetch(guestUrl, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { copilot?: GuestCopilotView | null } | null) => { if (!cancelled && data?.copilot) setCopy((current) => current ?? { kind: 'guest', view: data.copilot! }) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [token, returning, guestUrl, openCopy])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !copy && !opening) void openCopy()
  }

  const artifact = copy?.kind === 'member' ? copy.artifact : null
  const loaded = copy?.kind === 'guest' || Boolean(artifact)
  const chat: Array<Pick<ArtifactChatMessage, 'role' | 'content' | 'status' | 'createdAt' | 'executionId' | 'question'>> = copy?.kind === 'guest' ? copy.view.chat : artifact?.chat ?? []
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
  const [versionId, setVersionId] = useState<string | null>(null)
  useEffect(() => { setVersionId((shown) => (!busy || shown === null ? latestVersionId : shown)) }, [busy, latestVersionId])
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
  const guestContentUrl = copy?.kind === 'guest' && versionId ? `${guestUrl}/content?copy=${encodeURIComponent(copy.view.copyId)}&v=${encodeURIComponent(versionId)}` : null
  const memberMarkdown = artifact?.versions.find((v) => v.id === versionId)?.format === 'markdown'
  const markdownUrl = copy?.kind === 'guest' ? (isPage ? null : guestContentUrl) : memberMarkdown && copy && versionId ? `/api/artifacts/${copy.id}/versions/${versionId}/content` : null
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The message could not be sent.')
    } finally { setSending(false) }
  }

  return (
    <>
      {copy && loaded && versionId && edited ? (
        markdownUrl ? (
          <div className="prose prose-sm mx-auto w-full max-w-3xl p-6 dark:prose-invert">
            {markdown?.url === markdownUrl ? <Markdown>{markdown.text}</Markdown> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</p>}
          </div>
        ) : copy.kind === 'guest' ? (
          <iframe key={versionId} title={title} src={guestContentUrl!} sandbox={ARTIFACT_FRAME_SANDBOX} className="block h-dvh w-full border-0" />
        ) : (
          <StatefulArtifactFrame key={copy.id} artifactId={copy.id} versionId={versionId} writable={canAsk} title={title} className="h-dvh w-full" />
        )
      ) : children}

      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="AI Copilot"
          // Same footprint as Ask Backstory's panel in the app.
          className="fixed bottom-4 right-4 z-40 flex h-[min(600px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[400px] flex-col overflow-hidden rounded-2xl border border-graphite-200 bg-white shadow-4 motion-safe:animate-fade-in-up sm:bottom-24 sm:h-[min(560px,calc(100dvh-8rem))]"
        >
          <header className="flex items-center gap-2 border-b border-graphite-200 px-4 py-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-horizon-50 text-horizon-600"><Sparkles className="h-4 w-4" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-graphite-900">AI Copilot</p>
              <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">Edits stay on your view of this page</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900" aria-label="Close AI Copilot">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

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
                  m.executionId && copy?.kind === 'member' ? <RunFeed executionId={m.executionId} status="running" compact runsLink={ownsAgent} onStatusChange={() => void refresh()} /> :
                    <div className="flex items-center gap-2 text-fg-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Working on it…</div>
                ) : m.role === 'agent' ? (
                  <div className={cn(m.status === 'failed' && 'text-destructive')}><Markdown>{m.content}</Markdown></div>
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

          {loaded && canAsk && (
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
            </form>
          )}
        </div>
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
