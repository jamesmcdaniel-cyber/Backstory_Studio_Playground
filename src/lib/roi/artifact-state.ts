import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { readStoredFile, saveStoredFile } from '@/lib/files/storage'
import type { RoiNarrative } from './contract'
import type { RoiFacts } from './prep'
import { readView, type RoiView } from './view'

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
    datasetIds: string[]
    narrative: RoiNarrative
    view: RoiView
  }
}

export function readRoiState(state: unknown): RoiArtifactState['roi'] | null {
  const roi = (state as { roi?: RoiArtifactState['roi'] } | null)?.roi
  if (!roi || typeof roi.factsFileId !== 'string' || !roi.narrative) return null
  return { ...roi, view: readView(roi.view), datasetIds: Array.isArray(roi.datasetIds) ? roi.datasetIds : [] }
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
