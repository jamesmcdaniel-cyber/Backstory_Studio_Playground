'use client'
import { useEffect, useRef } from 'react'
export const ARTIFACT_FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads'

/** The only bridge out of the opaque-origin sandbox. Scope comes from trusted
 * parent props, never from a frame-supplied artifact/user/URL. */
export function StatefulArtifactFrame({ artifactId, versionId, title, className, writable = false }: { artifactId: string; versionId: string; title: string; className?: string; writable?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    let disposed = false
    let inFlight = 0
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return
      const msg = event.data
      if (!msg || msg.type !== 'backstory:state' || typeof msg.id !== 'string' || msg.id.length > 80) return
      const target = frame.current?.contentWindow
      let counted = false
      try {
        if (!writable) throw new Error('Private application state is only available in an editable current artifact.')
        if (inFlight >= 8) throw new Error('Too many pending state requests.')
        if (!['get', 'set'].includes(msg.op) || !/^[a-zA-Z0-9_-]{1,64}$/.test(msg.payload?.key ?? '')) throw new Error('Invalid state request.')
        const body = msg.op === 'set' ? JSON.stringify({ key: msg.payload.key, value: msg.payload.value, revision: msg.payload.revision, versionId }) : undefined
        if (body && new TextEncoder().encode(body).length > 257024) throw new Error('Application state exceeds 256 KB.')
        inFlight++
        counted = true
        const response = await fetch(`/api/artifacts/${artifactId}/state${msg.op === 'get' ? `?key=${encodeURIComponent(msg.payload.key)}` : ''}`, { method: msg.op === 'get' ? 'GET' : 'PUT', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Application state could not be saved.')
        if (!disposed) target?.postMessage({ type: 'backstory:state-result', id: msg.id, result }, '*')
      } catch (error) {
        if (!disposed) target?.postMessage({ type: 'backstory:state-result', id: msg.id, error: error instanceof Error ? error.message : 'State request failed.' }, '*')
      } finally { if (counted) inFlight-- }
    }
    window.addEventListener('message', receive)
    return () => { disposed = true; window.removeEventListener('message', receive) }
  }, [artifactId, versionId, writable])
  return <iframe ref={frame} title={title} src={`/api/artifacts/${artifactId}/versions/${versionId}/content`} sandbox={ARTIFACT_FRAME_SANDBOX} className={className} />
}
