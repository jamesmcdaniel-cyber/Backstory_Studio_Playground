import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ingestKnowledgeDataset } from '@/lib/knowledge/ingest'
import { saveStoredFile } from '@/lib/files/storage'

/**
 * Managed ROI extracts.
 *
 * The extracts behind an ROI story (four for the rep engagement analysis,
 * three for Account 360) are loaded once per account by an operator and kept in the workspace repository as datasets tagged with the
 * account and the extract kind (`sourceMetadata.roi`). The ROI page reads
 * that tag: users pick an account, never a file. The Databricks flow, when it
 * lands, writes the same tag on what it pulls — nothing downstream changes.
 */

export const ROI_SOURCE_KINDS = ['activity', 'usage', 'engagement', 'stages', 'clickstream', 'accounts', 'opportunities'] as const
export type RoiSourceKind = (typeof ROI_SOURCE_KINDS)[number]

export const ROI_SOURCE_LABEL: Record<RoiSourceKind, string> = {
  activity: 'Activity extract',
  usage: 'Usage cohort',
  engagement: 'Opportunity engagement',
  stages: 'Closed deals by stage',
  clickstream: 'Account 360 click-stream',
  accounts: 'Parent accounts',
  opportunities: 'Opportunity pull',
}

/**
 * The analyses an account's extracts can feed. Each names its extracts and
 * the ones it cannot run without; an account offers a template once those
 * are loaded.
 */
export const ROI_TEMPLATES = {
  standard: {
    label: 'ROI analysis',
    description: 'The standard readout: key findings, activity trends, adoption impact, deal intelligence (incl. stage × persona) and account engagement — every section the account\'s extracts can feed.',
    kinds: ['activity', 'usage', 'engagement', 'stages', 'clickstream', 'accounts', 'opportunities'],
    required: [] as RoiSourceKind[],
  },
  engagement: {
    label: 'Rep engagement ROI',
    description: 'Leading indicators per rep, adoption cohorts, deal engagement vs win rate, and stage/persona — the Iron Mountain dashboard.',
    kinds: ['activity', 'usage', 'engagement', 'stages'],
    required: [] as RoiSourceKind[],
  },
  account360: {
    label: 'Account 360 ROI',
    description: 'Which accounts the team works in Account 360, cohorted by how often and how deep, against the pipeline those accounts carry — the HP suite.',
    kinds: ['clickstream', 'accounts', 'opportunities'],
    required: ['clickstream', 'opportunities'] as RoiSourceKind[],
  },
} as const satisfies Record<string, { label: string; description: string; kinds: readonly RoiSourceKind[]; required: RoiSourceKind[] }>

export type RoiTemplate = keyof typeof ROI_TEMPLATES
export const ROI_TEMPLATE_IDS = Object.keys(ROI_TEMPLATES) as RoiTemplate[]

export function isRoiTemplate(value: unknown): value is RoiTemplate {
  return typeof value === 'string' && value in ROI_TEMPLATES
}

/** The report sections each extract kind feeds, in words, for the page's account picker. */
const KIND_COVERS: Record<RoiSourceKind, string> = {
  activity: 'Activity trends',
  usage: 'Adoption impact',
  engagement: 'Deal engagement',
  stages: 'Stage and persona',
  clickstream: 'Account engagement',
  accounts: 'Account engagement',
  opportunities: 'Account engagement',
}

export function coversFor(kinds: RoiSourceKind[]): string[] {
  return [...new Set(ROI_SOURCE_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => KIND_COVERS[kind]))]
}

/** The templates an account's loaded extracts can run. */
export function templatesFor(datasets: Partial<Record<RoiSourceKind, unknown>>): RoiTemplate[] {
  const runnable = (id: RoiTemplate) => {
    const template = ROI_TEMPLATES[id]
    const loaded = template.kinds.filter((kind) => datasets[kind])
    return loaded.length > 0 && template.required.every((kind) => datasets[kind])
  }
  // The standard report needs at least one part it can build: any of the
  // rep-engagement extracts, or a complete Account 360 set.
  return ROI_TEMPLATE_IDS.filter((id) => (id === 'standard' ? runnable('engagement') || runnable('account360') : runnable(id)))
}

export type RoiSourceTag = { account: string; kind: RoiSourceKind; loadedAt: string; organizationId?: string }

export type RoiAccountSources = {
  account: string
  datasets: Partial<Record<RoiSourceKind, { documentId: string; filename: string; rows: number | null; loadedAt: string }>>
  /** The analyses these extracts can run. */
  templates: RoiTemplate[]
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
    const entry = byAccount.get(tag.account) ?? { account: tag.account, datasets: {}, templates: [] }
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
  return [...byAccount.values()]
    .map((entry) => ({ ...entry, templates: templatesFor(entry.datasets) }))
    .sort((a, b) => a.account.localeCompare(b.account))
}

/** The dataset ids a template reads for an account, newest per kind. Empty when nothing is loaded. */
export async function resolveRoiDatasetIds(organizationId: string, account: string, template: RoiTemplate = 'standard'): Promise<string[]> {
  const sources = await listRoiSources(organizationId)
  const match = sources.find((source) => source.account.toLowerCase() === account.trim().toLowerCase())
  if (!match) return []
  return ROI_TEMPLATES[template].kinds.map((kind) => match.datasets[kind]?.documentId).filter((id): id is string => Boolean(id))
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
