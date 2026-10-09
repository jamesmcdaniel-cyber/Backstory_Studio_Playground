'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Archive, ArchiveRestore, ArrowLeft, ArrowUp, Bot, Download, Eye, ExternalLink, GitCompare, History, Loader2, MessageSquare, RotateCcw, Settings2, Share2, Undo2, Workflow, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { indentOnTab } from '@/components/ui/textarea'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { ARTIFACT_KIND_LABEL, type ArtifactView } from '@/lib/artifacts/types'
import { ModelPicker, useChatModel } from '@/components/ui/model-picker'
import { chatModelLabel } from '@/lib/llm/models'
import { RunFeed } from '@/components/runs/run-feed'
import { useAgentExecStream } from '@/components/runs/use-agent-exec-stream'
import { StatefulArtifactFrame, type RenderErrorMessage } from './stateful-artifact-frame'
import { foldUnchanged, lineDiff, type LineDiff } from '@/lib/artifacts/line-diff'
import { AssistantSettingsPanel } from './assistant-settings-panel'
import { ShareDialog } from './share-dialog'
import { AttachAgentCard } from './attach-agent-card'
import { useAuth } from '@/hooks/use-auth'

/**
 * One artifact: the document in a sandboxed frame, its versions, and the
 * conversation with the agent that made it. "Ask" gets an answer; "Ask for a
 * change" gets a new version. Both are runs — narrated here while they work,
 * and visible in the Runs panel like every other run.
 */
export type ArtifactFrameRenderer = (frame: { artifactId: string; versionId: string; title: string; writable: boolean; className: string }) => React.ReactNode

/**
 * The last copy of each artifact this tab showed. Opening one again (back to
 * the ROI page, a revisited artifact) draws it straight away and refreshes in
 * the background — the refresh asks only whether it changed. Memory only, so
 * it lasts for the session and never outlives a reload.
 */
const VIEW_CACHE = new Map<string, ArtifactView>()
const VIEW_CACHE_MAX = 12
function remember(id: string, view: ArtifactView) {
  VIEW_CACHE.delete(id)
  VIEW_CACHE.set(id, view)
  if (VIEW_CACHE.size > VIEW_CACHE_MAX) {
    const oldest = VIEW_CACHE.keys().next().value
    if (oldest !== undefined) VIEW_CACHE.delete(oldest)
  }
}

export function ArtifactViewer({ id, embedded = false, showAssistant = true, renderFrame, showVersion, onVersions }: {
  id: string
  /**
   * Inside another page (the ROI page, a person's own report): no title row,
   * page actions, version row or history and settings tabs — that page has its
   * own controls. The assistant stays.
   */
  embedded?: boolean
  /** The assistant sidebar; a host page can toggle it. */
  showAssistant?: boolean
  /** Draw the document yourself (the ROI page hosts its report's filters through its own frame). */
  renderFrame?: ArtifactFrameRenderer
  /** Show this version (a run history row on the host page); the nonce re-applies the same id. */
  showVersion?: { id: string; nonce: number } | null
  /** Tells the host which version is shown and which is current, whenever either changes. */
  onVersions?: (versions: { shownVersionId: string | null; currentVersionId: string | null }) => void
}) {
  const { can } = useAuth()
  const [artifact, setArtifact] = useState<ArtifactView | null>(() => VIEW_CACHE.get(id) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [versionId, setVersionId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [markdown, setMarkdown] = useState<{ versionId: string; text: string } | null>(null)
  const [panel, setPanel] = useState<'assistant' | 'history' | 'settings'>('assistant')
  const [shareOpen, setShareOpen] = useState(false)
  // The artifact and its assistant share the rest of the viewport: the page
  // fills to the bottom edge and the conversation scrolls inside its panel,
  // instead of the chat stretching the page below a shorter frame.
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [workspaceHeight, setWorkspaceHeight] = useState(720)
  useLayoutEffect(() => {
    const el = workspaceRef.current
    if (!el) return
    const scroller = (() => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY
        if (overflow === 'auto' || overflow === 'scroll') return node
      }
      return null
    })()
    const measure = () => {
      const top = el.getBoundingClientRect().top + (scroller ? scroller.scrollTop - scroller.getBoundingClientRect().top : window.scrollY)
      const viewport = scroller ? scroller.clientHeight : window.innerHeight
      // Every wrapper's bottom padding between here and the scroller (the page
      // container's py-8, say) sits below the workspace too.
      let bottomGap = 0
      for (let node = el.parentElement; node; node = node.parentElement) {
        bottomGap += parseFloat(getComputedStyle(node).paddingBottom) || 0
        if (node === scroller) break
      }
      setWorkspaceHeight(Math.max(520, Math.round(viewport - top - bottomGap)))
    }
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(document.documentElement)
    if (el.previousElementSibling) resize.observe(el.previousElementSibling)
    window.addEventListener('resize', measure)
    return () => { resize.disconnect(); window.removeEventListener('resize', measure) }
  })
  const [model, setModel] = useChatModel('artifact')
  const [restoring, setRestoring] = useState<string | null>(null)
  // What the shown version's page reported broke (the frame records it; the server keeps the latest per version).
  const [renderErrors, setRenderErrors] = useState<{ versionId: string; errors: RenderErrorMessage[] } | null>(null)
  // History: a version laid against the current one as a line diff.
  const [compare, setCompare] = useState<{ versionId: string; number: number; diff: LineDiff | null; error: string | null } | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const artifactRef = useRef(artifact)
  artifactRef.current = artifact
  const [historyLoading, setHistoryLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (requestRef.current) return // coalesce timer, visibility and run events
    const controller = new AbortController()
    requestRef.current = controller
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const prior = artifactRef.current
      const since = prior && !prior.build ? `?since=${encodeURIComponent(prior.updatedAt)}` : ''
      const response = await fetch(`/api/artifacts/${id}${since}`, { cache: 'no-store', signal: controller.signal })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; error?: string; unchanged?: boolean }
      if (controller.signal.aborted) return
      if (response.ok && data.unchanged) { setError(null); return }
      if (!response.ok || !data.artifact) throw new Error(data.error || 'Could not load the artifact.')
      const next = data.artifact
      setArtifact(previous => ({ ...next, versions: [...next.versions, ...(previous?.versions.filter(v => !next.versions.some(n => n.id === v.id)) ?? [])], nextVersionBefore: previous && previous.versions.length > 20 ? previous.nextVersionBefore : next.nextVersionBefore }))
      setError(null)
    } catch (err) {
      if (requestRef.current === controller) setError(controller.signal.aborted ? 'Refresh timed out. Retrying automatically.' : err instanceof Error ? err.message : String(err))
    } finally { clearTimeout(timer); if (requestRef.current === controller) requestRef.current = null }
  }, [id])

  const pending = artifact?.chat.find((m) => m.status === 'pending')
  const building = Boolean(artifact?.build && !['completed', 'failed', 'blocked', 'cancelled'].includes(artifact.build.status))
  const busy = Boolean(pending) || building
  // The assistant paused on a question: it is asked and answered in this
  // conversation, not in the Runs panel.
  const awaiting = pending?.question ?? null

  useEffect(() => {
    const cached = VIEW_CACHE.get(id) ?? null
    artifactRef.current = cached
    setArtifact(cached)
    setVersionId(null)
    void refresh()
    return () => { requestRef.current?.abort(); requestRef.current = null }
  }, [refresh, id])
  useEffect(() => { if (artifact) remember(id, artifact) }, [artifact, id])
  // External flows and other tabs can publish even when this viewer is idle.
  // Pause in background tabs and refresh immediately when they become visible.
  useEffect(() => startVisibleInterval(() => void refresh(), busy ? 3_000 : 10_000), [busy, refresh])
  useAgentExecStream(pending?.executionId, () => void refresh(), Boolean(pending?.executionId))
  // The conversation scrolls inside its own panel; scrolling its end into view
  // would move the whole page where the panel sits below the document (phones).
  useEffect(() => { const log = chatEnd.current?.parentElement; if (log) log.scrollTop = log.scrollHeight }, [artifact?.chat.length, pending])
  // A new version arriving moves the viewer to it — once the assistant has
  // finished, not at every save along the way, so the page reloads one time.
  const assistantWorking = Boolean(pending)
  useEffect(() => { const current = artifact?.currentVersionId; if (current) setVersionId((shown) => (!assistantWorking || shown === null ? current : shown)) }, [artifact?.currentVersionId, assistantWorking])
  // A host asked for a particular version (a history row): show it once it is loaded.
  const loadedIds = artifact?.versions.map((v) => v.id).join(',')
  useEffect(() => { if (showVersion?.id && loadedIds?.split(',').includes(showVersion.id)) setVersionId(showVersion.id) }, [showVersion?.id, showVersion?.nonce, loadedIds])
  // The host follows what is on screen (the ROI page names the account the shown version is about).
  const onVersionsRef = useRef(onVersions)
  onVersionsRef.current = onVersions
  const shownId = artifact ? (artifact.versions.find((v) => v.id === versionId) ?? artifact.versions[0])?.id ?? null : null
  const currentId = artifact?.currentVersionId ?? null
  useEffect(() => { if (artifact) onVersionsRef.current?.({ shownVersionId: shownId, currentVersionId: currentId }) }, [artifact, shownId, currentId])
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

  // The shown version's recorded runtime errors, if any; the frame updates this as its page reports.
  useEffect(() => {
    if (!shownId) { setRenderErrors(null); return }
    let cancelled = false
    fetch(`/api/artifacts/${id}/render-errors?versionId=${encodeURIComponent(shownId)}`, { cache: 'no-store', signal: AbortSignal.timeout(12_000) })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { report?: { versionId: string; errors: RenderErrorMessage[] } | null } | null) => { if (!cancelled) setRenderErrors(data?.report?.errors?.length ? { versionId: data.report.versionId, errors: data.report.errors } : null) })
      .catch(() => { if (!cancelled) setRenderErrors(null) })
    return () => { cancelled = true }
  }, [id, shownId])

  const compareWithCurrent = async (version: { id: string; number: number }) => {
    const current = artifactRef.current?.currentVersionId
    if (!current) return
    setCompare({ versionId: version.id, number: version.number, diff: null, error: null })
    try {
      // ?download=1 is the authored source, without the injected runtime.
      const [before, after] = await Promise.all([version.id, current].map(async (v) => {
        const response = await fetch(`/api/artifacts/${id}/versions/${v}/content?download=1`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error('Could not load the version to compare.')
        return response.text()
      }))
      setCompare((prior) => (prior?.versionId === version.id ? { ...prior, diff: lineDiff(before, after) } : prior))
    } catch (err) {
      setCompare((prior) => (prior?.versionId === version.id ? { ...prior, error: err instanceof Error ? err.message : String(err) } : prior))
    }
  }

  const send = async (event: React.FormEvent | null, text?: string) => {
    event?.preventDefault()
    const outgoing = (text ?? message).trim()
    if (!outgoing || sending || !artifact) return
    setSending(true)
    try {
      // While the assistant waits on its question, what is typed is the answer.
      const response = awaiting
        ? await fetch(`/api/artifacts/${id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: outgoing }) })
        : await fetch(`/api/artifacts/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text ?? message, mode: 'auto', model }) })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; error?: string }
      if (!response.ok || !data.artifact) throw new Error(data.error || 'The message could not be sent.')
      requestRef.current?.abort(); requestRef.current = null
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
      requestRef.current?.abort(); requestRef.current = null
      setArtifact(data.artifact)
      setMessage('')
      toast.success(`Running "${artifact.flow.name}" — a new version lands here when it finishes.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const restore = async (target: string) => {
    setRestoring(target)
    try {
      const response = await fetch(`/api/artifacts/${id}/versions/${target}/restore`, { method: 'POST' })
      const data = await response.json().catch(() => ({})) as { artifact?: ArtifactView; error?: string }
      if (!response.ok || !data.artifact) throw new Error(data.error || 'The version could not be restored.')
      requestRef.current?.abort(); requestRef.current = null
      setArtifact(data.artifact)
      setVersionId(data.artifact.currentVersionId)
      toast.success(`Restored — it is now version ${data.artifact.versionCount}, and the previous versions are kept.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoring(null)
    }
  }

  const loadHistory = async () => {
    if (!artifact?.nextVersionBefore || historyLoading) return
    setHistoryLoading(true)
    try {
      const response = await fetch(`/api/artifacts/${id}?before=${artifact.nextVersionBefore}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      const data = await response.json()
      if (!response.ok || !data.artifact) throw new Error(data.error || 'Could not load history.')
      const page = data.artifact as ArtifactView
      setArtifact(prior => prior && ({ ...prior, nextVersionBefore: page.nextVersionBefore, versions: [...prior.versions, ...page.versions.filter(v => !prior.versions.some(p => p.id === v.id))] }))
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not load history. Retry.') }
    finally { setHistoryLoading(false) }
  }

  const archive = async (archived: boolean) => {
    const response = await fetch(`/api/artifacts/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived }) })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      toast.error(data.error || 'Could not update the artifact.')
      return
    }
    toast.success(archived ? 'Archived — find it under "Show archived" to bring it back.' : 'Unarchived — it is back in the list.')
    await refresh()
  }

  if (error && !artifact) {
    return <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">{error} <Link href="/artifacts" className="underline">Back to artifacts</Link></div>
  }
  if (!artifact) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>

  const shownVersion = artifact.versions.find((v) => v.id === versionId) ?? artifact.versions[0]
  // Edit access is per artifact (owner, named editors, admins, or members when
  // the workspace may edit); without it the page is read-only.
  const canEdit = artifact.permissions?.canEdit ?? can('agent.write')
  const canAsk = Boolean(artifact.agent) && canEdit
  const configurationLocked = artifact.configurationLocked === true || artifact.permissions?.canConfigure === false
  const canConfigure = canAsk && !configurationLocked
  const shownMarkdown = shownVersion?.format === 'markdown' ? shownVersion : null
  // The version before the current one, by number: what "Undo last change" goes back to.
  const currentVersion = artifact.versions.find((v) => v.id === artifact.currentVersionId)
  const previousVersion = currentVersion ? artifact.versions.filter((v) => v.number < currentVersion.number).sort((a, b) => b.number - a.number)[0] ?? null : null
  const undoLastChange = () => {
    if (!previousVersion || !currentVersion) return
    if (window.confirm(`Undo the last change? Version ${previousVersion.number} becomes current again, as a new version; version ${currentVersion.number} stays in the history.`)) void restore(previousVersion.id)
  }
  const shownErrors = renderErrors && shownVersion && renderErrors.versionId === shownVersion.id ? renderErrors.errors : []
  const firstError = shownErrors[0]?.message ?? ''

  return (
    <div className="space-y-4">
      {!embedded && <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/artifacts" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3 w-3" aria-hidden /> All artifacts</Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">{artifact.title}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{ARTIFACT_KIND_LABEL[artifact.kind]}</span>
            {artifact.agent && (configurationLocked ? <span className="inline-flex items-center gap-1">Personal copy · <Link href={`/agents?agent=${artifact.agent.id}`} className="inline-flex items-center gap-1 hover:text-foreground"><Bot className="h-3.5 w-3.5" aria-hidden />{artifact.agent.title}</Link> · settings locked</span> : <Link href={`/agents?agent=${artifact.agent.id}`} className="inline-flex items-center gap-1 hover:text-foreground"><Bot className="h-3.5 w-3.5" aria-hidden />{artifact.agent.title}</Link>)}
            {artifact.flow && <Link href={`/flows/${artifact.flow.id}`} className="inline-flex items-center gap-1 hover:text-foreground"><Workflow className="h-3.5 w-3.5" aria-hidden />{artifact.flow.name}</Link>}
            <span>{artifact.versionCount} version{artifact.versionCount === 1 ? '' : 's'} · updated {relativeTime(artifact.updatedAt)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {shownVersion && (
            <>
              <a href={`/api/artifacts/${id}/versions/${shownVersion.id}/content?download=1`} download className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-muted">
                Download <Download className="h-3 w-3" aria-hidden />
              </a>
              <a href={`/api/artifacts/${id}/versions/${shownVersion.id}/content`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-muted">
                Open full page <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </>
          )}
          {(!configurationLocked || artifact.permissions?.canShare) && <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
            <Share2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />Share
          </Button>}
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => void archive(!artifact.archivedAt)}>
              {artifact.archivedAt ? <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
              {artifact.archivedAt ? 'Unarchive' : 'Archive'}
            </Button>
          )}
        </div>
      </div>}

      {(!configurationLocked || artifact.permissions?.canShare) && <ShareDialog artifactId={artifact.id} title={artifact.title} open={shareOpen} onOpenChange={setShareOpen} />}
      {error && <p role="status" className="text-sm text-amber-700">{error} <button onClick={() => void refresh()} className="underline">Retry now</button></p>}

      {artifact.archivedAt && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <span className="flex items-center gap-2"><Archive className="h-4 w-4" aria-hidden />Archived {relativeTime(artifact.archivedAt)} — it's hidden from the artifacts list.</span>
          {canEdit && <Button size="sm" variant="outline" className="bg-white" onClick={() => void archive(false)}><ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden />Unarchive</Button>}
        </div>
      )}

      <div
        ref={workspaceRef}
        className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 xl:h-[var(--workspace-h)]', showAssistant && 'xl:grid-cols-[minmax(0,1fr)_340px]')}
        style={{ '--workspace-h': `${workspaceHeight}px` } as React.CSSProperties}
      >
        <div className="flex h-[var(--workspace-h)] min-h-0 min-w-0 flex-col gap-2 xl:h-full">
          {shownVersion && shownVersion.id !== artifact.currentVersionId ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <History className="h-3.5 w-3.5" aria-hidden />
              <span>{embedded ? 'Showing an earlier run' : `Viewing version ${shownVersion.number} of ${artifact.versionCount}`} · {new Date(shownVersion.createdAt).toLocaleString()}{shownVersion.request ? ` · ${shownVersion.request.slice(0, 80)}` : ''}</span>
              <span className="ml-auto flex items-center gap-2">
                {canEdit && (
                  <Button size="sm" variant="outline" disabled={restoring !== null} onClick={() => void restore(shownVersion.id)}>
                    {restoring === shownVersion.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />}{embedded ? 'Use this one' : 'Restore this version'}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setVersionId(artifact.currentVersionId)}>{embedded ? 'Back to latest' : 'Back to current'}</Button>
              </span>
            </div>
          ) : !embedded && artifact.versions.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <History className="h-3.5 w-3.5" aria-hidden />
              <span>Version {shownVersion?.number} of {artifact.versionCount} (current){shownVersion?.request ? ` · ${shownVersion.request.slice(0, 80)}` : ''}</span>
              <button type="button" onClick={() => setPanel('history')} className="font-medium text-horizon-700 underline underline-offset-2">History</button>
              {shownVersion?.executionId && <Link href={`/agents?run=${shownVersion.executionId}`} className="hover:text-foreground">Open the run</Link>}
              {canEdit && !artifact.archivedAt && (
                <button type="button" disabled={!previousVersion || restoring !== null} onClick={undoLastChange} title={previousVersion ? `Back to version ${previousVersion.number}` : 'There is no earlier version to go back to'} className="ml-auto inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 font-medium text-foreground hover:bg-muted disabled:opacity-50">
                  {restoring && previousVersion && restoring === previousVersion.id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Undo2 className="h-3 w-3" aria-hidden />} Undo last change
                </button>
              )}
            </div>
          ) : null}
          {firstError && !shownMarkdown && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:bg-rose-950/30 dark:text-rose-100">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={firstError}>This version hit a runtime error{shownErrors.length > 1 ? ` (${shownErrors.length})` : ''}: {firstError}</span>
              {canAsk && shownVersion?.id === artifact.currentVersionId && (
                <Button size="sm" variant="outline" className="bg-white dark:bg-transparent" disabled={busy || sending} onClick={() => void send(null, `Fix the runtime errors on this version: ${firstError}`)}>Fix this</Button>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-white">
            {shownMarkdown ? (
              <div className="prose prose-sm h-full max-w-none overflow-y-auto p-6 dark:prose-invert">
                {markdown?.versionId === shownMarkdown.id ? <Markdown>{markdown.text}</Markdown> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>}
              </div>
            ) : shownVersion && renderFrame ? (
              renderFrame({ artifactId: id, versionId: shownVersion.id, title: artifact.title, writable: canEdit && shownVersion.id === artifact.currentVersionId && !artifact.archivedAt, className: 'block h-full w-full' })
            ) : shownVersion ? (
              <StatefulArtifactFrame
                key={id}
                artifactId={id}
                versionId={shownVersion.id}
                writable={canEdit && shownVersion.id === artifact.currentVersionId && !artifact.archivedAt}
                onRenderErrors={setRenderErrors}
                title={artifact.title}
                // Opaque origin (never allow-same-origin): the page cannot reach
                // the app. Whether its scripts run is the server's call — the
                // content route's CSP blocks them in a script-less document.
                className="block h-full w-full"
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">No content yet.</p>
            )}
          </div>
        </div>

        {showAssistant && <aside className="flex h-[640px] min-h-0 min-w-0 flex-col rounded-xl border border-border bg-background xl:h-full">
          {embedded ? (
            <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5 text-sm font-medium">
              <MessageSquare className="h-4 w-4 text-horizon-600" aria-hidden />
              <span className="truncate">{artifact.agent ? artifact.agent.title : 'Conversation'}</span>
            </div>
          ) : <div role="tablist" aria-label="Panel" className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-sm">
            {(['assistant', 'history', 'settings'] as const).filter(tab => tab !== 'settings' || !configurationLocked).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={panel === tab}
                onClick={() => setPanel(tab)}
                className={cn('inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 font-medium', tab === 'assistant' ? 'flex-1' : 'shrink-0', panel === tab ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {tab === 'assistant' ? <MessageSquare className="h-4 w-4 text-horizon-600" aria-hidden /> : tab === 'history' ? <History className="h-4 w-4" aria-hidden /> : <Settings2 className="h-4 w-4" aria-hidden />}
                {tab === 'assistant' ? <span className="max-w-[9rem] truncate">{artifact.agent ? artifact.agent.title : 'Conversation'}</span> : tab === 'history' ? `History (${artifact.versionCount})` : <span className="sr-only sm:not-sr-only">Settings</span>}
              </button>
            ))}
          </div>}
          {!embedded && panel === 'settings' && !configurationLocked ? (
            <AssistantSettingsPanel artifactId={artifact.id} canEdit={canConfigure} />
          ) : !embedded && panel === 'history' ? (
            <div className="flex min-h-0 flex-1 flex-col">
            {compare && (
              <section aria-label={`Version ${compare.number} compared with current`} className="flex min-h-0 max-h-[55%] flex-col border-b border-border">
                <div className="flex items-center gap-2 px-3 py-2 text-xs">
                  <GitCompare className="h-3.5 w-3.5 text-horizon-600" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium">Version {compare.number} → current{compare.diff ? <span className="ml-2 font-normal text-muted-foreground"><span className="text-emerald-700">+{compare.diff.added}</span> <span className="text-rose-700">−{compare.diff.removed}</span>{compare.diff.truncated ? ' · long page, first 4,000 lines compared' : ''}</span> : null}</span>
                  <button type="button" onClick={() => setCompare(null)} aria-label="Close comparison" className="rounded p-1 hover:bg-muted"><X className="h-3.5 w-3.5" aria-hidden /></button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto bg-muted/30 font-mono text-[11px] leading-5">
                  {compare.error ? <p className="p-3 text-rose-700">{compare.error}</p>
                    : !compare.diff ? <p className="flex items-center gap-2 p-3 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Comparing…</p>
                    : !compare.diff.added && !compare.diff.removed ? <p className="p-3 text-muted-foreground">No differences in the source.</p>
                    : <table className="w-max min-w-full border-collapse"><tbody>
                      {foldUnchanged(compare.diff).map((line, index) => line.kind === 'fold'
                        ? <tr key={index}><td colSpan={3} className="bg-muted/60 px-3 text-center text-muted-foreground">… {line.count} unchanged line{line.count === 1 ? '' : 's'} …</td></tr>
                        : <tr key={index} className={cn(line.kind === 'added' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100', line.kind === 'removed' && 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100')}>
                          <td className="select-none px-2 text-right text-muted-foreground">{line.oldLine ?? ''}</td>
                          <td className="select-none px-2 text-right text-muted-foreground">{line.newLine ?? ''}</td>
                          <td className="whitespace-pre px-2"><span className="select-none">{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}</span>{line.text}</td>
                        </tr>)}
                    </tbody></table>}
                </div>
              </section>
            )}
            <ol className="min-h-0 flex-1 divide-y divide-border overflow-y-auto" aria-label="Version history">
              {artifact.nextVersionBefore && <li className="p-3"><Button variant="outline" disabled={historyLoading} onClick={() => void loadHistory()}>{historyLoading ? 'Loading…' : 'Load older versions'}</Button></li>}
              {artifact.versions.map((version) => {
                const isCurrent = version.id === artifact.currentVersionId
                const isShown = version.id === shownVersion?.id
                return (
                  <li key={version.id} className={cn('px-4 py-3 text-xs', isShown && 'bg-muted/60')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">Version {version.number}</span>
                      {isCurrent && <span className="rounded-full bg-horizon-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">Current</span>}
                    </div>
                    <p className="mt-0.5 text-muted-foreground">
                      {new Date(version.createdAt).toLocaleString()}
                      {version.author ? ` · ${version.author}` : ''}
                      {' · '}{version.source === 'created' ? 'Created' : version.source === 'restore' ? 'Restored' : version.source === 'flow' ? 'Flow run' : version.source === 'shared' ? 'Latest shared version' : 'Assistant'}
                    </p>
                    {version.request && <p className="mt-1 line-clamp-3 text-foreground">{version.request}</p>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {!isShown && <button type="button" onClick={() => setVersionId(version.id)} className="font-medium text-horizon-700 underline underline-offset-2">View</button>}
                      {!isCurrent && canEdit && (
                        <button type="button" disabled={restoring !== null} onClick={() => void restore(version.id)} className="font-medium text-horizon-700 underline underline-offset-2 disabled:opacity-50">
                          {restoring === version.id ? 'Restoring…' : 'Restore'}
                        </button>
                      )}
                      {!isCurrent && artifact.currentVersionId && (
                        <button type="button" onClick={() => void compareWithCurrent(version)} className={cn('font-medium underline underline-offset-2', compare?.versionId === version.id ? 'text-foreground' : 'text-horizon-700')}>
                          {compare?.versionId === version.id && !compare.diff && !compare.error ? 'Comparing…' : 'Compare with current'}
                        </button>
                      )}
                      {version.executionId && <Link href={`/agents?run=${version.executionId}`} className="text-muted-foreground hover:text-foreground">Run</Link>}
                    </div>
                  </li>
                )
              })}
            </ol>
            </div>
          ) : (
            <>
          <div aria-label="Artifact conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto break-words px-4 py-3">
            {!artifact.chat.length && canAsk && (
              <div className="flex flex-col gap-1.5">
                {(artifact.kind === 'roi_dashboard'
                  ? ['Why is win rate higher for engaged deals?', 'Hide the account engagement tab', 'Add accounts touched as an activity metric', 'Show me this for another account']
                  : ['Summarise this in three bullets', 'Make it shorter']
                ).map((suggestion) => (
                  <button key={suggestion} type="button" disabled={busy || sending} onClick={() => void send(null, suggestion)} className="rounded-lg border border-border px-2.5 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50">
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
            {!artifact.agent && canEdit && <AttachAgentCard artifactId={artifact.id} onAttached={() => void refresh()} />}
            {!artifact.chat.length && (artifact.agent || !canEdit) && (
              <p className="text-xs text-muted-foreground">
                {canAsk
                  ? embedded
                    ? 'Ask about the report, tell the analyst what to change, or ask for another account or opportunity — it opens here, in this layout. Every change saves to your page.'
                    : 'Ask about it, tell the assistant what to change, or — for a dashboard — ask for it on another account. Every change is a new version; the old ones are kept.'
                  : 'This artifact has no agent attached yet.'}
              </p>
            )}
            {artifact.chat.map((m, index) => (
              <div key={`${m.createdAt}-${index}`} className={cn('text-sm', m.role === 'user' ? 'ml-6 rounded-xl bg-horizon-50 px-3 py-2 dark:bg-horizon-900/40' : '')}>
                {m.role === 'user' && m.mode === 'change' && <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-horizon-700">Change request</span>}
                {m.role === 'agent' && m.status === 'pending' && m.question ? (
                  <div role="status" className="rounded-xl border border-horizon-200 bg-horizon-50/60 px-3 py-2 dark:bg-horizon-900/30">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-horizon-700">The assistant needs an answer</p>
                    <Markdown>{m.question}</Markdown>
                  </div>
                ) : m.role === 'agent' && m.status === 'pending' ? (
                  m.executionId ? <RunFeed executionId={m.executionId} status="running" compact quietUntilWork onStatusChange={refresh} /> :
                    <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {m.mode === 'change' ? 'Revising…' : 'Working on it…'}</div>
                ) : m.role === 'agent' ? (
                  <div className={cn(m.status === 'failed' && 'text-destructive')}>
                    <Markdown>{m.content}</Markdown>
                    {m.model && <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">{chatModelLabel(m.model)}</p>}
                    {m.versionId && <button type="button" onClick={() => setVersionId(m.versionId!)} className="mt-1 text-xs font-medium text-horizon-700 underline underline-offset-2">View this version</button>}
                  </div>
                ) : (
                  <p>{m.content}</p>
                )}
              </div>
            ))}
            {!embedded && artifact.build && building && artifact.build.executionId && artifact.build.executionId !== pending?.executionId && (
              <RunFeed executionId={artifact.build.executionId} status={artifact.build.status} compact onStatusChange={refresh} />
            )}
            {!embedded && artifact.build && ['failed', 'blocked', 'cancelled'].includes(artifact.build.status) && (
              <div role="status" className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <p className="font-medium">Building the dashboard for {artifact.build.account} {artifact.build.status === 'cancelled' ? 'was cancelled' : 'did not finish'}.</p>
                {artifact.build.error && <p className="mt-1">{artifact.build.error}</p>}
                {artifact.build.executionId && <Link href={`/agents?run=${artifact.build.executionId}`} className="mt-2 inline-block underline">Open the run</Link>}
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          {!canEdit && artifact.agent && (
            <p className="flex items-start gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground"><Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />You can view this artifact. Its owner or an editor can give you edit access from Share.</p>
          )}
          {canAsk && (
            <form onSubmit={send} className="border-t border-border p-3">
              {artifact.flow?.active && (
                <div className="mb-2 flex">
                  <button type="button" onClick={() => void rerunFlow()} disabled={busy} className="ml-auto inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50" title={`Re-run "${artifact.flow.name}"; a document in its output becomes the next version`}>
                    <Workflow className="h-3 w-3" aria-hidden /> Re-run flow
                  </button>
                </div>
              )}
              {!configurationLocked && <div className="mb-2 flex justify-end"><ModelPicker value={model} onChange={setModel} disabled={busy} /></div>}
              <label htmlFor="artifact-message" className="sr-only">Message</label>
              <div className="flex items-end gap-2">
                <textarea
                  id="artifact-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => { indentOnTab(event); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) } }}
                  rows={2}
                  maxLength={2000}
                  disabled={busy && !awaiting}
                  placeholder={awaiting ? 'Type your answer' : busy ? 'Waiting for the assistant…' : artifact.kind === 'roi_dashboard' ? 'Ask a question, change the dashboard, or run it for another account' : 'Ask a question or describe a change'}
                  className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                />
                <Button type="submit" size="icon" disabled={!message.trim() || sending || (busy && !awaiting)} aria-label={awaiting ? 'Send answer' : 'Send message'}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
                </Button>
              </div>
            </form>
          )}
            </>
          )}
        </aside>}
      </div>
    </div>
  )
}
