import { prisma } from '@/lib/prisma'
import { readStoredFile, saveStoredFile } from '@/lib/files/storage'
import { repositoryScopeWhere } from '@/lib/knowledge/tools'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import type { CodeDataset } from '@/features/flows/code-runner'
import { runRoiPrep, type RoiFacts } from './prep'
import { summarizeFacts } from './facts'
import { runAccount360Prep, type Account360Facts, type Account360Options } from './account360/prep'
import { summarizeAccount360 } from './account360/facts'

/**
 * The ROI plane — one tool per analysis template. `prepare_roi_facts` (rep
 * engagement) and `prepare_account360` (Account 360 click-stream → pipeline)
 * each run their deterministic prep over the named datasets, store the full
 * result as a file (the dashboard reads it from there) and hand the model
 * only the summary. Read-only: nothing here writes anywhere but the
 * workspace's own storage.
 */

export const ROI_FACTS_FILENAME_PREFIX = 'roi-facts-'
export const ACCOUNT360_FACTS_FILENAME_PREFIX = 'roi-a360-facts-'
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
  {
    name: 'prepare_account360',
    description:
      'Run the Account 360 ROI prep over an account\'s three extracts (the Account 360 click-stream, the parent accounts, the opportunity pull): excludes flagged users, attributes each event to the account its session was on, cohorts accounts by session volume and deep-action share (medians), and totals pipeline created and closed-won per account per month. ' +
      'Pass every dataset documentId the run named. Pass excludeUsers for any user emails the requester asked to leave out, and breadthCutoff only if they gave one (default 5: users who touched that many accounts or more are flagged and excluded). Returns a summary — every number the headline may cite. Call it once, first.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        documentIds: { type: 'array', items: { type: 'string' }, description: 'Repository dataset ids, up to 3.' },
        excludeUsers: { type: 'array', items: { type: 'string' }, description: 'User emails to exclude, from the requester\'s context.' },
        breadthCutoff: { type: 'number', description: 'Flag users who touched this many accounts or more. Default 5.' },
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
export type Account360PrepRunner = (datasets: CodeDataset[], options: Account360Options) => Promise<Account360Facts>

export class RoiToolClient {
  constructor(
    private readonly organizationId: string,
    private readonly userId: string,
    private readonly agentId: string | null = null,
    private readonly runPrep: RoiPrepRunner = runRoiPrep,
    private readonly runAccount360: Account360PrepRunner = runAccount360Prep,
  ) {}

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== 'prepare_roi_facts' && name !== 'prepare_account360') throw new Error(`Unknown ROI tool "${name}".`)
    const loaded = await this.loadDatasets(args)
    if ('error' in loaded) return loaded
    const datasets = loaded.datasets
    if (name === 'prepare_account360') return this.prepareAccount360(datasets, args)
    let facts: RoiFacts
    try {
      facts = await this.runPrep(datasets)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), hint: 'Check that the datasets are the expected extracts (repository_read shows their columns). Do not retry more than once.' }
    }
    const factsFileId = await this.store(ROI_FACTS_FILENAME_PREFIX, facts)
    const summary = summarizeFacts(facts)
    return {
      factsFileId,
      datasets: datasets.map((dataset) => ({ frame: dataset.name, filename: dataset.filename })),
      summary,
      note: 'The full result is stored for the dashboard; cite numbers from `summary` exactly as given. Sections that are null had no usable dataset — say so in the narrative rather than filling them in.',
    }
  }

  private async prepareAccount360(datasets: CodeDataset[], args: Record<string, unknown>) {
    const options: Account360Options = {
      excludeUsers: Array.isArray(args.excludeUsers) ? args.excludeUsers.filter((u): u is string => typeof u === 'string').slice(0, 200) : [],
      ...(typeof args.breadthCutoff === 'number' && args.breadthCutoff >= 2 ? { breadthCutoff: Math.round(args.breadthCutoff) } : {}),
    }
    let facts: Account360Facts
    try {
      facts = await this.runAccount360(datasets, options)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), hint: 'Check that the datasets are the click-stream, accounts and opportunity extracts (repository_read shows their columns). Do not retry more than once.' }
    }
    const factsFileId = await this.store(ACCOUNT360_FACTS_FILENAME_PREFIX, facts)
    return {
      factsFileId,
      datasets: datasets.map((dataset) => ({ frame: dataset.name, filename: dataset.filename })),
      summary: summarizeAccount360(facts),
      note: 'The full result is stored for the dashboard, which writes its own callouts from it. Cite numbers from `summary` exactly as given (money in USD).',
    }
  }

  private async store(prefix: string, value: unknown): Promise<string> {
    const saved = await saveStoredFile({
      organizationId: this.organizationId,
      userId: this.userId,
      filename: `${prefix}${Date.now()}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(value)),
      // Computed here from datasets that were checked on their way in.
      trusted: true,
    })
    return saved.id
  }

  private async loadDatasets(args: Record<string, unknown>): Promise<{ datasets: CodeDataset[] } | { error: string }> {
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
    return { datasets }
  }
}
