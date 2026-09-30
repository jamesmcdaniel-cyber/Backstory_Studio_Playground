'use client'

import { useEffect, useRef, useState } from 'react'
import { FileOutput, Loader2 } from 'lucide-react'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import { ARTIFACT_FRAME_SANDBOX } from './artifact-frame'

// The page is laid out at a desktop width, then scaled to the card, so the
// thumbnail shows its first screen as a person would see it.
const PAGE_WIDTH = 1280
const PAGE_HEIGHT = 800

/**
 * A live preview of an artifact's first screen: the current version, rendered
 * in the same sandbox as the viewer and scaled down. Frames mount only when
 * the card nears the viewport, and never take clicks — the card does.
 */
export function ArtifactThumbnail({ artifactId, kind, title, ready, className }: { artifactId: string; kind: string; title: string; ready: boolean; className?: string }) {
  const box = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [scale, setScale] = useState(0.25)
  const [markdown, setMarkdown] = useState<string | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const resize = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / PAGE_WIDTH))
    resize.observe(el)
    const seen = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); seen.disconnect() } }, { rootMargin: '200px' })
    seen.observe(el)
    return () => { resize.disconnect(); seen.disconnect() }
  }, [])

  // A Markdown document isn't a page: show its opening text.
  useEffect(() => {
    if (!visible || !ready || kind !== 'document') return
    let cancelled = false
    fetch(`/api/artifacts/${artifactId}/versions/current/content`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => { if (!cancelled) setMarkdown(text.slice(0, 1_500)) })
      .catch(() => { if (!cancelled) setMarkdown('') })
    return () => { cancelled = true }
  }, [visible, ready, kind, artifactId])

  return (
    <div ref={box} aria-hidden className={cn('relative aspect-[16/10] w-full overflow-hidden bg-white', className)}>
      {!ready ? (
        <div className="flex h-full items-center justify-center gap-2 bg-muted/40 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building…</div>
      ) : !visible ? (
        <div className="flex h-full items-center justify-center bg-muted/30 text-muted-foreground"><FileOutput className="h-6 w-6" /></div>
      ) : kind === 'document' ? (
        <div className="prose prose-sm pointer-events-none max-w-none origin-top-left p-5 dark:prose-invert" style={{ width: PAGE_WIDTH / 2, transform: `scale(${scale * 2})` }}>
          {markdown === null ? null : <Markdown>{markdown}</Markdown>}
        </div>
      ) : (
        <iframe
          title={`Preview of ${title}`}
          src={`/api/artifacts/${artifactId}/versions/current/content`}
          sandbox={ARTIFACT_FRAME_SANDBOX}
          tabIndex={-1}
          scrolling="no"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
          style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})` }}
        />
      )}
    </div>
  )
}
