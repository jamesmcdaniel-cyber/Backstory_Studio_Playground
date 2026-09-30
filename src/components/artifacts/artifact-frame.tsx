'use client'

import { cn } from '@/lib/utils'

/**
 * The sandbox every artifact page runs in: scripts yes (tabs, views, charts),
 * never same-origin — the page gets an opaque origin, so it cannot reach the
 * app, its cookies or its APIs. The content route's CSP carries the same
 * sandbox and decides whether scripts run at all.
 */
export const ARTIFACT_FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads'

/** Whether agent output is an interactive page (its own script, or a React component) rather than a static report. */
export function isInteractiveOutput(text: string): boolean {
  const trimmed = text.trim()
  if (/<script[\s>]/i.test(trimmed)) return true
  const body = /^```[a-z]*\s*\n([\s\S]*?)\n```$/i.exec(trimmed)?.[1] ?? trimmed
  return /\bexport\s+default\b/.test(body) && /<[A-Za-z][\w.]*[\s>/]/.test(body)
}

/** An artifact's current version, live: the same page /artifacts shows, clickable in place. */
export function ArtifactFrame({ artifactId, title, className }: { artifactId: string; title: string; className?: string }) {
  return (
    <iframe
      title={title}
      src={`/api/artifacts/${artifactId}/versions/current/content`}
      sandbox={ARTIFACT_FRAME_SANDBOX}
      loading="lazy"
      className={cn('block h-[640px] w-full rounded-lg border border-border bg-white', className)}
    />
  )
}
