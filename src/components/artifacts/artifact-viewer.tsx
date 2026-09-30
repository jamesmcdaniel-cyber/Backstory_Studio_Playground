'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, ArrowLeft, ArrowUp, Bot, ExternalLink, History, Loader2, MessageSquare, PenLine, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { indentOnTab } from '@/components/ui/textarea'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { ARTIFACT_KIND_LABEL, type ArtifactView } from '@/lib/artifacts/types'
import { RunFeed } from '@/components/runs/run-feed'
import { useAgentExecStream } from '@/components/runs/use-agent-exec-stream'

/**
 * One artifact: the document in a sandboxed frame, its versions, and the
 * conversation with the agent that made it. "Ask" gets an answer; "Ask for a
 * change" gets a new version. Both are runs — narrated here while they work,
 * and visible in the Runs panel like every other run.
 */
export function ArtifactViewer({ id }: { id: string }) {
  const [artifact, setArtifact] = useState<ArtifactView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [versionId, setVersionId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [mode, setMode] = useState<'ask' | 'change'>('ask')
  const [sending, setSending] = useState(false)
  const [markdown, setMarkdown] = useState<{ versionId: string; text: string } | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/artifacts/${id}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; error?: string }
      if (!response.ok || !data.artifact) throw new Error(data.error || 'Could not load the artifact.')
      setArtifact(data.artifact)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [id])

  const pending = artifact?.chat.find((m) => m.status === 'pending')
  const busy = Boolean(pending)

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => (busy ? startVisibleInterval(() => void refresh(), 10_000) : undefined), [busy, refresh])
  useAgentExecStream(pending?.executionId, () => void refresh(), Boolean(pending?.executionId))
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'nearest' }) }, [artifact?.chat.length, pending])
  // A new version arriving moves the viewer to it.
  useEffect(() => { if (artifact?.currentVersionId) setVersionId(artifact.currentVersionId) }, [artifact?.currentVersionId])
  // Markdown versions are rendered here rather than framed; fetch the text when the shown version changes.
  const markdownVersionId = artifact?.versions.find((v) => v.id === (versionId ?? artifact.currentVersionId))?.format === 'markdown' ? (versionId ?? artifact?.currentVersionId ?? null) : null
  useEffect(() => {
    if (!markdownVersionId) return
    let cancelled = false
    fetch(`/api/artifacts/${id}/versions/${markdownVersionId}/content`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('Could not load the document.'))))
      .then((text) => { if (!cancelled) setMarkdown({ versionId: markdownVersionId, text }) })
      .catch(() => { if (!cancelled) setMarkdown({ versionId: markdownVersionId, text: '_The document could not be loaded._' }) })
    return () => { cancelled = true }
  }, [id, markdownVersionId])

  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!message.trim() || sending || !artifact) return
    setSending(true)
    try {
      const response = await fetch(`/api/artifacts/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, mode }) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; error?: string }
      if (!response.ok || !data.artifact) throw new Error(data.error || 'The message could not be sent.')
      setArtifact(data.artifact)
      setMessage('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const rerunFlow = async () => {
    if (!artifact?.flow || busy) return
    try {
      const response = await fetch(`/api/artifacts/${id}/rerun-flow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: message.trim() }) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; error?: string }
      if (!response.ok || !data.artifact) throw new Error(data.error || 'The flow could not be started.')
      setArtifact(data.artifact)
      setMessage('')
      toast.success(`Running "${artifact.flow.name}" — a new version lands here when it finishes.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const archive = async (archived: boolean) => {
    const response = await fetch(`/api/artifacts/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived }) })
    if (!response.ok) { toast.error('Could not update the artifact.'); return }
    await refresh()
  }

  if (error && !artifact) {
    return <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">{error} <Link href="/artifacts" className="underline">Back to artifacts</Link></div>
  }
  if (!artifact) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>

  const shownVersion = artifact.versions.find((v) => v.id === versionId) ?? artifact.versions[0]
  const canAsk = Boolean(artifact.agent)
  const shownMarkdown = shownVersion?.format === 'markdown' ? shownVersion : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/artifacts" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3 w-3" aria-hidden /> All artifacts</Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">{artifact.title}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{ARTIFACT_KIND_LABEL[artifact.kind]}</span>
            {artifact.agent && <Link href={`/agents?agent=${artifact.agent.id}`} className="inline-flex items-center gap-1 hover:text-foreground"><Bot className="h-3.5 w-3.5" aria-hidden />{artifact.agent.title}</Link>}
            {artifact.flow && <Link href={`/flows/${artifact.flow.id}`} className="inline-flex items-center gap-1 hover:text-foreground"><Workflow className="h-3.5 w-3.5" aria-hidden />{artifact.flow.name}</Link>}
            <span>{artifact.versionCount} version{artifact.versionCount === 1 ? '' : 's'} · updated {relativeTime(artifact.updatedAt)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {shownVersion && (
            <a href={`/api/artifacts/${id}/versions/${shownVersion.id}/content`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-muted">
              Open full page <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
          <Button variant="outline" size="sm" onClick={() => void archive(!artifact.archivedAt)}>
            {artifact.archivedAt ? <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
            {artifact.archivedAt ? 'Restore' : 'Archive'}
          </Button>
        </div>
      </div>

      {pending?.executionId && <RunFeed executionId={pending.executionId} status="running" onStatusChange={() => void refresh()} />}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-2">
          {artifact.versions.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <History className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <label htmlFor="artifact-version" className="text-muted-foreground">Version</label>
              <select id="artifact-version" className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={shownVersion?.id ?? ''} onChange={(event) => setVersionId(event.target.value)}>
                {artifact.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.number} · {new Date(version.createdAt).toLocaleString()}{version.request ? ` · ${version.request.slice(0, 60)}` : ''}{version.id === artifact.currentVersionId ? ' · current' : ''}
                  </option>
                ))}
              </select>
              {shownVersion?.executionId && <Link href={`/agents?run=${shownVersion.executionId}`} className="text-muted-foreground hover:text-foreground">Open the run</Link>}
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-border bg-white">
            {shownMarkdown ? (
              <div className="prose prose-sm max-w-none overflow-y-auto p-6 dark:prose-invert" style={{ maxHeight: 'calc(100vh - 240px)' }}>
                {markdown?.versionId === shownMarkdown.id ? <Markdown>{markdown.text}</Markdown> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>}
              </div>
            ) : shownVersion ? (
              <iframe
                key={shownVersion.id}
                title={artifact.title}
                src={`/api/artifacts/${id}/versions/${shownVersion.id}/content`}
                sandbox={artifact.interactive ? 'allow-scripts' : ''}
                className="block h-[calc(100dvh-190px)] min-h-[560px] w-full"
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">No content yet.</p>
            )}
          </div>
        </div>

        <aside className="flex min-h-[420px] flex-col rounded-xl border border-border bg-background">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-medium"><MessageSquare className="h-4 w-4 text-horizon-600" aria-hidden /> {artifact.agent ? artifact.agent.title : 'Conversation'}</div>
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {!artifact.chat.length && (
              <p className="text-xs text-muted-foreground">
                {canAsk ? 'Ask the agent about this artifact, or switch to “Ask for a change” to get a revised version. Every version is kept.' : 'This artifact has no producing agent to talk to.'}
              </p>
            )}
            {artifact.chat.map((m, index) => (
              <div key={`${m.createdAt}-${index}`} className={cn('text-sm', m.role === 'user' ? 'ml-6 rounded-xl bg-horizon-50 px-3 py-2 dark:bg-horizon-900/40' : '')}>
                {m.role === 'user' && m.mode === 'change' && <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-horizon-700">Change request</span>}
                {m.role === 'agent' && m.status === 'pending' ? (
                  <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {m.mode === 'change' ? 'Revising…' : 'Working on it…'}</div>
                ) : m.role === 'agent' ? (
                  <div className={cn(m.status === 'failed' && 'text-destructive')}>
                    <Markdown>{m.content}</Markdown>
                    {m.versionId && <button type="button" onClick={() => setVersionId(m.versionId!)} className="mt-1 text-xs font-medium text-horizon-700 underline underline-offset-2">View this version</button>}
                  </div>
                ) : (
                  <p>{m.content}</p>
                )}
              </div>
            ))}
            <div ref={chatEnd} />
          </div>
          {canAsk && (
            <form onSubmit={send} className="border-t border-border p-3">
              <div role="radiogroup" aria-label="Mode" className="mb-2 flex gap-1.5">
                {(['ask', 'change'] as const).map((option) => (
                  <button key={option} type="button" role="radio" aria-checked={mode === option} onClick={() => setMode(option)} className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium', mode === option ? 'border-horizon-600 bg-horizon-600 text-white' : 'border-border hover:bg-muted')}>
                    {option === 'ask' ? <MessageSquare className="h-3 w-3" aria-hidden /> : <PenLine className="h-3 w-3" aria-hidden />}
                    {option === 'ask' ? 'Ask' : 'Ask for a change'}
                  </button>
                ))}
                {artifact.flow?.active && (
                  <button type="button" onClick={() => void rerunFlow()} disabled={busy} className="ml-auto inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50" title={`Re-run "${artifact.flow.name}"; a document in its output becomes the next version`}>
                    <Workflow className="h-3 w-3" aria-hidden /> Re-run flow
                  </button>
                )}
              </div>
              <label htmlFor="artifact-message" className="sr-only">Message</label>
              <div className="flex items-end gap-2">
                <textarea
                  id="artifact-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => { indentOnTab(event); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) } }}
                  rows={2}
                  maxLength={2000}
                  disabled={busy}
                  placeholder={busy ? 'Waiting for the agent…' : mode === 'change' ? 'Add a section on Q3 risks and shorten the summary.' : 'What drove the change in win rate?'}
                  className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                />
                <Button type="submit" size="icon" disabled={!message.trim() || sending || busy} aria-label={mode === 'change' ? 'Send change request' : 'Send question'}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
                </Button>
              </div>
            </form>
          )}
        </aside>
      </div>
    </div>
  )
}
