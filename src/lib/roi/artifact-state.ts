import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { readStoredFile, saveStoredFile } from '@/lib/files/storage'
import type { RoiNarrative } from './contract'
import type { RoiFacts } from './prep'
import type { Account360Facts } from './account360/prep'
import { readView, type RoiView } from './view'
import { readRunConfig, type RoiRunConfig } from './config'

/**
 * The state an ROI dashboard version is rendered from. Stored on the
 * version so that editing any version — not only the latest — starts from
 * exactly what that version showed.
 */
export type RoiArtifactState = {
  roi: {
    analysisId: string
    account: string
    timeframePreset: string
    factsFileId: string
    /** The Account 360 prep's result, for the Account engagement tab (standard reports). */
    a360FactsFileId?: string
    datasetIds: string[]
    narrative: RoiNarrative
    view: RoiView
    /** How the run was configured on the ROI page, and why it was run. */
    config?: RoiRunConfig
    reason?: string
    /** 2 = facts from the ROI-page prep (every deal, stage cells, accounts) — a
     *  report on them can be reconfigured without recomputing. */
    factsVersion?: number
    /** A version of someone's own ROI page (not an account's generic report). */
    personal?: boolean
    /** The generic report version this one started from (personal pages). */
    basedOn?: { artifactId: string; versionId: string }
    /** The layout version that drew it (ROI_RENDER_VERSION); older ones are re-drawn when opened. */
    render?: number
    /** Imported from a value readout rather than computed from extracts. */
    source?: 'readout'
  }
}

export function readRoiState(state: unknown): RoiArtifactState['roi'] | null {
  const roi = (state as { roi?: RoiArtifactState['roi'] } | null)?.roi
  if (!roi || typeof roi.factsFileId !== 'string' || !roi.narrative) return null
  return { ...roi, view: readView(roi.view), datasetIds: Array.isArray(roi.datasetIds) ? roi.datasetIds : [], ...(roi.config ? { config: readRunConfig(roi.config) } : {}) }
}

/**
 * The ROI state for an artifact's current version. Versions made before
 * state was recorded fall back to the analysis that produced the artifact
 * (its results carry the narrative and facts file), so the first dashboard
 * is editable too.
 */
export async function currentRoiState(organizationId: string, artifactId: string): Promise<{ state: RoiArtifactState['roi']; versionId: string } | null> {
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId }, select: { currentVersionId: true, kind: true } })
  if (!artifact?.currentVersionId || artifact.kind !== 'roi_dashboard') return null
  const version = await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId }, select: { id: true, state: true } })
  if (!version) return null
  const stored = readRoiState(version.state)
  if (stored) return { state: stored, versionId: version.id }
  const analyses = await prisma.roiAnalysis.findMany({ where: { organizationId, status: 'completed' }, orderBy: { createdAt: 'desc' }, take: 50 })
  const analysis = analyses.find((row) => (row.results as { artifactId?: unknown } | null)?.artifactId === artifactId)
  const results = analysis?.results as { narrative?: RoiNarrative; factsFileId?: string } | null
  if (!analysis || !results?.narrative || !results.factsFileId) return null
  return {
    versionId: version.id,
    state: {
      analysisId: analysis.id,
      account: analysis.account,
      timeframePreset: (analysis.timeframe as { preset?: string } | null)?.preset ?? 'last6_vs_prior6',
      factsFileId: results.factsFileId,
      datasetIds: Array.isArray(analysis.datasetIds) ? (analysis.datasetIds as string[]) : [],
      narrative: results.narrative,
      view: readView(analysis.view),
    },
  }
}

export async function readFacts(organizationId: string, factsFileId: string): Promise<RoiFacts | null> {
  const stored = await readStoredFile(factsFileId, organizationId)
  if (!stored) return null
  try {
    return JSON.parse(stored.buffer.toString('utf8')) as RoiFacts
  } catch {
    return null
  }
}

export async function readAccount360Facts(organizationId: string, fileId: string | undefined): Promise<Account360Facts | null> {
  if (!fileId) return null
  const stored = await readStoredFile(fileId, organizationId).catch(() => null)
  if (!stored) return null
  try {
    return JSON.parse(stored.buffer.toString('utf8')) as Account360Facts
  } catch {
    return null
  }
}

export async function storeFacts(organizationId: string, userId: string | null, facts: RoiFacts): Promise<string> {
  const saved = await saveStoredFile({
    organizationId,
    userId,
    filename: `roi-facts-${Date.now()}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(facts)),
    trusted: true,
  })
  return saved.id
}

export function stateJson(state: RoiArtifactState['roi']): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify({ roi: state })) as Prisma.InputJsonValue
}
