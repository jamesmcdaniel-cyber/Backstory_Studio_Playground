import { prisma } from '@/lib/prisma'
import { readStoredFile, saveStoredFile } from '@/lib/files/storage'
import { repositoryScopeWhere } from '@/lib/knowledge/tools'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import type { CodeDataset } from '@/features/flows/code-runner'
import { runRoiPrep, type RoiFacts } from './prep'
import { summarizeFacts } from './facts'
import { runAccount360Prep, type Account360Facts, type Account360Options } from './account360/prep'
import { summarizeAccount360 } from './account360/facts'
import { roiRunConfigSchema } from './config'
import { isRoiSourceKind, ROI_SOURCE_KINDS, type RoiSourceKind } from './sources'
import { pullRoiExtract } from './databricks'
import { loadRoiExtract } from './load-extract'
import { ROI_EXTRACT_CONTRACT } from './source-kinds'

const ACCOUNT360_KINDS: RoiSourceKind[] = ['clickstream', 'accounts', 'opportunities']

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
      'Pass the activity, usage, engagement and stage dataset documentIds the run named (up to 4; Account 360 extracts are ignored here — they go to prepare_account360), and the run\'s `config` exactly as the run gives it. Returns a compact summary of the computed facts — every number the narrative may cite, with the configured windows in `configured` — plus notes on what could not be computed. Call it once, first; do not recompute these with run_code.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        documentIds: { type: 'array', items: { type: 'string' }, description: `Repository dataset ids, up to ${ROI_MAX_DATASETS}.` },
        config: { type: 'object', description: 'The run configuration from the run instructions (windowMonths, comparison, custom, cohort, fiscalYearStartMonth). Optional.' },
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
  {
    name: 'roi_databricks_pull',
    description:
      'Run one of an account\'s warehouse queries on Databricks (SQL Statement Execution API) and load its result into the workspace Repository as that account\'s ROI extract, tagged for the ROI page. ' +
      'This is the data flow\'s step ("ROI data pull · Databricks"): the workspace\'s saved HTTP credential for the Databricks host is attached automatically. Pass the workspace host, the SQL warehouse id, the statement, the account and the extract kind. ' +
      'Returns the loaded dataset\'s id and row count; fails outright when the query or the load fails. Not for ad-hoc queries.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'The Databricks workspace host, e.g. dbc-a1b2c3d4-e5f6.cloud.databricks.com.' },
        warehouseId: { type: 'string', description: 'The SQL warehouse id (from its connection details).' },
        statement: { type: 'string', description: 'The SQL to run, with the account\'s warehouse org id already in it.' },
        account: { type: 'string', description: 'The account the extract belongs to, as the ROI page names it.' },
        kind: { type: 'string', enum: [...ROI_SOURCE_KINDS], description: 'Which extract this query produces.' },
        filename: { type: 'string', description: 'The dataset\'s file name (optional; .csv).' },
      },
      required: ['host', 'warehouseId', 'statement', 'account', 'kind'],
    },
  },
  {
    name: 'roi_load_extract',
    description:
      'Load one of an account\'s ROI extracts into the workspace Repository, tagged for the ROI page, from wherever a flow got it: a link to a CSV/TSV file (fetched here, any size up to the dataset limit; the workspace\'s saved HTTP credential for that host is applied when there is one), a file already in the workspace\'s storage (storedFileId), the file\'s text (csv), or JSON rows. ' +
      'Pass exactly one of url, storedFileId, csv or rows, plus the account (as the ROI page names it) and the extract kind. The newest extract per kind is what the page reads, so loading replaces nothing. ' +
      'Returns the dataset id, row count, the header, and the required columns the header lacks (missingColumns — fix the query rather than the report). Fails outright when nothing was loaded. Extract contracts: ' +
      ROI_SOURCE_KINDS.map((kind) => `${kind} — ${ROI_EXTRACT_CONTRACT[kind].grain} Required: ${ROI_EXTRACT_CONTRACT[kind].required.join(', ')}.`).join(' '),
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'The account the extract belongs to, as the ROI page names it.' },
        kind: { type: 'string', enum: [...ROI_SOURCE_KINDS], description: 'Which extract this is.' },
        url: { type: 'string', description: 'A link to the CSV/TSV file (https). The platform fetches it; nothing passes through the canvas.' },
        storedFileId: { type: 'string', description: 'A file already in the workspace\'s storage.' },
        csv: { type: 'string', description: 'The file\'s text, header first. Small extracts only.' },
        rows: { type: 'array', items: { type: 'object' }, description: 'The rows as objects keyed by column name. Small extracts only.' },
        filename: { type: 'string', description: 'The dataset\'s file name (optional; .csv or .tsv).' },
      },
      required: ['account', 'kind'],
    },
  },
] satisfies ReadonlyArray<{
  name: string
  description: string
  isWrite: boolean
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
    private readonly pull: typeof pullRoiExtract = pullRoiExtract,
    private readonly loadExtract: typeof loadRoiExtract = loadRoiExtract,
  ) {}

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'roi_load_extract') {
      const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : typeof args[key] === 'number' ? String(args[key]) : '')
      // Throws rather than answering { error }: a flow step must fail when nothing was loaded.
      return this.loadExtract({
        organizationId: this.organizationId,
        userId: this.userId,
        account: text('account'),
        kind: text('kind'),
        ...(text('url') ? { url: text('url') } : {}),
        ...(text('storedFileId') ? { storedFileId: text('storedFileId') } : {}),
        ...(text('csv') ? { csv: text('csv') } : {}),
        ...(Array.isArray(args.rows) ? { rows: args.rows } : {}),
        ...(text('filename') ? { filename: text('filename') } : {}),
      })
    }
    if (name === 'roi_databricks_pull') {
      const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : typeof args[key] === 'number' ? String(args[key]) : '')
      // Throws rather than answering { error }: a flow step must fail when nothing was loaded.
      return this.pull({
        organizationId: this.organizationId,
        userId: this.userId,
        host: text('host'),
        warehouseId: text('warehouseId'),
        statement: text('statement'),
        account: text('account'),
        kind: text('kind'),
        ...(text('filename') ? { filename: text('filename') } : {}),
      })
    }
    if (name !== 'prepare_roi_facts' && name !== 'prepare_account360') throw new Error(`Unknown ROI tool "${name}".`)
    const loaded = await this.loadDatasets(args, name === 'prepare_account360' ? 'account360' : 'core')
    if ('error' in loaded) return loaded
    const datasets = loaded.datasets
    if (name === 'prepare_account360') return this.prepareAccount360(datasets, args)
    const config = roiRunConfigSchema.safeParse(args.config ?? null)
    let facts: RoiFacts
    try {
      facts = await this.runPrep(datasets)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), hint: 'Check that the datasets are the expected extracts (repository_read shows their columns). Do not retry more than once.' }
    }
    const factsFileId = await this.store(ROI_FACTS_FILENAME_PREFIX, facts)
    const summary = summarizeFacts(facts, config.success ? config.data : null)
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

  private async loadDatasets(args: Record<string, unknown>, plane: 'core' | 'account360'): Promise<{ datasets: CodeDataset[] } | { error: string }> {
    let ids = Array.isArray(args.documentIds)
      ? [...new Set(args.documentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 8)
      : []
    // A tagged extract goes to the prep it belongs to, whatever the model
    // passed: a click-stream read as a usage file would skew the cohorts.
    if (ids.length) {
      const tagged = await prisma.knowledgeDocument.findMany({ where: { id: { in: ids }, organizationId: this.organizationId }, select: { id: true, sourceMetadata: true } })
      const kindOf = new Map(tagged.map((doc) => [doc.id, (doc.sourceMetadata as { roi?: { kind?: unknown } } | null)?.roi?.kind]))
      ids = ids.filter((id) => {
        const kind = kindOf.get(id)
        if (!isRoiSourceKind(kind)) return true
        return plane === 'account360' ? ACCOUNT360_KINDS.includes(kind) : !ACCOUNT360_KINDS.includes(kind)
      }).slice(0, ROI_MAX_DATASETS)
    }
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
