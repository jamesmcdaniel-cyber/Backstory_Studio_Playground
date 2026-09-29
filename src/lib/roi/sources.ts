import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ingestKnowledgeDataset } from '@/lib/knowledge/ingest'
import { saveStoredFile } from '@/lib/files/storage'

/**
 * Managed ROI extracts.
 *
 * The four extracts behind an ROI story are loaded once per account by an
 * operator and kept in the workspace repository as datasets tagged with the
 * account and the extract kind (`sourceMetadata.roi`). The ROI page reads
 * that tag: users pick an account, never a file. The Databricks flow, when it
 * lands, writes the same tag on what it pulls — nothing downstream changes.
 */

export const ROI_SOURCE_KINDS = ['activity', 'usage', 'engagement', 'stages'] as const
export type RoiSourceKind = (typeof ROI_SOURCE_KINDS)[number]

export const ROI_SOURCE_LABEL: Record<RoiSourceKind, string> = {
  activity: 'Activity extract',
  usage: 'Usage cohort',
  engagement: 'Opportunity engagement',
  stages: 'Closed deals by stage',
}

export type RoiSourceTag = { account: string; kind: RoiSourceKind; loadedAt: string; organizationId?: string }

export type RoiAccountSources = {
  account: string
  datasets: Partial<Record<RoiSourceKind, { documentId: string; filename: string; rows: number | null; loadedAt: string }>>
}

export function isRoiSourceKind(value: unknown): value is RoiSourceKind {
  return typeof value === 'string' && (ROI_SOURCE_KINDS as readonly string[]).includes(value)
}

function tagOf(metadata: unknown): RoiSourceTag | null {
  const roi = (metadata as { roi?: Partial<RoiSourceTag> } | null)?.roi
  if (!roi || typeof roi.account !== 'string' || !isRoiSourceKind(roi.kind)) return null
  return { account: roi.account, kind: roi.kind, loadedAt: typeof roi.loadedAt === 'string' ? roi.loadedAt : '' }
}

/** Accounts with extracts loaded, and which extracts each has (newest per kind wins). */
export async function listRoiSources(organizationId: string): Promise<RoiAccountSources[]> {
  const docs = await prisma.knowledgeDocument.findMany({
    // The tag lives in JSON; datasets are few, so the filter is in code rather
    // than a JSON-path predicate that behaves differently across drivers.
    where: { organizationId, assetType: 'dataset', isEnabled: true, status: 'ready' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, filename: true, sourceMetadata: true, createdAt: true },
  })
  const byAccount = new Map<string, RoiAccountSources>()
  for (const doc of docs) {
    const tag = tagOf(doc.sourceMetadata)
    if (!tag) continue
    const entry = byAccount.get(tag.account) ?? { account: tag.account, datasets: {} }
    if (!entry.datasets[tag.kind]) {
      entry.datasets[tag.kind] = {
        documentId: doc.id,
        filename: doc.filename,
        rows: (doc.sourceMetadata as { dataset?: { rowCount?: number } } | null)?.dataset?.rowCount ?? null,
        loadedAt: tag.loadedAt || doc.createdAt.toISOString(),
      }
    }
    byAccount.set(tag.account, entry)
  }
  return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account))
}

/** The dataset ids for an account, newest per kind. Empty when nothing is loaded. */
export async function resolveRoiDatasetIds(organizationId: string, account: string): Promise<string[]> {
  const sources = await listRoiSources(organizationId)
  const match = sources.find((source) => source.account.toLowerCase() === account.trim().toLowerCase())
  if (!match) return []
  return ROI_SOURCE_KINDS.map((kind) => match.datasets[kind]?.documentId).filter((id): id is string => Boolean(id))
}

/** Load one extract for an account from bytes (the seed script and the admin route). */
export async function loadRoiSource(params: {
  organizationId: string
  userId: string | null
  account: string
  kind: RoiSourceKind
  filename: string
  buffer: Buffer
  /** Operator CLI loads of inspected files skip the browser-upload scanner. */
  trusted?: boolean
}): Promise<{ documentId: string; rows: number | null }> {
  const stored = await saveStoredFile({
    organizationId: params.organizationId,
    userId: params.userId,
    filename: params.filename,
    mimeType: 'text/csv',
    buffer: params.buffer,
    trusted: params.trusted === true,
  })
  const document = await ingestKnowledgeDataset({
    organizationId: params.organizationId,
    agentId: null,
    userId: params.userId,
    storedFileId: stored.id,
    filename: params.filename,
    buffer: params.buffer,
    description: `${ROI_SOURCE_LABEL[params.kind]} for ${params.account} — ROI analysis extract, loaded ${new Date().toISOString().slice(0, 10)}.`,
    sourceType: 'integration',
    sourceMetadata: { roi: { account: params.account.trim(), kind: params.kind, loadedAt: new Date().toISOString() } },
  })
  const rows = await prisma.knowledgeDocument.findFirst({ where: { id: document.id, organizationId: params.organizationId }, select: { sourceMetadata: true } })
  return { documentId: document.id, rows: (rows?.sourceMetadata as { dataset?: { rowCount?: number } } | null)?.dataset?.rowCount ?? null }
}

/** Attach the tag to a dataset already in the repository (an operator upload). */
export async function tagRoiSource(params: { organizationId: string; documentId: string; account: string; kind: RoiSourceKind }): Promise<void> {
  const doc = await prisma.knowledgeDocument.findFirst({ where: { id: params.documentId, organizationId: params.organizationId, assetType: 'dataset' }, select: { sourceMetadata: true } })
  if (!doc) throw new Error('No dataset with that id.')
  const metadata = (doc.sourceMetadata as Record<string, unknown> | null) ?? {}
  await prisma.knowledgeDocument.update({
    where: { id: params.documentId, organizationId: params.organizationId },
    data: { sourceMetadata: { ...metadata, roi: { account: params.account.trim(), kind: params.kind, loadedAt: new Date().toISOString() } } as Prisma.InputJsonValue },
  })
}
