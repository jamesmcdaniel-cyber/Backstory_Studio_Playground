import { Prisma, type RoiAnalysis } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { unwrapHtmlFence } from '@/lib/roi/text'
import { readStoredFile } from '@/lib/files/storage'
import { addVersion, createArtifact } from '@/lib/artifacts/service'
import { ensureRoiAgent, roiDataFlowIdOf } from './agent'
import { extractRoiNarrative, ROI_OUTPUT_CONTRACT, type RoiNarrative } from './contract'
import { renderRoiDashboard } from './dashboard'
import { runRoiPrep, type RoiFacts } from './prep'
import { readView, type RoiView } from './view'
import { stateJson, storeFacts } from './artifact-state'
import { summarizeFacts, type RoiFactsSummary } from './facts'
import { timeframeInstruction, timeframeLabel, type RoiTimeframe } from './timeframe'
import { ROI_SOURCE_LABEL, ROI_TEMPLATES, isRoiSourceKind, type RoiSourceKind, type RoiTemplate } from './sources'
import { renderAccount360Dashboard } from './account360/dashboard'
import type { Account360Facts } from './account360/prep'
import { summarizeAccount360 } from './account360/facts'
import { configFromPreset, describeRunConfig, presetFor, readRunConfig, type RoiRunConfig } from './config'
import { fetchRoiData, loadedExtracts, RoiDataUnavailableError } from './data-source'
import { runKpis } from './kpis'
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

/** What the page tells people to expect, in seconds. */
export const ROI_EXPECTED_SECONDS = 90
export const ROI_ASYNC_AFTER_SECONDS = 180

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
    a360.length ? `2. Call prepare_account360 ONCE with documentIds ${ids(a360)} (pass excludeUsers for any users the requester asked to leave out).` : '2. No Account 360 extracts are loaded: skip prepare_account360; the Account engagement tab shows deal engagement per account only.',
    '3. If Backstory tools are available, look the customer account up for the `context` block (see your instructions); otherwise leave it out.',
    '4. Return the narrative contract below. Findings may point at the activity, adoption, deals or accounts tab.',
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
  kpis?: RoiRunKpi[]
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

function titleFor(template: RoiTemplate, account: string): string {
  const month = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  return template === 'account360' ? `Account 360 ROI · ${account}` : `ROI analysis · ${account} · ${month}`
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
      status: 'pending',
    },
  })
  // The artifact is where the report lives, so it exists from the start (no
  // versions yet) and its page follows the run. The first version lands on it
  // when the run finishes.
  const artifact = await prisma.artifact.create({
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
      data: { status: 'fetching', results: jsonValue({ dataFlowRunId: data.flowRunId }) },
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
    trigger: { type: 'roi_analysis', analysisId: row.id, ...(row.artifactId ? { link: `/artifacts/${row.artifactId}` } : {}) },
  })
  return prisma.roiAnalysis.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: { executionId, status: 'running', datasetIds: jsonValue(datasets.map((dataset) => dataset.documentId)), results: Prisma.DbNull },
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
  if (row.status === 'pending' || !row.executionId) return 'queued'
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

async function reconcileRun(row: RoiAnalysis): Promise<RoiAnalysis> {
  if (!row.executionId || isTerminalRunStatus(row.status)) return row
  const run = await finalMessage(row.executionId, row.organizationId)
  if (!run) return row
  if (!isTerminalRunStatus(run.status)) {
    return run.status !== row.status
      ? prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { status: run.status } })
      : row
  }
  if (run.status !== 'completed') {
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: row.organizationId },
      data: { status: run.status, error: run.error ?? (run.status === 'blocked' ? 'The run was blocked before it could finish.' : 'The run did not complete.') },
    })
  }
  if (row.template === 'account360') return completeAccount360(row, run.text)
  const fail = (error: string) => prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { status: 'failed', error } })
  const extracted = extractRoiNarrative(run.text)
  if (extracted.error !== undefined) return fail(`${extracted.error} Open the run for the agent's full output.`)
  let factsFileId = await factsFileIdFor(row.executionId)
  const a360FactsFileId = row.template === 'standard' ? await factsFileIdFor(row.executionId, 'prepare_account360') : null
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
  const reportHtml = renderRoiDashboard(facts, extracted.data, { account: row.account, generatedAt, view, config, reason: row.reason, a360 })
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
  })
  const artifactId = row.artifactId
    ? await addVersion({ artifactId: row.artifactId, organizationId: row.organizationId, content: reportHtml, executionId: row.executionId, request: 'Built from the extracts', createdByUserId: row.userId, state: roiState })
      .then(() => row.artifactId!)
      .catch(() => undefined)
    : await createArtifact({
      organizationId: row.organizationId,
      userId: row.userId,
      kind: 'roi_dashboard',
      title: titleFor('standard', row.account),
      content: reportHtml,
      agentTaskId: row.agentTaskId,
      executionId: row.executionId,
      state: roiState,
    }).then(({ artifact }) => artifact.id).catch(() => undefined)
  const results: RoiResults = {
    narrative: extracted.data,
    summary: summarizeFacts(facts, config),
    factsFileId: factsFileId!,
    ...(a360FactsFileId && a360 ? { a360FactsFileId } : {}),
    ...(artifactId ? { artifactId } : {}),
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

/** Phase without querying the run's steps — for lists; the page polls in-flight runs for the precise one. */
function quickPhase(row: RoiAnalysis): RoiRunPhase {
  if (row.status === 'completed') return 'ready'
  if (row.status === 'failed' || isTerminalRunStatus(row.status)) return 'failed'
  if (row.status === 'fetching') return 'fetching'
  if (row.status === 'pending' || !row.executionId) return 'queued'
  return 'computing'
}

export function serializeRoiAnalysis(row: RoiAnalysis & { datasets?: RoiDataset[]; phase?: RoiRunPhase }, requestedBy: string | null = null): RoiAnalysisView {
  const config = row.config && typeof row.config === 'object' && Object.keys(row.config as object).length
    ? readRunConfig(row.config)
    : configFromPreset((row.timeframe as { preset?: string } | null)?.preset)
  const results = row.results as (RoiResults | Account360Results | { dataFlowRunId?: string }) | null
  const kpis = results && 'kpis' in results && Array.isArray(results.kpis) ? results.kpis : []
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
    results: results && 'dataFlowRunId' in results ? null : results,
    kpis,
    chat: chatOf(row),
    datasets: row.datasets ?? [],
    requestedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.status === 'completed' ? row.updatedAt.toISOString() : null,
  }
}

/** The workspace's analyses for the page's history, newest first, with who ran each. */
export async function listRoiAnalyses(organizationId: string, take = 200): Promise<RoiAnalysisView[]> {
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
  const userIds = [...new Set(rows.map((row) => row.userId))]
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, organizationId }, select: { id: true, name: true, email: true } }) : []
  const nameOf = new Map(users.map((user) => [user.id, user.name?.trim() || user.email || null]))
  return rows.map((row) => serializeRoiAnalysis({ ...row, reportHtml: null }, nameOf.get(row.userId) ?? null))
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
