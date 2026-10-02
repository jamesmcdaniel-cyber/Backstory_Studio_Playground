'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ExternalLink, Loader2, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { indentOnTab } from '@/components/ui/textarea'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { cn } from '@/lib/utils'
import type { ArtifactView } from '@/lib/artifacts/types'
import { RunFeed } from '@/components/runs/run-feed'
import { useAgentExecStream } from '@/components/runs/use-agent-exec-stream'
import { StatefulArtifactFrame } from './stateful-artifact-frame'

/** Set before the sign-in redirect so the panel reopens on the way back. Only
 *  an explicit click writes it — a link alone can never create a copy. */
const RESUME_KEY = 'backstory:template-copilot'

/**
 * A shared template's public page with its copilot in place: the launcher sits
 * where Ask Backstory sits in the app, and the conversation opens over the
 * page instead of sending the visitor into the platform. Opening it makes (or
 * finds) the visitor's own copy; from then on the page shows that copy, so
 * every change the copilot makes lands in front of them. `children` is the
 * original, shown until a copy exists.
 */
export function SharedTemplateCopilot({ token, children }: { token: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [copyId, setCopyId] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<ArtifactView | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [markdown, setMarkdown] = useState<{ versionId: string; text: string } | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loading = useRef(false)

  const refresh = useCallback(async (id: string) => {
    if (loading.current) return // coalesce timer and run events
    loading.current = true
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; error?: string }
      if (!response.ok || !data.artifact) throw new Error(data.error || 'Could not load your copy.')
      setArtifact(data.artifact)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error && caught.name !== 'TimeoutError' ? caught.message : 'Could not load your copy.')
    } finally { loading.current = false }
  }, [])

  const openCopy = useCallback(async (resuming = false) => {
    setOpening(true)
    setError('')
    try {
      const response = await fetch(`/api/share/artifacts/${encodeURIComponent(token)}/copy`, { method: 'POST' })
      if (response.status === 401) {
        // Back from an abandoned sign-in: stay on the page rather than loop.
        if (resuming) { setOpen(false); return }
        try { window.sessionStorage.setItem(RESUME_KEY, token) } catch { /* storage blocked: they click once more */ }
        window.location.assign(`/auth/login?return_to=${encodeURIComponent(`/share/artifact/${token}`)}`)
        return
      }
      const data = await response.json().catch(() => ({})) as { artifactId?: string; error?: string }
      if (!response.ok || typeof data.artifactId !== 'string') throw new Error(data.error || 'Could not open the copilot. Please try again.')
      setCopyId(data.artifactId)
      await refresh(data.artifactId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open the copilot.')
    } finally { setOpening(false) }
  }, [token, refresh])

  useEffect(() => {
    let resume = false
    try {
      resume = window.sessionStorage.getItem(RESUME_KEY) === token
      if (resume) window.sessionStorage.removeItem(RESUME_KEY)
    } catch { /* storage blocked */ }
    if (resume) { setOpen(true); void openCopy(true) }
  }, [token, openCopy])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !copyId && !opening) void openCopy()
  }

  const pending = artifact?.chat.find((m) => m.status === 'pending')
  const busy = Boolean(pending)
  useEffect(() => (copyId && busy ? startVisibleInterval(() => void refresh(copyId), 3_000) : undefined), [copyId, busy, refresh])
  useAgentExecStream(pending?.executionId, () => { if (copyId) void refresh(copyId) }, Boolean(pending?.executionId))
  useEffect(() => { if (open) chatEnd.current?.scrollIntoView({ block: 'nearest' }) }, [open, artifact?.chat.length, pending])
  useEffect(() => { if (open && artifact) inputRef.current?.focus() }, [open, Boolean(artifact)]) // eslint-disable-line react-hooks/exhaustive-deps

  const version = artifact?.versions.find((v) => v.id === artifact.currentVersionId) ?? null
  const markdownVersionId = version?.format === 'markdown' ? version.id : null
  useEffect(() => {
    if (!copyId || !markdownVersionId) return
    let cancelled = false
    fetch(`/api/artifacts/${copyId}/versions/${markdownVersionId}/content`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('Could not load the document.'))))
      .then((text) => { if (!cancelled) setMarkdown({ versionId: markdownVersionId, text }) })
      .catch(() => { if (!cancelled) setMarkdown({ versionId: markdownVersionId, text: '_The document could not be loaded._' }) })
    return () => { cancelled = true }
  }, [copyId, markdownVersionId])

  const send = async (event: React.FormEvent | null) => {
    event?.preventDefault()
    const outgoing = message.trim()
    if (!outgoing || sending || busy || !copyId) return
    setSending(true)
    setError('')
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(copyId)}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: outgoing, mode: 'auto' }) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; error?: string }
      if (!response.ok || !data.artifact) throw new Error(data.error || 'The message could not be sent.')
      setArtifact(data.artifact)
      setMessage('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The message could not be sent.')
    } finally { setSending(false) }
  }

  const canAsk = Boolean(artifact?.agent) && artifact?.permissions?.canEdit !== false && !artifact?.archivedAt

  return (
    <>
      {artifact && copyId && version ? (
        markdownVersionId ? (
          <div className="prose prose-sm mx-auto w-full max-w-3xl p-6 dark:prose-invert">
            {markdown?.versionId === markdownVersionId ? <Markdown>{markdown.text}</Markdown> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</p>}
          </div>
        ) : (
          <StatefulArtifactFrame key={copyId} artifactId={copyId} versionId={version.id} writable={canAsk} title={artifact.title} className="h-dvh w-full" />
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
              <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">Your own copy</p>
            </div>
            {copyId && (
              <a href={`/artifacts/${encodeURIComponent(copyId)}`} className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900" aria-label="Open your copy in Backstory" title="Open in Backstory">
                <ExternalLink className="h-4 w-4" aria-hidden />
              </a>
            )}
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900" aria-label="Close AI Copilot">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          <div aria-label="Copilot conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto break-words px-4 py-3">
            {opening && <p className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Opening your copy…</p>}
            {artifact && !artifact.chat.length && (
              <p className="text-sm text-fg-muted">
                {canAsk ? 'Ask a question about this page or describe a change. You’re working in your own copy — the original stays unchanged.' : 'This copy can’t be changed right now.'}
              </p>
            )}
            {artifact?.chat.map((m, index) => (
              <div key={`${m.createdAt}-${index}`} className={cn('text-sm', m.role === 'user' && 'ml-6 rounded-xl bg-horizon-50 px-3 py-2')}>
                {m.role === 'agent' && m.status === 'pending' ? (
                  m.executionId ? <RunFeed executionId={m.executionId} status="running" compact onStatusChange={() => void refresh(copyId!)} /> :
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
                {!artifact && !opening && <button type="button" onClick={() => void (copyId ? refresh(copyId) : openCopy())} className="underline">Try again</button>}
              </p>
            )}
            <div ref={chatEnd} />
          </div>

          {artifact && canAsk && (
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
                  disabled={busy}
                  placeholder={busy ? 'Waiting for the copilot…' : 'Ask a question or describe a change'}
                  className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                />
                <Button type="submit" size="icon" disabled={!message.trim() || sending || busy} aria-label="Send message">
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
