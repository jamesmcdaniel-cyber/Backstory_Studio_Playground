'use client'

import { useEffect, useRef, useState } from 'react'
import { ARTIFACT_FRAME_SANDBOX } from '@/components/artifacts/stateful-artifact-frame'

export type ReportFilters = { fy: string[]; fq: string[]; role: string[] }
export const NO_FILTERS: ReportFilters = { fy: [], fq: [], role: [] }

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 60).slice(0, 40) : [])

/**
 * The ROI report, hosted: the same sandboxed page as anywhere else, but its
 * filters live in the ROI page's side panel. On load the page tells the report
 * it is hosted (the report hides its own menu and answers with the filter
 * values it offers), then sends the panel's filters and the tab to show.
 * Messages are accepted only from this frame's window, and carry nothing but
 * filter values and tab names — the report still cannot reach the app.
 */
export function RoiReportFrame({ artifactId, versionId, title, className, filters, tab, onOptions, onTab }: {
  artifactId: string
  versionId: string
  title: string
  className?: string
  filters: ReportFilters
  /** The tab to open on (kept across versions). */
  tab: string | null
  onOptions: (options: ReportFilters) => void
  onTab: (tab: string) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [loading, setLoading] = useState(true)
  const latest = useRef({ filters, tab, onOptions, onTab })
  latest.current = { filters, tab, onOptions, onTab }

  useEffect(() => {
    const send = (message: unknown) => frame.current?.contentWindow?.postMessage(message, '*')
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = event.data as { type?: unknown; options?: Record<string, unknown>; tab?: unknown } | null
      if (message?.type === 'backstory:roi-loaded') {
        send({ type: 'backstory:roi-host' })
        send({ type: 'backstory:roi-filters', filters: latest.current.filters })
        if (latest.current.tab && latest.current.tab !== 'summary') send({ type: 'backstory:roi-tab', tab: latest.current.tab })
      } else if (message?.type === 'backstory:roi-ready' && message.options) {
        latest.current.onOptions({ fy: strings(message.options.fy), fq: strings(message.options.fq), role: strings(message.options.role) })
      } else if (message?.type === 'backstory:roi-tab-shown' && typeof message.tab === 'string' && message.tab.length <= 20) {
        latest.current.onTab(message.tab)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  // The panel's filters apply live.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: 'backstory:roi-filters', filters }, '*')
  }, [filters])

  useEffect(() => { setLoading(true) }, [versionId])

  return (
    <div className={className} style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {loading && <div role="status" className="p-2 text-xs text-muted-foreground">Loading the report…</div>}
      <iframe
        key={versionId}
        ref={frame}
        onLoad={() => setLoading(false)}
        title={title}
        src={`/api/artifacts/${artifactId}/versions/${versionId}/content`}
        sandbox={ARTIFACT_FRAME_SANDBOX}
        className="min-h-0 w-full flex-1 border-0"
      />
    </div>
  )
}
