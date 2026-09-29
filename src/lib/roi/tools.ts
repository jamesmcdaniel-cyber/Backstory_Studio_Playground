import { prisma } from '@/lib/prisma'
import { readStoredFile, saveStoredFile } from '@/lib/files/storage'
import { repositoryScopeWhere } from '@/lib/knowledge/tools'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import type { CodeDataset } from '@/features/flows/code-runner'
import { runRoiPrep, type RoiFacts } from './prep'
import { summarizeFacts } from './facts'

/**
 * The ROI plane — one tool, `prepare_roi_facts`. It runs the deterministic
 * prep over the named datasets, stores the full result as a file (the
 * dashboard reads it from there) and hands the model only the summary.
 * Read-only: nothing here writes anywhere but the workspace's own storage.
 */

export const ROI_FACTS_FILENAME_PREFIX = 'roi-facts-'
export const ROI_MAX_DATASETS = 4

export const ROI_TOOLS = [
  {
    name: 'prepare_roi_facts',
    description:
      'Run the standard ROI prep over the repository datasets for an account: leading indicators per rep per month with baseline/observation windows, adoption cohorts (usage tiers, users vs non-users), deal engagement deciles/levels vs win rate and velocity, and the stage/persona analysis with the survivorship control. ' +
      'Pass every dataset documentId the run named (up to 4). Returns a compact summary of the computed facts — every number the narrative may cite — plus notes on what could not be computed. Call it once, first; do not recompute these with run_code.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        documentIds: { type: 'array', items: { type: 'string' }, description: `Repository dataset ids, up to ${ROI_MAX_DATASETS}.` },
      },
      required: ['documentIds'],
    },
  },
] satisfies ReadonlyArray<{
  name: string
  description: string
  isWrite: false
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}>

export type RoiPrepRunner = (datasets: CodeDataset[]) => Promise<RoiFacts>

export class RoiToolClient {
  constructor(
    private readonly organizationId: string,
    private readonly userId: string,
    private readonly agentId: string | null = null,
    private readonly runPrep: RoiPrepRunner = runRoiPrep,
  ) {}

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== 'prepare_roi_facts') throw new Error(`Unknown ROI tool "${name}".`)
    const ids = Array.isArray(args.documentIds)
      ? [...new Set(args.documentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, ROI_MAX_DATASETS)
      : []
    if (!ids.length) return { error: 'Pass the dataset documentIds from the run instructions.' }
    const docs = await prisma.knowledgeDocument.findMany({
      where: {
        id: { in: ids },
        organizationId: this.organizationId,
        isEnabled: true,
        status: 'ready',
        assetType: 'dataset',
        ...repositoryScopeWhere(this.organizationId, this.userId, this.agentId),
      },
      select: { id: true, filename: true, storedFileId: true },
    })
    const missing = ids.filter((id) => !docs.some((doc) => doc.id === id))
    if (missing.length) return { error: `No dataset with id ${missing.join(', ')} is available to you. Call repository_list to check the ids.` }
    const datasets: CodeDataset[] = []
    for (const doc of docs) {
      if (!doc.storedFileId) continue
      const stored = await readStoredFile(doc.storedFileId, this.organizationId)
      if (!stored) return { error: `The dataset "${doc.filename}" could not be read from storage.` }
      datasets.push({ name: datasetFrameName(doc.filename), filename: doc.filename, bytes: stored.buffer })
    }
    let facts: RoiFacts
    try {
      facts = await this.runPrep(datasets)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), hint: 'Check that the datasets are the expected extracts (repository_read shows their columns). Do not retry more than once.' }
    }
    const saved = await saveStoredFile({
      organizationId: this.organizationId,
      userId: this.userId,
      filename: `${ROI_FACTS_FILENAME_PREFIX}${Date.now()}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(facts)),
    })
    const summary = summarizeFacts(facts)
    return {
      factsFileId: saved.id,
      datasets: datasets.map((dataset) => ({ frame: dataset.name, filename: dataset.filename })),
      summary,
      note: 'The full result is stored for the dashboard; cite numbers from `summary` exactly as given. Sections that are null had no usable dataset — say so in the narrative rather than filling them in.',
    }
  }
}
