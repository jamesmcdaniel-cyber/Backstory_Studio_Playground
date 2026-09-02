/**
 * What the agent is told about the repository at prompt-build time.
 *
 * The old behavior injected five passages chosen by a query built from the
 * objective, whether or not the run needed them — which both spent tokens on
 * irrelevant runs and gave a long document no way to be read properly. This
 * replaces that with an index card: titles and descriptions only, so the agent
 * knows the customer journey document exists and can decide to open it. The
 * passages come from repository_search / repository_read when it asks.
 */

import { prisma } from '@/lib/prisma'
import { agentScopeWhere } from './scope'

export const MANIFEST_MAX_ENTRIES = 25
export const MANIFEST_MAX_CHARS = 1_500

export type ManifestEntry = {
  filename: string
  description: string
  collection: string | null
}

export function renderRepositoryManifest(entries: ManifestEntry[]): string {
  if (!entries.length) return ''
  const lines: string[] = []
  let used = 0
  let shown = 0
  for (const entry of entries.slice(0, MANIFEST_MAX_ENTRIES)) {
    const description = entry.description.trim().replace(/\s+/g, ' ').slice(0, 120)
    const suffix = entry.collection ? ` (${entry.collection})` : ''
    const line = `- "${entry.filename}"${description ? ` — ${description}` : ''}${suffix}`
    if (used + line.length > MANIFEST_MAX_CHARS) break
    lines.push(line)
    used += line.length
    shown += 1
  }
  const omitted = entries.length - shown
  const overflow = omitted > 0 ? `\n…and ${omitted} more. Call repository_list to see them.` : ''
  return [
    '## Repository available to you',
    'Reference material this workspace maintains. Prefer it over general knowledge when the question is about how this company works.',
    lines.join('\n') + overflow,
    'Call repository_search for passages, repository_read to open a document in full. Cite what you use.',
  ].join('\n')
}

/** The documents this agent may reach, newest first, bounded for the prompt. */
export async function loadManifestEntries(params: {
  organizationId: string
  agentId: string
}): Promise<ManifestEntry[]> {
  const rows = await prisma.knowledgeDocument.findMany({
    where: {
      organizationId: params.organizationId,
      isEnabled: true,
      status: 'ready',
      ...agentScopeWhere(params.organizationId, params.agentId),
    },
    orderBy: { updatedAt: 'desc' },
    take: MANIFEST_MAX_ENTRIES + 25,
    select: {
      filename: true,
      description: true,
      collections: { select: { collection: { select: { name: true } } }, take: 1 },
    },
  })
  return rows.map((row) => ({
    filename: row.filename,
    description: row.description,
    collection: row.collections[0]?.collection.name ?? null,
  }))
}
