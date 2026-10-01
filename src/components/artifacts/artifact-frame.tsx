'use client'

import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { StatefulArtifactFrame } from './stateful-artifact-frame'
export { ARTIFACT_FRAME_SANDBOX } from './stateful-artifact-frame'

/**
 * The sandbox every artifact page runs in: scripts yes (tabs, views, charts),
 * never same-origin — the page gets an opaque origin, so it cannot reach the
 * app, its cookies or its APIs. The content route's CSP carries the same
 * sandbox and decides whether scripts run at all.
 */

/** Whether agent output is an interactive page (its own script, or a React component) rather than a static report. */
export function isInteractiveOutput(text: string): boolean {
  const trimmed = text.trim()
  if (/<script[\s>]/i.test(trimmed)) return true
  const body = /^```[a-z]*\s*\n([\s\S]*?)\n```$/i.exec(trimmed)?.[1] ?? trimmed
  return /\bexport\s+default\b/.test(body) && /<[A-Za-z][\w.]*[\s>/]/.test(body)
}

/** An artifact's current version, live: the same page /artifacts shows, clickable in place. */
export function ArtifactFrame({ artifactId, title, className }: { artifactId: string; title: string; className?: string }) {
  const [current, setCurrent] = useState<{ artifactId: string; versionId: string; writable: boolean } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    fetch(`/api/artifacts/${artifactId}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Artifact could not be loaded.')
      const { artifact } = await response.json()
      if (!artifact?.currentVersionId) throw new Error('Artifact has no current version.')
      if (!controller.signal.aborted) setCurrent({ artifactId, versionId: artifact.currentVersionId, writable: Boolean(artifact.permissions?.canEdit && !artifact.archivedAt) })
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [artifactId])
  if (error) return <p role="alert">{error} <a href={`/artifacts/${artifactId}`}>Open artifact</a></p>
  if (!current || current.artifactId !== artifactId) return <p role="status">Loading artifact…</p>
  return (
    <StatefulArtifactFrame
      key={current.versionId}
      artifactId={artifactId}
      versionId={current.versionId}
      writable={current.writable}
      title={title}
      className={cn('block h-[640px] w-full rounded-lg border border-border bg-white', className)}
    />
  )
}
