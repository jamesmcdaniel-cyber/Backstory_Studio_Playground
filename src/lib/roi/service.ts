import { Prisma, type RoiAnalysis } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { unwrapHtmlFence } from '@/lib/roi/text'
import { readStoredFile } from '@/lib/files/storage'
import { addVersion, createArtifact } from '@/lib/artifacts/service'
import { ensureRoiAgent, findRoiAgent, roiDataFlowIdOf } from './agent'
import { extractRoiNarrative, ROI_OUTPUT_CONTRACT, type RoiNarrative } from './contract'
import { renderRoiDashboard, ROI_RENDER_VERSION } from './dashboard'
import { runRoiPrep, type RoiFacts } from './prep'
import { readView, type RoiView } from './view'
import { currentRoiState, factsAreCurrent, readAccount360Facts, readFacts, readRoiState, stateJson, storeFacts, type RoiArtifactState } from './artifact-state'
import { summarizeFacts, type RoiFactsSummary } from './facts'
import { timeframeInstruction, timeframeLabel, type RoiTimeframe } from './timeframe'
import { ROI_SOURCE_LABEL, ROI_TEMPLATES, isRoiSourceKind, type RoiSourceKind, type RoiTemplate } from './sources'
import { renderAccount360Dashboard } from './account360/dashboard'
import type { Account360Facts } from './account360/prep'
import { summarizeAccount360 } from './account360/facts'
import { configFromPreset, describeRunConfig, presetFor, readRunConfig, type RoiRunConfig } from './config'
import { canComputeRoiData, fetchRoiData, loadedExtracts, RoiDataUnavailableError } from './data-source'
import { runKpis } from './kpis'
import { loadPersonalPage, openAccountOnPage, personalPageIds, populateFromGeneric, type OpenResult } from './personal-page'
export type { OpenResult } from './personal-page'
import type { RoiAnalysisView, RoiChatMessage, RoiDataset, RoiRunKpi, RoiRunPhase } from './types'

/**
 * ROI analyses: the service behind the ROI analysis page.
 *
 * An analysis is a request row plus an agent run. Creating one provisions
 * the ROI Analyst (the workspace's private admin agent) if there is none,
 * writes the row with the page's configuration and the reason it was run,
 * creates the report's artifact, and gets the data: the account's loaded
 * extracts at once, or — when an admin connected a data flow — a flow run
 * whose completion continues the analysis. Then the analyst runs, with the
 * row's id on its trigger so completion lands here. Reading an analysis
 * reconciles it with its run: when the run has finished and the row has no
 * report yet, the narrative is parsed against the contract and the report
 * rendered — once — as the artifact's first version.
 */

export type { RoiAnalysisView, RoiChatMessage, RoiDataset } from './types'

/** Up to every extract kind an account can have (the standard report reads all seven). */
export const ROI_MAX_DATASETS = 7
export const ROI_CONTEXT_MAX_CHARS = 4_000
export const ROI_REASON_MAX_CHARS = 2_000
export const ROI_QUESTION_MAX_CHARS = 2_000

/** What the page tells people to expect, in seconds: a full build (data and
 *  findings), and a settings change (findings rewritten on the same data). */
export const ROI_EXPECTED_SECONDS = 90
export const ROI_RECONFIGURE_EXPECTED_SECONDS = 60
export const ROI_ASYNC_AFTER_SECONDS = 180

/** A report is being updated already: one change at a time keeps its versions in order. */
export class RoiBusyError extends Error {}

const ACCOUNT360_KINDS: RoiSourceKind[] = ['clickstream', 'accounts', 'opportunities']

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

function chatOf(row: RoiAnalysis): RoiChatMessage[] {
  return Array.isArray(row.chat) ? (row.chat as RoiChatMessage[]) : []
}

function datasetIdsOf(row: RoiAnalysis): string[] {
  return Array.isArray(row.datasetIds) ? (row.datasetIds as unknown[]).filter((id): id is string => typeof id === 'string') : []
}

type LoadedDataset = RoiDataset & { kind: RoiSourceKind | null }

async function loadDatasets(organizationId: string, ids: string[]): Promise<LoadedDataset[]> {
  if (!ids.length) return []
  const docs = await prisma.knowledgeDocument.findMany({
    where: { id: { in: ids }, organizationId, assetType: 'dataset', isEnabled: true, status: 'ready' },
    select: { id: true, filename: true, sourceMetadata: true },
  })
  return ids
    .map((id) => docs.find((doc) => doc.id === id))
    .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc))
    .map((doc) => {
      const metadata = doc.sourceMetadata as { dataset?: { rowCount?: number }; roi?: { kind?: unknown } } | null
      return {
        documentId: doc.id,
        filename: doc.filename,
        frame: datasetFrameName(doc.filename),
        rows: metadata?.dataset?.rowCount ?? null,
        kind: isRoiSourceKind(metadata?.roi?.kind) ? metadata.roi.kind : null,
      }
    })
}

function datasetsBlock(datasets: LoadedDataset[]): string {
  return datasets.map((dataset) => `- ${dataset.filename} → documentId ${dataset.documentId}, frame "${dataset.frame}"${dataset.kind ? `, ${ROI_SOURCE_LABEL[dataset.kind].toLowerCase()}` : ''}${dataset.rows ? `, ${dataset.rows.toLocaleString()} rows` : ''}`).join('\n')
}

export function buildAnalysisPrompt(params: { account: string; timeframe: RoiTimeframe; context: string; datasets: RoiDataset[] }): string {
  return [
    `Build the ROI story for the account "${params.account}".`,
    '',
    `TIME FRAME: ${timeframeLabel(params.timeframe)}. ${timeframeInstruction(params.timeframe)}`,
    '',
    'DATASETS (repository documents — load with run_code documentIds):',
    datasetsBlock(params.datasets.map((dataset) => ({ ...dataset, kind: null }))),
    '',
    params.context.trim() ? `ADDITIONAL CONTEXT FROM THE REQUESTER:\n${params.context.trim()}\n` : '',
    'Call prepare_roi_facts once with every documentId above, then return the narrative contract.',
    '',
    'OUTPUT',
    ROI_OUTPUT_CONTRACT,
  ].join('\n')
}

export function buildAccount360Prompt(params: { account: string; context: string; datasets: RoiDataset[] }): string {
  return [
    `Build the Account 360 ROI analysis for the account "${params.account}".`,
    '',
    'DATASETS (repository documents — pass every documentId to prepare_account360):',
    datasetsBlock(params.datasets.map((dataset) => ({ ...dataset, kind: null }))),
    '',
    params.context.trim() ? `ADDITIONAL CONTEXT FROM THE REQUESTER:\n${params.context.trim()}\n` : '',
    'Call prepare_account360 once (pass excludeUsers for any users the requester asked to leave out), then answer with the dashboard\'s headline only: one or two plain sentences, figure first, stating the strongest relationship between engagement and pipeline the summary shows. No Markdown, no JSON, no preamble.',
  ].join('\n')
}

/** The standard report's run: both preps where their extracts exist, then the narrative. */
export function buildStandardPrompt(params: { account: string; config: RoiRunConfig; reason: string; context: string; datasets: LoadedDataset[] }): string {
  const a360 = params.datasets.filter((dataset) => dataset.kind && ACCOUNT360_KINDS.includes(dataset.kind))
  const core = params.datasets.filter((dataset) => !a360.includes(dataset))
  const ids = (list: LoadedDataset[]) => JSON.stringify(list.map((dataset) => dataset.documentId))
  return [
    `Build the ROI analysis for the account "${params.account}".`,
    '',
    `WHY IT WAS RUN: ${params.reason.trim() || 'not stated'}. Shape the emphasis to it; never change a number because of it.`,
    '',
    `CONFIGURATION: ${describeRunConfig(params.config).join('. ')}. Windows count back from the newest full month in the data unless explicit months are given. prepare_roi_facts returns these windows' averages and percent changes in its summary's \`configured\` block — cite those for every observation-vs-baseline claim.`,
    '',
    'DATASETS (repository documents):',
    datasetsBlock(params.datasets),
    '',
    params.context.trim() ? `ADDITIONAL CONTEXT FROM THE REQUESTER:\n${params.context.trim()}\n` : '',
    'STEPS',
    core.length ? `1. Call prepare_roi_facts ONCE with documentIds ${ids(core)} and config ${JSON.stringify(params.config)}.` : '1. No activity, usage or deal extracts are loaded: skip prepare_roi_facts and say so in caveats.',
    a360.length ? `2. Call prepare_account360 ONCE with documentIds ${ids(a360)} (pass excludeUsers for any users the requester asked to leave out).` : '2. No Account 360 extracts are loaded: skip prepare_account360; the report leaves out the Account engagement tab (the account-level deal view stays under Deal engagement).',
    '3. If Backstory tools are available, look the customer account up for the `context` block (see your instructions); otherwise leave it out.',
    '4. Return the narrative contract below. Findings may point at the activity, adoption, deals, stage or accounts tab.',
    '',
    'OUTPUT',
    ROI_OUTPUT_CONTRACT,
  ].join('\n')
}

export type RoiResults = {
  narrative: RoiNarrative
  summary: RoiFactsSummary
  factsFileId: string
  a360FactsFileId?: string
  artifactId?: string
  /** The report version this run produced. */
  versionId?: string
  /** For a build started from someone's page: the version it put on their page. */
  personalVersionId?: string
  pageError?: string
  personal?: true
  populatePage?: true
  mode?: RoiRunMode
  kpis?: RoiRunKpi[]
}

/** A full build computes the data and writes the findings; a reconfigure rewrites the findings on the data the report already has. */
export type RoiRunMode = 'full' | 'reconfigure'
/** `source` carries a value readout's provenance onto the rewritten version, so later changes are rewrites too. */
type ReconfigureMarker = { factsFileId: string; a360FactsFileId: string | null; source?: 'readout' }

function reconfigureOf(row: Pick<RoiAnalysis, 'results'>): ReconfigureMarker | null {
  const marker = (row.results as { reconfigure?: ReconfigureMarker } | null)?.reconfigure
  return marker && typeof marker.factsFileId === 'string' ? marker : null
}

/**
 * What a run is for, carried on the row from start to finish: a version of
 * someone's own page (personal); a build of an account's report that lands
 * on its requester's page too (populatePage — every build of an account's
 * report does, unless it is a separate artifact the person asked for).
 */
type RunMarkers = { personal?: true; populatePage?: true; separate?: true; basedOn?: { artifactId: string; versionId: string } }

function markersOf(row: Pick<RoiAnalysis, 'results'>): RunMarkers {
  const r = row.results as { personal?: unknown; populatePage?: unknown; separate?: unknown; basedOn?: { artifactId?: unknown; versionId?: unknown } } | null
  return {
    ...(r?.personal === true ? { personal: true as const } : {}),
    ...(r?.populatePage === true ? { populatePage: true as const } : {}),
    ...(r?.separate === true ? { separate: true as const } : {}),
    ...(typeof r?.basedOn?.artifactId === 'string' && typeof r.basedOn.versionId === 'string' ? { basedOn: { artifactId: r.basedOn.artifactId, versionId: r.basedOn.versionId } } : {}),
  }
}
export type Account360Results = { template: 'account360'; headline: string; summary: ReturnType<typeof summarizeAccount360>; factsFileId: string; artifactId?: string; kpis?: RoiRunKpi[] }

async function startRun(params: {
  organizationId: string
  userId: string
  agentId: string
  agentType: string
  title: string
  input: string
  trigger: Record<string, unknown>
}): Promise<string> {
  const execution = await prisma.agentExecution.create({
    data: {
      agentType: params.agentType,
      agentTaskId: params.agentId,
      status: 'pending',
      input: { prompt: params.input },
      trigger: jsonValue(params.trigger),
      metadata: { title: params.title },
      userId: params.userId,
      organizationId: params.organizationId,
    },
  })
  try {
    await dispatchAgentExecution({
      executionId: execution.id,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      input: params.input,
    })
  } catch (error) {
    await prisma.agentExecution.update({
      where: { id: execution.id, organizationId: params.organizationId },
      data: { status: 'failed', error: error instanceof Error ? error.message : String(error), completedAt: new Date() },
    }).catch(() => undefined)
    throw error
  }
  return execution.id
}

/** One report per account: its title names the account and nothing that a settings change would make stale. */
function titleFor(template: RoiTemplate, account: string): string {
  return template === 'account360' ? `Account 360 ROI · ${account}` : `ROI analysis · ${account}`
}

/** Where a run's notification lands: the ROI page, on the account's report. */
export function roiPageLink(account: string): string {
  return `/roi?account=${encodeURIComponent(account)}`
}

export async function createRoiAnalysis(params: {
  organizationId: string
  userId: string
  account: string
  /** The page's configuration; older callers pass a timeframe preset instead. */
  config?: RoiRunConfig
  timeframe?: RoiTimeframe
  /** Why it was run — required on the page. */
  reason?: string
  context?: string
  datasetIds?: string[]
  /** The view to render with — carried over when a dashboard is rebuilt for another account. */
  view?: RoiView
  /** Which analysis to build. Defaults to the standard report. */
  template?: RoiTemplate
  /** The account's report, when it has one: the build lands on it as a new version. */
  artifactId?: string | null
  /** What the run is for (see RunMarkers). */
  markers?: RunMarkers
}): Promise<RoiAnalysis> {
  const template: RoiTemplate = params.template ?? 'standard'
  const config = params.config ?? configFromPreset(params.timeframe?.preset)
  const account = params.account.trim().slice(0, 200)
  const reason = (params.reason ?? '').trim().slice(0, ROI_REASON_MAX_CHARS)
  const agent = await ensureRoiAgent(params.organizationId, params.userId)
  const dataFlowId = params.datasetIds?.length ? null : roiDataFlowIdOf(agent)
  // Without a data flow the extracts must already be there: refuse before
  // anything is written, so a bad request leaves no empty artifact behind.
  const preloaded = params.datasetIds?.length ? params.datasetIds : dataFlowId ? null : await loadedExtracts(params.organizationId, account, template)
  const row = await prisma.roiAnalysis.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      agentTaskId: agent.id,
      account,
      template,
      timeframe: jsonValue({ preset: presetFor(config) }),
      config: jsonValue(config),
      reason,
      context: (params.context ?? '').trim().slice(0, ROI_CONTEXT_MAX_CHARS),
      datasetIds: jsonValue(preloaded ?? []),
      ...(params.view ? { view: jsonValue(params.view) } : {}),
      ...(params.markers && Object.keys(params.markers).length ? { results: jsonValue(params.markers) } : {}),
      status: 'pending',
    },
  })
  // The artifact is where the report lives, so it exists from the start (no
  // versions yet) and its page follows the run. The first version lands on it
  // when the run finishes.
  const existing = params.artifactId
    ? await prisma.artifact.findFirst({ where: { id: params.artifactId, organizationId: params.organizationId }, select: { id: true } })
    : null
  const artifact = existing ?? await prisma.artifact.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      kind: template === 'account360' ? 'page' : 'roi_dashboard',
      title: titleFor(template, account),
      agentTaskId: agent.id,
    },
  })
  await prisma.roiAnalysis.update({ where: { id: row.id, organizationId: params.organizationId }, data: { artifactId: artifact.id } })
  const fail = (error: unknown) => prisma.roiAnalysis.update({
    where: { id: row.id, organizationId: params.organizationId },
    data: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
  })
  if (preloaded) {
    try {
      return await startAnalyst({ ...row, artifactId: artifact.id }, preloaded)
    } catch (error) {
      return fail(error)
    }
  }
  try {
    const data = await fetchRoiData({ organizationId: params.organizationId, userId: params.userId, analysisId: row.id, account, reason, config, template, dataFlowId })
    if (data.kind === 'ready') return await startAnalyst({ ...row, artifactId: artifact.id }, data.datasetIds)
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: params.organizationId },
      data: { status: 'fetching', results: jsonValue({ ...(params.markers ?? {}), dataFlowRunId: data.flowRunId }) },
    })
  } catch (error) {
    return fail(error)
  }
}

/** Start the analyst on the row's extracts. */
async function startAnalyst(row: RoiAnalysis, datasetIds: string[]): Promise<RoiAnalysis> {
  const template = (row.template in ROI_TEMPLATES ? row.template : 'standard') as RoiTemplate
  const datasets = await loadDatasets(row.organizationId, datasetIds.slice(0, ROI_MAX_DATASETS))
  if (!datasets.length) throw new RoiDataUnavailableError(`None of the ${ROI_TEMPLATES[template].label} extracts for "${row.account}" could be read from the repository.`)
  const agent = row.agentTaskId ? await prisma.agentTask.findFirst({ where: { id: row.agentTaskId, organizationId: row.organizationId }, select: { id: true, agentType: true } }) : null
  if (!agent) throw new Error('The ROI Analyst is no longer available.')
  const config = readRunConfig(row.config)
  const input = template === 'account360'
    ? buildAccount360Prompt({ account: row.account, context: row.context, datasets })
    : template === 'engagement'
      ? buildAnalysisPrompt({ account: row.account, timeframe: { preset: presetFor(config) }, context: row.context, datasets })
      : buildStandardPrompt({ account: row.account, config, reason: row.reason, context: row.context, datasets })
  const executionId = await startRun({
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: agent.id,
    agentType: agent.agentType,
    title: titleFor(template, row.account),
    input,
    trigger: { type: 'roi_analysis', analysisId: row.id, link: template === 'standard' ? roiPageLink(row.account) : row.artifactId ? `/artifacts/${row.artifactId}` : roiPageLink(row.account) },
  })
  return prisma.roiAnalysis.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: { executionId, status: 'running', datasetIds: jsonValue(datasets.map((dataset) => dataset.documentId)), results: Object.keys(markersOf(row)).length ? jsonValue(markersOf(row)) : Prisma.DbNull },
  })
}

/**
 * The data flow finished: start the analyst on what it loaded, or record
 * why there is nothing to analyse. Called from the flow's finalizer, and
 * again by any read that finds the row still waiting on a finished flow.
 */
export async function continueRoiAnalysisAfterDataFlow(organizationId: string, analysisId: string, outcome: { status: string; error?: string | null }): Promise<void> {
  // Claim the row: only a row still fetching moves on, once.
  const claimed = await prisma.roiAnalysis.updateMany({ where: { id: analysisId, organizationId, status: 'fetching' }, data: { status: 'pending' } })
  if (!claimed.count) return
  const row = await prisma.roiAnalysis.findFirst({ where: { id: analysisId, organizationId } })
  if (!row) return
  const fail = (message: string) => prisma.roiAnalysis.update({ where: { id: row.id, organizationId }, data: { status: 'failed', error: message } })
  if (outcome.status !== 'succeeded') {
    await fail(`The data flow did not finish${outcome.error ? `: ${outcome.error}` : '.'} Open the flow's runs to see why.`)
    return
  }
  try {
    const template = (row.template in ROI_TEMPLATES ? row.template : 'standard') as RoiTemplate
    await startAnalyst(row, await loadedExtracts(organizationId, row.account, template))
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error))
  }
}

async function reconcileFetching(row: RoiAnalysis): Promise<RoiAnalysis> {
  if (row.status !== 'fetching') return row
  const flowRunId = (row.results as { dataFlowRunId?: unknown } | null)?.dataFlowRunId
  if (typeof flowRunId !== 'string') return row
  const run = await prisma.flowRun.findFirst({ where: { id: flowRunId, organizationId: row.organizationId }, select: { status: true, error: true } })
  if (!run) {
    await continueRoiAnalysisAfterDataFlow(row.organizationId, row.id, { status: 'failed', error: 'the flow run is gone' })
  } else if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
    await continueRoiAnalysisAfterDataFlow(row.organizationId, row.id, { status: run.status, error: run.error })
  } else {
    return row
  }
  return (await prisma.roiAnalysis.findFirst({ where: { id: row.id, organizationId: row.organizationId } })) ?? row
}

/** The analysis with its run reconciled: status brought up to date, the
 *  report rendered once the run finished, pending chat answers filled in. */
export async function loadRoiAnalysis(organizationId: string, id: string): Promise<(RoiAnalysis & { datasets: RoiDataset[]; phase: RoiRunPhase }) | null> {
  let row = await prisma.roiAnalysis.findFirst({ where: { id, organizationId } })
  if (!row) return null
  row = await reconcileFetching(row)
  row = await recheckContractFailure(row)
  row = await recheckUnsavedReport(row)
  row = await reconcileRun(row)
  row = await reconcileChat(row)
  const datasets = await loadDatasets(organizationId, datasetIdsOf(row))
  return { ...row, datasets: datasets.map(({ kind: _kind, ...dataset }) => dataset), phase: await phaseOf(row) }
}

/** Where a run is, for the page's progress state. */
async function phaseOf(row: RoiAnalysis): Promise<RoiRunPhase> {
  if (row.status === 'completed') return 'ready'
  if (isTerminalRunStatus(row.status) || row.status === 'failed') return 'failed'
  if (row.status === 'fetching') return 'fetching'
  if (row.status === 'building') return 'building'
  if (row.status === 'pending' || !row.executionId) return 'queued'
  if (reconfigureOf(row)) return 'writing'
  const steps = await prisma.workflowStep.findMany({ where: { executionId: row.executionId, node: { contains: 'prepare_' } }, select: { status: true } })
  if (!steps.length) return 'computing'
  return steps.some((step) => step.status === 'running' || step.status === 'pending') ? 'computing' : 'writing'
}

/** The facts file the run's prep call stored — the newest, if it ran more than once. */
async function factsFileIdFor(executionId: string, tool = 'prepare_roi_facts'): Promise<string | null> {
  const steps = await prisma.workflowStep.findMany({
    where: { executionId, node: { contains: tool } },
    orderBy: { createdAt: 'desc' },
    select: { output: true },
  })
  for (const step of steps) {
    const id = (step.output as { factsFileId?: unknown } | null)?.factsFileId
    if (typeof id === 'string' && id) return id
  }
  return null
}

async function finalMessage(executionId: string, organizationId: string): Promise<{ status: string; text: string; error: string | null } | null> {
  const execution = await prisma.agentExecution.findFirst({
    where: { id: executionId, organizationId },
    select: { status: true, output: true, error: true },
  })
  if (!execution) return null
  const output = execution.output as { summary?: unknown } | null
  const text = typeof output?.summary === 'string' ? output.summary : ''
  return { status: execution.status, text, error: typeof execution.error === 'string' ? execution.error : null }
}

async function readJsonFile<T>(fileId: string | null, organizationId: string): Promise<T | null> {
  if (!fileId) return null
  const stored = await readStoredFile(fileId, organizationId).catch(() => null)
  if (!stored) return null
  try {
    return JSON.parse(stored.buffer.toString('utf8')) as T
  } catch {
    return null
  }
}

const EMPTY_FACTS: RoiFacts = { U: null, OPP: null, ST: null, META: {}, notes: [] }

/** A claim on a finished run older than this is from a reader that died mid-render; it can be taken over. */
const BUILD_CLAIM_STALE_MS = 5 * 60_000

async function reconcileRun(row: RoiAnalysis, claimFrom: { status: string; updatedAt: Date } = row): Promise<RoiAnalysis> {
  if (!row.executionId || isTerminalRunStatus(row.status)) return row
  if (row.status === 'building' && Date.now() - row.updatedAt.getTime() < BUILD_CLAIM_STALE_MS) return row
  const run = await finalMessage(row.executionId, row.organizationId)
  if (!run) return row
  if (!isTerminalRunStatus(run.status)) {
    return run.status !== row.status
      ? prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { status: run.status } })
      : row
  }
  // One reader finishes a run: the executor and every page polling it race
  // here, and each would otherwise add the report version again.
  if (run.status === 'completed') {
    const claimed = await prisma.roiAnalysis.updateMany({
      where: { id: row.id, organizationId: row.organizationId, status: claimFrom.status, updatedAt: claimFrom.updatedAt },
      data: { status: 'building' },
    })
    if (!claimed.count) return (await prisma.roiAnalysis.findFirst({ where: { id: row.id, organizationId: row.organizationId } })) ?? row
  }
  if (run.status !== 'completed') {
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: row.organizationId },
      data: { status: run.status, error: run.error ?? (run.status === 'blocked' ? 'The run was blocked before it could finish.' : 'The run did not complete.') },
    })
  }
  if (row.template === 'account360') return completeAccount360(row, run.text)
  const markers = markersOf(row)
  const fail = (error: string) => prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { status: 'failed', error, results: Object.keys(markers).length ? jsonValue(markers) : Prisma.DbNull } })
  const extracted = extractRoiNarrative(run.text)
  if (extracted.error !== undefined) return fail(`${extracted.error} Open the run for the agent's full output.`)
  // A settings change reuses the report's computed data: its run only writes.
  const reconfigure = reconfigureOf(row)
  let factsFileId = reconfigure ? reconfigure.factsFileId : await factsFileIdFor(row.executionId)
  const a360FactsFileId = reconfigure ? reconfigure.a360FactsFileId : row.template === 'standard' ? await factsFileIdFor(row.executionId, 'prepare_account360') : null
  let facts = await readJsonFile<RoiFacts>(factsFileId, row.organizationId)
  const a360 = await readJsonFile<Account360Facts>(a360FactsFileId, row.organizationId)
  if (!facts && !a360) return fail('The run finished without computing the facts (prepare_roi_facts did not store a result). Open the run to see what happened.')
  // A report from Account 360 extracts alone still needs a facts file of its
  // own: the dashboard's state always names one.
  if (!facts || !factsFileId) {
    facts = EMPTY_FACTS
    factsFileId = await storeFacts(row.organizationId, row.userId, facts)
  }
  const config = readRunConfig(row.config)
  // A view carried over from another dashboard may add metrics this run's
  // prep did not compute; recompute once with them so the report shows them.
  const view = readView(row.view)
  if (view.extraMetrics.length && facts.U && view.extraMetrics.some((metric) => !(metric.key in facts!.U!.labels))) {
    const recomputed = await recomputeWithMetrics(row, view).catch(() => null)
    if (recomputed) {
      facts = { ...facts, U: recomputed.U, META: { ...facts.META, capP: recomputed.META.capP, capPO: recomputed.META.capPO } }
      factsFileId = await storeFacts(row.organizationId, row.userId, facts).catch(() => factsFileId!)
    }
  }
  const generatedAt = new Date().toISOString()
  // A change to someone's own page keeps the page's live account data.
  const pageLive = markers.personal && row.artifactId ? (await currentRoiState(row.organizationId, row.artifactId).catch(() => null))?.state.live : undefined
  const reportHtml = renderRoiDashboard(facts, extracted.data, { account: row.account, generatedAt, view, config, reason: row.reason, a360, live: pageLive })
  const roiState = stateJson({
    analysisId: row.id,
    account: row.account,
    timeframePreset: presetFor(config),
    factsFileId: factsFileId!,
    ...(a360FactsFileId && a360 ? { a360FactsFileId } : {}),
    datasetIds: datasetIdsOf(row),
    narrative: extracted.data,
    view,
    config,
    reason: row.reason,
    ...('DEALS' in facts ? { factsVersion: 2 } : {}),
    ...(reconfigure?.source === 'readout' ? { source: 'readout' as const } : {}),
    ...(markers.personal ? { personal: true, ...(markers.basedOn ? { basedOn: markers.basedOn } : {}), ...(pageLive ? { live: pageLive } : {}) } : {}),
    render: ROI_RENDER_VERSION,
  })
  const request = [row.account, reconfigure ? 'settings changed' : 'built from the extracts', describeRunConfig(config).join(', '), row.reason.trim() ? `for ${row.reason.trim()}` : ''].filter(Boolean).join(' · ').slice(0, 300)
  let versionId: string | undefined
  let artifactId: string | undefined
  try {
    if (row.artifactId) {
      versionId = (await addVersion({ artifactId: row.artifactId, organizationId: row.organizationId, content: reportHtml, executionId: row.executionId, request, createdByUserId: row.userId, state: roiState })).id
      artifactId = row.artifactId
    } else {
      const created = await createArtifact({ organizationId: row.organizationId, userId: row.userId, kind: 'roi_dashboard', title: titleFor('standard', row.account), content: reportHtml, agentTaskId: row.agentTaskId, executionId: row.executionId, state: roiState })
      artifactId = created.artifact.id
      versionId = created.version.id
    }
  } catch (error) {
    // Never "completed" with nothing to show: say why the report did not save.
    return fail(`The report was built but could not be saved: ${error instanceof Error ? error.message : String(error)}`)
  }
  // A build of an account's report lands on its requester's own page too, in
  // their layout — whether or not the marker survived an older reader. A
  // separate artifact (asked for by name) does not. The report is saved either way.
  let personalVersionId: string | undefined
  let pageError: string | undefined
  if (!markers.personal && !markers.separate && row.template === 'standard' && artifactId && !(await personalPageIds(row.organizationId)).has(artifactId)) {
    await populateFromGeneric({ organizationId: row.organizationId, userId: row.userId, account: row.account, genericArtifactId: artifactId, config, reason: row.reason, request: `${row.account} · new data, ${describeRunConfig(config)[0].toLowerCase()}` })
      .then((made) => { personalVersionId = made.versionId })
      .catch((error) => { pageError = error instanceof Error ? error.message : String(error) })
  }
  const results: RoiResults = {
    ...markers,
    ...(personalVersionId ? { personalVersionId } : {}),
    ...(pageError ? { pageError } : {}),
    narrative: extracted.data,
    summary: summarizeFacts(facts, config),
    factsFileId: factsFileId!,
    ...(a360FactsFileId && a360 ? { a360FactsFileId } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(versionId ? { versionId } : {}),
    mode: reconfigure ? 'reconfigure' : 'full',
    kpis: runKpis(facts, a360, config),
  }
  return prisma.roiAnalysis.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: { status: 'completed', error: null, results: jsonValue(results), reportHtml },
  })
}

/** A finished Account 360 run: render the page from its stored result, headed by the agent's line. */
async function completeAccount360(row: RoiAnalysis, text: string): Promise<RoiAnalysis> {
  const fail = (error: string) => prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { status: 'failed', error } })
  const factsFileId = row.executionId ? await factsFileIdFor(row.executionId, 'prepare_account360') : null
  const facts = await readJsonFile<Account360Facts>(factsFileId, row.organizationId)
  if (!factsFileId || !facts) return fail('The run finished without computing the analysis (prepare_account360 did not store a result). Open the run to see what happened.')
  // The headline is prose; anything that isn't (a fence, JSON, a heading)
  // is dropped rather than shown.
  const headline = unwrapHtmlFence(text).replace(/^#+\s*/gm, '').trim().split(/\n\s*\n/)[0]?.trim().slice(0, 400) ?? ''
  const lede = /^[[{<]/.test(headline) ? '' : headline
  const html = renderAccount360Dashboard(facts, { account: row.account, generatedAt: new Date().toISOString(), lede })
  const state = { roi: { template: 'account360', analysisId: row.id, account: row.account, factsFileId, datasetIds: datasetIdsOf(row), headline: lede } }
  const artifactId = row.artifactId
    ? await addVersion({ artifactId: row.artifactId, organizationId: row.organizationId, content: html, executionId: row.executionId, request: 'Built from the extracts', createdByUserId: row.userId, state: jsonValue(state) })
      .then(() => row.artifactId!)
      .catch(() => undefined)
    : await createArtifact({
      organizationId: row.organizationId,
      userId: row.userId,
      kind: 'page',
      title: `Account 360 ROI · ${row.account}`,
      content: html,
      agentTaskId: row.agentTaskId,
      executionId: row.executionId,
      state: jsonValue(state),
    }).then(({ artifact }) => artifact.id).catch(() => undefined)
  const results: Account360Results = { template: 'account360', headline: lede, summary: summarizeAccount360(facts), factsFileId, ...(artifactId ? { artifactId } : {}), kpis: runKpis(null, facts, readRunConfig(row.config)) }
  return prisma.roiAnalysis.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: { status: 'completed', error: null, results: jsonValue(results), reportHtml: html },
  })
}

async function reconcileChat(row: RoiAnalysis): Promise<RoiAnalysis> {
  const chat = chatOf(row)
  const pending = chat.filter((message) => message.role === 'agent' && message.status === 'pending' && message.executionId)
  if (!pending.length) return row
  let changed = false
  for (const message of pending) {
    const run = await finalMessage(message.executionId!, row.organizationId)
    if (!run || !isTerminalRunStatus(run.status)) continue
    changed = true
    if (run.status === 'completed') {
      message.content = unwrapHtmlFence(run.text) || 'The agent finished without an answer.'
      message.status = 'completed'
    } else {
      message.content = run.error ?? `The follow-up run ${run.status}.`
      message.status = 'failed'
    }
  }
  if (!changed) return row
  return prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { chat: jsonValue(chat) } })
}

/**
 * A run whose answer failed the narrative contract is checked again, once,
 * by whatever code reads it now: a worker running older code judges a newer
 * agent's answer by the older contract (more findings, a new tab) and fails a
 * run that the current contract accepts. Nothing is re-run — the answer is
 * stored on the execution.
 */
async function recheckContractFailure(row: RoiAnalysis): Promise<RoiAnalysis> {
  if (row.status !== 'failed' || !row.executionId || !row.error) return row
  if (!/narrative contract|was not valid JSON|No JSON object|without computing the facts|could not be saved/.test(row.error)) return row
  if ((row.results as { contractRechecked?: unknown } | null)?.contractRechecked) return row
  const run = await finalMessage(row.executionId, row.organizationId)
  if (run?.status !== 'completed') return row
  // Claimed from its failed state, so concurrent readers re-check it once.
  const rechecked = await reconcileRun({ ...row, status: 'running' }, { status: 'failed', updatedAt: row.updatedAt })
  if (rechecked.status === 'completed' || rechecked.status === 'building') return rechecked
  return markRechecked(rechecked)
}

function markRechecked(row: RoiAnalysis): Promise<RoiAnalysis> {
  return prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { results: jsonValue({ ...markersOf(row), contractRechecked: true }) } })
}

/**
 * A run that says "completed" but saved no report — an older reader
 * rendered it with older code, the startup validator refused the save, and
 * the refusal was swallowed — is rendered again, once, from what the run
 * stored. Nothing is re-run. When it still cannot be saved, the run says why.
 */
async function recheckUnsavedReport(row: RoiAnalysis): Promise<RoiAnalysis> {
  if (row.status !== 'completed' || !row.executionId || !row.artifactId || row.template === 'account360') return row
  const results = row.results as (Partial<RoiResults> & { contractRechecked?: unknown }) | null
  if (!results || results.versionId || results.contractRechecked) return row
  const saved = await prisma.artifactVersion.findFirst({ where: { artifactId: row.artifactId, organizationId: row.organizationId, executionId: row.executionId }, select: { id: true } })
  if (saved) return prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { results: jsonValue({ ...results, versionId: saved.id }) } })
  // Claimed from its completed state, so concurrent readers render it once.
  const rendered = await reconcileRun({ ...row, status: 'running' }, { status: 'completed', updatedAt: row.updatedAt })
  if (rendered.status === 'building' || (rendered.status === 'completed' && (rendered.results as { versionId?: unknown } | null)?.versionId)) return rendered
  return markRechecked(rendered)
}

/** Phase without querying the run's steps — for lists; the page polls in-flight runs for the precise one. */
function quickPhase(row: RoiAnalysis): RoiRunPhase {
  if (row.status === 'completed') return 'ready'
  if (row.status === 'failed' || isTerminalRunStatus(row.status)) return 'failed'
  if (row.status === 'fetching') return 'fetching'
  if (row.status === 'building') return 'building'
  if (row.status === 'pending' || !row.executionId) return 'queued'
  return reconfigureOf(row) ? 'writing' : 'computing'
}

export function serializeRoiAnalysis(row: RoiAnalysis & { datasets?: RoiDataset[]; phase?: RoiRunPhase }, requestedBy: string | null = null, viewerUserId: string | null = null): RoiAnalysisView {
  const config = row.config && typeof row.config === 'object' && Object.keys(row.config as object).length
    ? readRunConfig(row.config)
    : configFromPreset((row.timeframe as { preset?: string } | null)?.preset)
  const results = row.results as (RoiResults | Account360Results | { dataFlowRunId?: string } | { reconfigure?: ReconfigureMarker }) | null
  const kpis = results && 'kpis' in results && Array.isArray(results.kpis) ? results.kpis : []
  const finished = results && 'narrative' in results ? results : null
  const mode: RoiRunMode = reconfigureOf(row) || finished?.mode === 'reconfigure' ? 'reconfigure' : 'full'
  // Where the run shows on the viewer's own page: a change to their page is a
  // version of it; a build they started landed a version on it as well.
  const mine = Boolean(viewerUserId) && row.userId === viewerUserId
  const saved = row.status === 'completed' ? (row.results as { personal?: unknown; versionId?: unknown; personalVersionId?: unknown } | null) : null
  const pageVersionId = mine && saved ? ((saved.personal === true ? saved.versionId : saved.personalVersionId) as string | undefined) ?? null : null
  return {
    id: row.id,
    account: row.account,
    template: row.template,
    timeframe: row.timeframe as RoiTimeframe,
    timeframeLabel: timeframeLabel(row.timeframe as RoiTimeframe),
    config,
    configSummary: describeRunConfig(config),
    reason: row.reason,
    context: row.context,
    status: row.status,
    phase: row.phase ?? quickPhase(row),
    error: row.error,
    executionId: row.executionId,
    agentTaskId: row.agentTaskId,
    artifactId: row.artifactId,
    hasReport: Boolean(row.reportHtml),
    results: results && ('dataFlowRunId' in results || 'reconfigure' in results) ? null : results,
    mode,
    versionId: finished?.versionId ?? null,
    pageVersionId,
    kpis,
    chat: chatOf(row),
    datasets: row.datasets ?? [],
    requestedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.status === 'completed' ? row.updatedAt.toISOString() : null,
  }
}

/**
 * Re-check the newest runs an older reader got wrong — contract failures
 * (recheckContractFailure) and reports that never saved
 * (recheckUnsavedReport) — so history and the page show recovered runs
 * without anyone opening them.
 */
export async function recheckRecentRuns(organizationId: string): Promise<number> {
  const since = new Date(Date.now() - 14 * 86_400_000)
  const [failed, completed] = await Promise.all([
    prisma.roiAnalysis.findMany({ where: { organizationId, status: 'failed', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.roiAnalysis.findMany({ where: { organizationId, status: 'completed', template: { not: 'account360' }, artifactId: { not: null }, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])
  const unsaved = completed.filter((row) => {
    const results = row.results as { versionId?: unknown; contractRechecked?: unknown } | null
    return results && !results.versionId && !results.contractRechecked
  }).slice(0, 5)
  let recovered = 0
  for (const row of failed) {
    const next = await recheckContractFailure(row).catch(() => row)
    if (next.status === 'completed') recovered += 1
  }
  for (const row of unsaved) {
    const next = await recheckUnsavedReport(row).catch(() => row)
    if ((next.results as { versionId?: unknown } | null)?.versionId) recovered += 1
  }
  return recovered
}

/**
 * The page's run history, newest first, with who ran each: every build of
 * an account's report, and the viewer's own changes to their page — never
 * someone else's page.
 */
export async function listRoiAnalyses(organizationId: string, viewerUserId: string, take = 200): Promise<RoiAnalysisView[]> {
  // Everything but reportHtml, which is megabytes and unused by a list.
  const rows = await prisma.roiAnalysis.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true, organizationId: true, userId: true, agentTaskId: true, executionId: true, artifactId: true, account: true, template: true,
      timeframe: true, config: true, reason: true, context: true, datasetIds: true, status: true, error: true, results: true, view: true, chat: true,
      createdAt: true, updatedAt: true,
    },
  })
  const personal = await personalPageIds(organizationId)
  const visible = rows.filter((row) => row.userId === viewerUserId || (!markersOf(row).personal && !(row.artifactId && personal.has(row.artifactId))))
  const userIds = [...new Set(visible.map((row) => row.userId))]
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, organizationId }, select: { id: true, name: true, email: true } }) : []
  const nameOf = new Map(users.map((user) => [user.id, user.name?.trim() || user.email || null]))
  return visible.map((row) => serializeRoiAnalysis({ ...row, reportHtml: null }, nameOf.get(row.userId) ?? null, viewerUserId))
}

/** Recompute an analysis's facts with added metrics (a carried-over view). */
async function recomputeWithMetrics(row: RoiAnalysis, view: RoiView): Promise<RoiFacts> {
  const docs = await prisma.knowledgeDocument.findMany({ where: { id: { in: datasetIdsOf(row) }, organizationId: row.organizationId, assetType: 'dataset' }, select: { filename: true, storedFileId: true, sourceMetadata: true } })
  const datasets = []
  for (const doc of docs) {
    if (!doc.storedFileId) continue
    const kind = (doc.sourceMetadata as { roi?: { kind?: unknown } } | null)?.roi?.kind
    if (isRoiSourceKind(kind) && ACCOUNT360_KINDS.includes(kind)) continue
    const stored = await readStoredFile(doc.storedFileId, row.organizationId)
    if (stored) datasets.push({ name: datasetFrameName(doc.filename), filename: doc.filename, bytes: stored.buffer })
  }
  return runRoiPrep(datasets, { extraMetrics: view.extraMetrics, onlyActivity: true })
}

/**
 * Called by the executor when an ROI analysis run ends: bring the analysis
 * (and its artifact's first version) up to date without anyone opening a
 * page. The page reconciles too — this makes the notification land on a
 * report that already exists.
 */
export async function reconcileRoiAnalysisForExecution(organizationId: string, executionId: string): Promise<void> {
  const row = await prisma.roiAnalysis.findFirst({ where: { organizationId, executionId }, select: { id: true } })
  if (row) await loadRoiAnalysis(organizationId, row.id)
}

/** The build in progress (or the last one that failed) for an artifact still waiting on its dashboard. */
export async function roiBuildFor(organizationId: string, artifactId: string): Promise<{ analysisId: string; status: string; executionId: string | null; error: string | null; account: string } | null> {
  const row = await prisma.roiAnalysis.findFirst({ where: { organizationId, artifactId }, orderBy: { createdAt: 'desc' } })
  if (!row) return null
  const reconciled = isTerminalRunStatus(row.status) ? row : (await loadRoiAnalysis(organizationId, row.id)) ?? row
  return { analysisId: reconciled.id, status: reconciled.status, executionId: reconciled.executionId, error: reconciled.error, account: reconciled.account }
}

// ---------------------------------------------------------------- generic reports and personal pages

/**
 * An account's generic report: the shared starting point, built from the
 * account's data (the Iron Mountain dashboard for Iron Mountain). Builds and
 * data refreshes land on it as versions; everyone's own page starts from it.
 */
export type AccountReport = {
  artifactId: string
  account: string
  /** Its current version, and that version's state (null before its first version, or for a version from before state was kept). */
  currentVersionId: string | null
  state: RoiArtifactState['roi'] | null
  /**
   * An Account 360 page standing in for the report: the account's only
   * finished analysis. Its data draws the report's Account engagement tab
   * until a full build replaces it.
   */
  a360: { factsFileId: string; headline: string | null } | null
  /** Its data came from the ROI-page prep, so a settings change only rewrites the findings. */
  factsCurrent: boolean
  config: RoiRunConfig
  reason: string
  updatedAt: string
  /** A build updating it right now, if any (and who started it). */
  activeAnalysisId: string | null
  activeUserId: string | null
}

const sameAccount = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const isActive = (status: string) => !isTerminalRunStatus(status) && status !== 'failed'

/**
 * Every account's generic report — never anyone's own page. The newest
 * report with something to show wins: a version with its state, or one from
 * before state was kept (read through the build that made it). An account
 * with none falls back to its newest Account 360 page, then to its newest
 * report artifact (a first build still running).
 */
export async function listAccountReports(organizationId: string): Promise<AccountReport[]> {
  const [analyses, personal] = await Promise.all([
    prisma.roiAnalysis.findMany({
      where: { organizationId, artifactId: { not: null }, template: { in: ['standard', 'engagement', 'account360'] } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, account: true, artifactId: true, status: true, config: true, reason: true, timeframe: true, userId: true, template: true },
    }),
    personalPageIds(organizationId),
  ])
  const builds = analyses.filter((row) => !personal.has(row.artifactId!))
  const artifactIds = [...new Set(builds.map((row) => row.artifactId!))]
  const artifacts = artifactIds.length
    ? await prisma.artifact.findMany({ where: { id: { in: artifactIds }, organizationId, kind: { in: ['roi_dashboard', 'page'] }, archivedAt: null }, select: { id: true, currentVersionId: true, updatedAt: true, kind: true } })
    : []
  const live = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const versionIds = artifacts.map((artifact) => artifact.currentVersionId).filter((id): id is string => Boolean(id))
  const versions = versionIds.length ? await prisma.artifactVersion.findMany({ where: { id: { in: versionIds }, organizationId }, select: { id: true, state: true } }) : []
  const stateById = new Map(versions.map((version) => [version.id, version.state]))
  const reportState = async (artifactId: string) => {
    const artifact = live.get(artifactId)
    if (!artifact || artifact.kind !== 'roi_dashboard' || !artifact.currentVersionId) return null
    return readRoiState(stateById.get(artifact.currentVersionId)) ?? (await currentRoiState(organizationId, artifactId).catch(() => null))?.state ?? null
  }
  const a360Of = (artifactId: string) => {
    const artifact = live.get(artifactId)
    if (!artifact || artifact.kind !== 'page' || !artifact.currentVersionId) return null
    const roi = (stateById.get(artifact.currentVersionId) as { roi?: { template?: unknown; factsFileId?: unknown; headline?: unknown } } | null)?.roi
    return roi?.template === 'account360' && typeof roi.factsFileId === 'string' ? { factsFileId: roi.factsFileId, headline: typeof roi.headline === 'string' ? roi.headline : null } : null
  }
  const byAccount = new Map<string, typeof builds>()
  for (const row of builds) {
    if (!live.has(row.artifactId!)) continue
    const key = row.account.trim().toLowerCase()
    byAccount.set(key, [...(byAccount.get(key) ?? []), row])
  }
  const reports: AccountReport[] = []
  for (const rows of byAccount.values()) {
    const standard = rows.filter((row) => row.template !== 'account360')
    const candidates = [...new Set(standard.map((row) => row.artifactId!))]
    let chosen: string | null = null
    let state: RoiArtifactState['roi'] | null = null
    let a360: AccountReport['a360'] = null
    for (const id of candidates) {
      const found = await reportState(id)
      if (found) { chosen = id; state = found; break }
    }
    if (!chosen) {
      const page = rows.find((row) => row.template === 'account360' && a360Of(row.artifactId!))
      if (page) { chosen = page.artifactId!; a360 = a360Of(chosen) } else chosen = candidates[0] ?? null
    }
    if (!chosen) continue
    const artifact = live.get(chosen)!
    const latest = rows.find((row) => row.artifactId === chosen)!
    const active = standard.find((row) => isActive(row.status))
    const config = state?.config ?? (latest.config && Object.keys(latest.config as object).length ? readRunConfig(latest.config) : configFromPreset(state?.timeframePreset ?? (latest.timeframe as { preset?: string } | null)?.preset))
    reports.push({
      artifactId: chosen,
      account: latest.account,
      currentVersionId: artifact.currentVersionId,
      state,
      a360,
      factsCurrent: state ? factsAreCurrent(state) : false,
      config,
      reason: state?.reason ?? latest.reason ?? '',
      updatedAt: artifact.updatedAt.toISOString(),
      activeAnalysisId: active?.id ?? null,
      activeUserId: active?.userId ?? null,
    })
  }
  return reports
}

export async function findAccountReport(organizationId: string, account: string): Promise<AccountReport | null> {
  return (await listAccountReports(organizationId)).find((report) => sameAccount(report.account, account)) ?? null
}

/** This person's run updating an account right now (a change to their page, or a build they started). */
async function activeRunFor(organizationId: string, userId: string, account: string): Promise<string | null> {
  const rows = await prisma.roiAnalysis.findMany({
    where: { organizationId, userId, status: { in: ['pending', 'fetching', 'running', 'building'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, account: true },
  })
  return rows.find((row) => sameAccount(row.account, account))?.id ?? null
}

/** Open an account on this person's page (see openAccountOnPage). */
export async function openRoiAccount(params: { organizationId: string; userId: string; account: string; update?: boolean }): Promise<OpenResult> {
  return openAccountOnPage({
    ...params,
    findGeneric: async (account) => {
      const report = await findAccountReport(params.organizationId, account)
      // Only a version with its state can be re-drawn on someone's page.
      return report ? { artifactId: report.artifactId, account: report.account, hasVersion: Boolean(report.state || report.a360) } : null
    },
  })
}

/**
 * Apply settings for an account — the ROI page's one action, always about
 * this person's own page. When their page holds the account on complete data
 * (the ROI prep's, or a value readout's), or on data nothing could compute
 * afresh, only the findings are rewritten for the new settings (about a
 * minute), as the next version of their page. Otherwise — or when they ask
 * for fresh data — the account's report is built (or rebuilt) from its data,
 * and the result lands on their page as well.
 */
export async function requestRoiReport(params: {
  organizationId: string
  userId: string
  account: string
  config: RoiRunConfig
  reason: string
  context?: string
  /** Recompute the data (new extracts, or the data flow) instead of only rewriting. */
  refresh?: boolean
}): Promise<RoiAnalysis> {
  const mine = await activeRunFor(params.organizationId, params.userId, params.account)
  if (mine) throw new RoiBusyError(`Your ${params.account} page is being updated already. Its next version lands in a minute or two; change the settings again after that.`)
  let page = await loadPersonalPage(params.organizationId, params.userId)
  let current = page?.accounts[params.account.trim().toLowerCase()]
  if (current?.source === 'live') {
    // Drawn live before the account had a report: it takes the report first, when there is one now.
    const opened = await openRoiAccount({ organizationId: params.organizationId, userId: params.userId, account: current.account })
    if (opened.status === 'ready' && opened.versionId !== current.versionId) {
      page = await loadPersonalPage(params.organizationId, params.userId)
      current = page?.accounts[params.account.trim().toLowerCase()]
    }
  }
  // A page drawn from live data alone has no findings data to rewrite.
  if (page && current && current.source !== 'live' && !params.refresh
    && (current.factsCurrent || !(await canComputeRoiData(params.organizationId, current.account, roiDataFlowIdOf(await findRoiAgent(params.organizationId)))))) {
    const version = await prisma.artifactVersion.findFirst({ where: { id: current.versionId, artifactId: page.artifactId, organizationId: params.organizationId }, select: { state: true } })
    const state = readRoiState(version?.state)
    if (state) return startRoiReconfigure({ ...params, account: current.account, pageArtifactId: page.artifactId, state })
  }
  const report = await findAccountReport(params.organizationId, params.account)
  if (report?.activeAnalysisId) throw new RoiBusyError(`The ${report.account} report is being rebuilt already. It lands on everyone's starting point in a few minutes; your page takes it when it is in.`)
  return createRoiAnalysis({
    organizationId: params.organizationId,
    userId: params.userId,
    account: report?.account ?? current?.account ?? params.account,
    config: params.config,
    reason: params.reason,
    context: params.context,
    view: report?.state?.view,
    template: 'standard',
    // An Account 360 page is not a report artifact: a build makes the account's first one.
    artifactId: report && !report.a360 ? report.artifactId : null,
    markers: { populatePage: true },
  })
}

export function buildReconfigurePrompt(params: { account: string; config: RoiRunConfig; reason: string; context: string; summary: unknown; a360Summary: unknown; previous: RoiNarrative | null }): string {
  return [
    `Rewrite the ROI analysis findings for the account "${params.account}" for new settings. The data is already computed — do NOT call prepare_roi_facts or prepare_account360; every number you may cite is in the summaries below.`,
    '',
    `WHY IT WAS RUN: ${params.reason.trim() || 'not stated'}. Shape the emphasis to it; never change a number because of it.`,
    '',
    `CONFIGURATION: ${describeRunConfig(params.config).join('. ')}. The summary's \`configured\` block holds these windows' averages and percent changes — cite those for every observation-vs-baseline claim.`,
    '',
    params.context.trim() ? `ADDITIONAL CONTEXT FROM THE REQUESTER:\n${params.context.trim()}\n` : '',
    'FACTS SUMMARY (JSON):',
    JSON.stringify(params.summary),
    '',
    params.a360Summary ? `ACCOUNT 360 SUMMARY (JSON):\n${JSON.stringify(params.a360Summary)}\n` : '',
    params.previous ? `THE CURRENT FINDINGS (for continuity — keep what still holds under the new settings, rewrite what does not):\n${JSON.stringify({ headline: params.previous.headline, findings: params.previous.findings, watch: params.previous.watch, context: params.previous.context })}\n` : '',
    'If Backstory tools are available, refresh the `context` block for the account (see your instructions); otherwise keep the current one if it still holds.',
    '',
    'OUTPUT',
    ROI_OUTPUT_CONTRACT,
  ].join('\n')
}

/** A settings change on this person's page: the analyst rewrites the findings on the page's data — the next version of their page. */
async function startRoiReconfigure(params: {
  organizationId: string
  userId: string
  account: string
  config: RoiRunConfig
  reason: string
  context?: string
  pageArtifactId: string
  state: RoiArtifactState['roi']
}): Promise<RoiAnalysis> {
  const { state } = params
  const agent = await ensureRoiAgent(params.organizationId, params.userId)
  const row = await prisma.roiAnalysis.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      agentTaskId: agent.id,
      artifactId: params.pageArtifactId,
      account: params.account,
      template: 'standard',
      timeframe: jsonValue({ preset: presetFor(params.config) }),
      config: jsonValue(params.config),
      reason: params.reason.trim().slice(0, ROI_REASON_MAX_CHARS),
      context: (params.context ?? '').trim().slice(0, ROI_CONTEXT_MAX_CHARS),
      datasetIds: jsonValue(state.datasetIds),
      view: jsonValue(state.view),
      results: jsonValue({ reconfigure: { factsFileId: state.factsFileId, a360FactsFileId: state.a360FactsFileId ?? null, ...(state.source === 'readout' ? { source: 'readout' } : {}) }, personal: true, ...(state.basedOn ? { basedOn: state.basedOn } : {}) }),
      status: 'pending',
    },
  })
  try {
    const facts = await readFacts(params.organizationId, state.factsFileId)
    if (!facts) throw new Error('The page\'s computed data could not be read. Refresh the data to rebuild it.')
    const a360 = await readAccount360Facts(params.organizationId, state.a360FactsFileId)
    const input = buildReconfigurePrompt({
      account: params.account,
      config: params.config,
      reason: row.reason,
      context: row.context,
      summary: summarizeFacts(facts, params.config),
      a360Summary: a360 ? summarizeAccount360(a360) : null,
      previous: state.narrative,
    })
    const executionId = await startRun({
      organizationId: params.organizationId,
      userId: params.userId,
      agentId: agent.id,
      agentType: agent.agentType,
      title: `ROI analysis · ${params.account} · new settings`,
      input,
      trigger: { type: 'roi_analysis', analysisId: row.id, link: roiPageLink(params.account) },
    })
    return await prisma.roiAnalysis.update({ where: { id: row.id, organizationId: params.organizationId }, data: { executionId, status: 'running' } })
  } catch (error) {
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: params.organizationId },
      data: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
    })
  }
}
