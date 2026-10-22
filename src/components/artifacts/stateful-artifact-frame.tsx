'use client'
import { useEffect, useRef, useState } from 'react'
import { subscribeTicks } from '@/lib/client/realtime'
import { artifactSharedChannel, createSharedStateRelay, isSharedStateKey } from '@/lib/artifacts/shared-state-live'
export const ARTIFACT_FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads'
export type RenderErrorMessage = { message: string; stack?: string; count?: number }

/** The frame's error report, as the server accepts it: bounded, strings only. */
function renderErrorsOf(value: unknown): RenderErrorMessage[] {
  if (!Array.isArray(value)) return []
  const out: RenderErrorMessage[] = []
  for (const item of value.slice(0, 20)) {
    const message = typeof item?.message === 'string' ? item.message.slice(0, 500) : ''
    if (!message) continue
    const error: RenderErrorMessage = { message }
    if (typeof item.stack === 'string' && item.stack) error.stack = item.stack.slice(0, 500)
    if (Number.isInteger(item.count) && item.count >= 1) error.count = Math.min(item.count, 100_000)
    out.push(error)
  }
  return out
}

/** The only bridge out of the opaque-origin sandbox. Scope comes from trusted
 * parent props, never from a frame-supplied artifact/user/URL. */
export function StatefulArtifactFrame({ artifactId, versionId, title, className, writable = false, onRenderErrors }: { artifactId: string; versionId: string; title: string; className?: string; writable?: boolean; /** The page reported runtime errors (after they were recorded, when this person can edit). */ onRenderErrors?: (report: { versionId: string; errors: RenderErrorMessage[] }) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [displayed, setDisplayed] = useState(versionId)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [slow, setSlow] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => { if (!dirty) setDisplayed(versionId) }, [versionId, dirty])
  useEffect(() => { setLoading(true); setSlow(false); const timer = setTimeout(() => setSlow(true), 20_000); return () => clearTimeout(timer) }, [displayed, reload])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  const onRenderErrorsRef = useRef(onRenderErrors)
  onRenderErrorsRef.current = onRenderErrors
  useEffect(() => {
    let disposed = false
    let inFlight = 0
    let lastReport = ''
    // Live shared state: another viewer's save arrives as a tick (key +
    // revision only); the value is refetched here, over the authenticated
    // route, and handed to the frame — which never gets network access. The
    // subscription opens on the frame's first shared key, not on every view.
    const relay = createSharedStateRelay({
      fetchLatest: async (key) => {
        const response = await fetch(`/api/artifacts/${artifactId}/shared-state?key=${encodeURIComponent(key)}`, { cache: 'no-store', signal: AbortSignal.timeout(12_000) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Shared state could not be read.')
        return { value: result.value, revision: result.revision }
      },
      deliver: (change) => { if (!disposed) frame.current?.contentWindow?.postMessage({ type: 'backstory:shared-state-changed', key: change.key, value: change.value, revision: change.revision }, '*') },
    })
    let stopLive: (() => void) | null = null
    const follow = (key: string) => {
      if (disposed || !relay.watch(key) || stopLive) return
      stopLive = subscribeTicks(artifactSharedChannel(artifactId), (payload) => relay.tick(payload))
    }
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return
      const msg = event.data
      if (msg?.type === 'backstory:dirty') { setDirty(Boolean(msg.dirty)); return }
      // An HTML page's onSharedStateChange(key): follow a key it has not read yet.
      if (msg?.type === 'backstory:shared-watch') { if (isSharedStateKey(msg.key)) follow(msg.key); return }
      if (msg?.type === 'backstory:render-errors') {
        // What the page says broke, recorded against the version it is showing
        // — by an editor only, since the report changes what the assistant is told.
        const errors = renderErrorsOf(msg.errors)
        if (!writable || !errors.length) return
        const body = JSON.stringify({ versionId: displayed, errors })
        if (body === lastReport) return
        lastReport = body
        try {
          const response = await fetch(`/api/artifacts/${artifactId}/render-errors`, { method: 'PUT', cache: 'no-store', signal: AbortSignal.timeout(12_000), headers: { 'Content-Type': 'application/json' }, body })
          if (response.ok && !disposed) onRenderErrorsRef.current?.({ versionId: displayed, errors })
        } catch { /* a lost report is not the page's problem */ }
        return
      }
      if (!msg || msg.type !== 'backstory:state' || typeof msg.id !== 'string' || msg.id.length > 80) return
      const target = frame.current?.contentWindow
      // "The bridge is here": sent before any fetch, so the page waits for a
      // slow first load instead of taking it for a frame with no bridge (a
      // public link, a thumbnail), which it gives up on after 4 s.
      if (!disposed) target?.postMessage({ type: 'backstory:state-ack', id: msg.id }, '*')
      let counted = false
      let writing: string | null = null
      try {
        if (!['get', 'set'].includes(msg.op) || !/^[a-zA-Z0-9_-]{1,64}$/.test(msg.payload?.key ?? '')) throw new Error('Invalid state request.')
        // Shared state is the artifact's, not the person's: readable by anyone
        // who can open the artifact, so a reader's frame fetches it live.
        const shared = msg.payload?.shared === true
        // A reader who cannot edit (a view-only teammate, a historical version)
        // gets a read-only answer, so the page renders its initial data
        // instead of a red banner and a form that never enables.
        if (!writable) {
          if (msg.op === 'set') throw new Error('This artifact is read-only here; changes stay on screen only.')
          if (!shared) {
            if (!disposed) target?.postMessage({ type: 'backstory:state-result', id: msg.id, result: { value: null, revision: 0, readOnly: true } }, '*')
            return
          }
        }
        if (inFlight >= 8) throw new Error('Too many pending state requests.')
        const body = msg.op === 'set' ? JSON.stringify({ key: msg.payload.key, value: msg.payload.value, revision: msg.payload.revision, versionId: displayed }) : undefined
        if (body && new TextEncoder().encode(body).length > 257024) throw new Error('Application state exceeds 256 KB.')
        inFlight++
        counted = true
        if (shared) { follow(msg.payload.key); if (msg.op === 'set') { relay.beginWrite(msg.payload.key); writing = msg.payload.key } }
        const response = await fetch(`/api/artifacts/${artifactId}/${shared ? 'shared-state' : 'state'}${msg.op === 'get' ? `?key=${encodeURIComponent(msg.payload.key)}` : ''}`, { method: msg.op === 'get' ? 'GET' : 'PUT', cache: 'no-store', signal: AbortSignal.timeout(12_000), headers: body ? { 'Content-Type': 'application/json' } : undefined, body })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Application state could not be saved.')
        // The revision the frame now holds: the echo of its own save is dropped.
        if (shared) { if (writing) { relay.endWrite(writing, result.revision); writing = null } else relay.observe(msg.payload.key, result.revision) }
        if (!disposed) target?.postMessage({ type: 'backstory:state-result', id: msg.id, result: shared && !writable ? { ...result, readOnly: true } : result }, '*')
      } catch (error) {
        if (!disposed) target?.postMessage({ type: 'backstory:state-result', id: msg.id, error: error instanceof Error ? error.message : 'State request failed.' }, '*')
      } finally { if (counted) inFlight--; if (writing) relay.endWrite(writing) }
    }
    window.addEventListener('message', receive)
    return () => { disposed = true; relay.dispose(); stopLive?.(); window.removeEventListener('message', receive) }
  }, [artifactId, displayed, writable])
  return <div className={className} style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
    {displayed !== versionId && <div role="status" className="bg-amber-50 p-2 text-xs text-amber-900">A new version is available. Your unsaved work is still open. Save or export it before switching. <button className="underline" onClick={() => { if (window.confirm('Discard unsaved changes and open the selected version?')) { setDirty(false); setDisplayed(versionId) } }}>Discard and switch</button></div>}
    {loading && <div role="status" className="p-2 text-xs">{slow ? 'Artifact is taking longer to load.' : 'Loading artifact…'} {slow && <button className="underline" onClick={() => setReload(n => n + 1)}>Retry</button>}</div>}
    <iframe key={`${displayed}:${reload}`} ref={frame} onLoad={() => setLoading(false)} title={title} src={`/api/artifacts/${artifactId}/versions/${displayed}/content`} sandbox={ARTIFACT_FRAME_SANDBOX} className="min-h-0 w-full flex-1 border-0" />
  </div>
}
