import type { Prisma, RoiAnalysis } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { unwrapHtmlFence } from '@/lib/roi/text'
import { readStoredFile } from '@/lib/files/storage'
import { addVersion, createArtifact } from '@/lib/artifacts/service'
import { ensureRoiAgent } from './agent'
import { extractRoiNarrative, type RoiNarrative } from './contract'
import { renderRoiDashboard } from './dashboard'
import { runRoiPrep, type RoiFacts } from './prep'
import { readView, type RoiView } from './view'
import { stateJson, storeFacts } from './artifact-state'
import { datasetFrameName as frameName } from '@/lib/code-analysis/frame-name'
import { summarizeFacts, type RoiFactsSummary } from './facts'
import { timeframeInstruction, timeframeLabel, type RoiTimeframe } from './timeframe'
import { resolveRoiDatasetIds, ROI_TEMPLATES, type RoiTemplate } from './sources'
import { renderAccount360Dashboard } from './account360/dashboard'
import type { Account360Facts } from './account360/prep'
import { summarizeAccount360 } from './account360/facts'

/**
 * ROI analyses: the service behind /roi.
 *
 * An analysis is a request row plus an agent run. Creating one provisions
 * the ROI Analyst if the workspace has none, writes the row, creates the
 * execution with the row's id on its trigger (so completion can deep-link
 * back here), and dispatches it to the worker. Reading one reconciles the
 * row with the run: when the run has finished and the row has no report
 * yet, the agent's final message is parsed against the contract and the
 * dashboard rendered — once, then stored.
 *
 * Follow-up questions are runs too (short ones): the answer arrives the
 * same way, is reconciled the same way, and shows up in the Runs panel like
 * everything else the agent does.
 */

import type { RoiAnalysisView, RoiChatMessage, RoiDataset } from './types'
export type { RoiAnalysisView, RoiChatMessage, RoiDataset } from './types'

export const ROI_MAX_DATASETS = 4
export const ROI_CONTEXT_MAX_CHARS = 4_000
export const ROI_QUESTION_MAX_CHARS = 2_000

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

function chatOf(row: RoiAnalysis): RoiChatMessage[] {
  return Array.isArray(row.chat) ? (row.chat as RoiChatMessage[]) : []
}

function datasetIdsOf(row: RoiAnalysis): string[] {
  return Array.isArray(row.datasetIds) ? (row.datasetIds as unknown[]).filter((id): id is string => typeof id === 'string') : []
}

async function loadDatasets(organizationId: string, ids: string[]): Promise<RoiDataset[]> {
  if (!ids.length) return []
  const docs = await prisma.knowledgeDocument.findMany({
    where: { id: { in: ids }, organizationId, assetType: 'dataset', isEnabled: true, status: 'ready' },
    select: { id: true, filename: true, sourceMetadata: true },
  })
  return ids
    .map((id) => docs.find((doc) => doc.id === id))
    .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc))
    .map((doc) => ({
      documentId: doc.id,
      filename: doc.filename,
      frame: datasetFrameName(doc.filename),
      rows: (doc.sourceMetadata as { dataset?: { rowCount?: number } } | null)?.dataset?.rowCount ?? null,
    }))
}

function datasetsBlock(datasets: RoiDataset[]): string {
  return datasets.map((dataset) => `- ${dataset.filename} → documentId ${dataset.documentId}, frame "${dataset.frame}"${dataset.rows ? `, ${dataset.rows.toLocaleString()} rows` : ''}`).join('\n')
}

export function buildAnalysisPrompt(params: { account: string; timeframe: RoiTimeframe; context: string; datasets: RoiDataset[] }): string {
  return [
    `Build the ROI story for the account "${params.account}".`,
    '',
    `TIME FRAME: ${timeframeLabel(params.timeframe)}. ${timeframeInstruction(params.timeframe)}`,
    '',
    'DATASETS (repository documents — load with run_code documentIds):',
    datasetsBlock(params.datasets),
    '',
    params.context.trim() ? `ADDITIONAL CONTEXT FROM THE REQUESTER:\n${params.context.trim()}\n` : '',
    'Run every analysis whose dataset is listed, then return the JSON contract.',
  ].filter((line) => line !== undefined).join('\n')
}

export function buildAccount360Prompt(params: { account: string; context: string; datasets: RoiDataset[] }): string {
  return [
    `Build the Account 360 ROI analysis for the account "${params.account}".`,
    '',
    'DATASETS (repository documents — pass every documentId to prepare_account360):',
    datasetsBlock(params.datasets),
    '',
    params.context.trim() ? `ADDITIONAL CONTEXT FROM THE REQUESTER:\n${params.context.trim()}\n` : '',
    'Call prepare_account360 once, then answer with the headline only.',
  ].join('\n')
}

export type RoiResults = { narrative: RoiNarrative; summary: RoiFactsSummary; factsFileId: string; artifactId?: string }
export type Account360Results = { template: 'account360'; headline: string; summary: ReturnType<typeof summarizeAccount360>; factsFileId: string; artifactId?: string }

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

export async function createRoiAnalysis(params: {
  organizationId: string
  userId: string
  account: string
  timeframe: RoiTimeframe
  context: string
  datasetIds?: string[]
  /** The view to render with — carried over when a dashboard is rebuilt for another account. */
  view?: RoiView
  /** Which analysis to build. Defaults to the rep engagement dashboard. */
  template?: RoiTemplate
}): Promise<RoiAnalysis> {
  const template: RoiTemplate = params.template ?? 'engagement'
  // The account's extracts live in the repository, tagged by account; an
  // explicit list (the API's older shape) still wins when one is given.
  const ids = params.datasetIds?.length ? params.datasetIds : await resolveRoiDatasetIds(params.organizationId, params.account, template)
  const datasets = await loadDatasets(params.organizationId, ids.slice(0, ROI_MAX_DATASETS))
  if (!datasets.length) throw new Error(`No ${ROI_TEMPLATES[template].label} extracts are loaded for "${params.account.trim()}" yet. An operator loads them into the repository.`)
  const agent = await ensureRoiAgent(params.organizationId, params.userId)
  const row = await prisma.roiAnalysis.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      agentTaskId: agent.id,
      account: params.account.trim().slice(0, 200),
      template,
      timeframe: jsonValue(params.timeframe),
      context: params.context.trim().slice(0, ROI_CONTEXT_MAX_CHARS),
      datasetIds: jsonValue(datasets.map((dataset) => dataset.documentId)),
      ...(params.view ? { view: jsonValue(params.view) } : {}),
      status: 'pending',
    },
  })
  // The artifact is the only ROI surface, so it exists from the start (no
  // versions yet) and its page follows the run. The first version lands on
  // it when the run finishes.
  // An Account 360 dashboard is an interactive page like any uploaded one:
  // the assistant edits it directly, and rebuilds it from its extracts.
  const title = template === 'account360' ? `Account 360 ROI · ${row.account}` : `ROI analysis · ${row.account}`
  const artifact = await prisma.artifact.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      kind: template === 'account360' ? 'page' : 'roi_dashboard',
      title,
      agentTaskId: agent.id,
    },
  })
  await prisma.roiAnalysis.update({ where: { id: row.id, organizationId: params.organizationId }, data: { artifactId: artifact.id } })
  const input = template === 'account360'
    ? buildAccount360Prompt({ account: row.account, context: row.context, datasets })
    : buildAnalysisPrompt({ account: row.account, timeframe: params.timeframe, context: row.context, datasets })
  try {
    const executionId = await startRun({
      organizationId: params.organizationId,
      userId: params.userId,
      agentId: agent.id,
      agentType: agent.agentType,
      title,
      input,
      trigger: { type: 'roi_analysis', analysisId: row.id, link: `/artifacts/${artifact.id}` },
    })
    return prisma.roiAnalysis.update({ where: { id: row.id, organizationId: params.organizationId }, data: { executionId, status: 'running' } })
  } catch (error) {
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: params.organizationId },
      data: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
    })
  }
}

/** The analysis with its run reconciled: status brought up to date, the
 *  report rendered once the run finished, pending chat answers filled in. */
export async function loadRoiAnalysis(organizationId: string, id: string): Promise<(RoiAnalysis & { datasets: RoiDataset[] }) | null> {
  let row = await prisma.roiAnalysis.findFirst({ where: { id, organizationId } })
  if (!row) return null
  row = await reconcileRun(row)
  row = await reconcileChat(row)
  const datasets = await loadDatasets(organizationId, datasetIdsOf(row))
  return { ...row, datasets }
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
  const extracted = extractRoiNarrative(run.text)
  if (extracted.error !== undefined) {
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: row.organizationId },
      data: { status: 'failed', error: `${extracted.error} Open the run for the agent's full output.` },
    })
  }
  const foundFactsFileId = await factsFileIdFor(row.executionId)
  const stored = foundFactsFileId ? await readStoredFile(foundFactsFileId, row.organizationId) : null
  if (!foundFactsFileId || !stored) {
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: row.organizationId },
      data: { status: 'failed', error: 'The run finished without computing the facts (prepare_roi_facts did not store a result). Open the run to see what happened.' },
    })
  }
  let factsFileId: string = foundFactsFileId
  let facts: RoiFacts
  try {
    facts = JSON.parse(stored.buffer.toString('utf8')) as RoiFacts
  } catch {
    return prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { status: 'failed', error: 'The stored facts could not be read.' } })
  }
  const generatedAt = new Date().toISOString()
  const timeframe = row.timeframe as RoiTimeframe | null
  // A view carried over from another dashboard may add metrics this run's
  // prep did not compute; recompute once with them so the page shows them.
  const view = readView(row.view)
  if (view.extraMetrics.length && facts.U && view.extraMetrics.some((metric) => !(metric.key in facts.U!.labels))) {
    facts = await recomputeWithMetrics(row, view).catch(() => facts)
    factsFileId = await storeFacts(row.organizationId, row.userId, facts).catch(() => factsFileId)
  }
  const reportHtml = renderRoiDashboard(facts, extracted.data, { account: row.account, generatedAt, timeframePreset: timeframe?.preset, view })
  // The dashboard is an artifact like any other report: it gets a home on
  // /artifacts with versions and a conversation, alongside the ROI page.
  const roiState = stateJson({
      analysisId: row.id,
      account: row.account,
      timeframePreset: timeframe?.preset ?? 'last6_vs_prior6',
      factsFileId,
      datasetIds: datasetIdsOf(row),
      narrative: extracted.data,
      view,
    })
  const artifactId = row.artifactId
    ? await addVersion({ artifactId: row.artifactId, organizationId: row.organizationId, content: reportHtml, executionId: row.executionId, request: 'Built from the extracts', createdByUserId: row.userId, state: roiState })
      .then(() => row.artifactId!)
      .catch(() => undefined)
    : await createArtifact({
    organizationId: row.organizationId,
    userId: row.userId,
    kind: 'roi_dashboard',
    title: `ROI analysis · ${row.account}`,
    content: reportHtml,
    agentTaskId: row.agentTaskId,
    executionId: row.executionId,
    state: stateJson({
      analysisId: row.id,
      account: row.account,
      timeframePreset: timeframe?.preset ?? 'last6_vs_prior6',
      factsFileId,
      datasetIds: datasetIdsOf(row),
      narrative: extracted.data,
      view,
    }),
  }).then(({ artifact }) => artifact.id).catch(() => undefined)
  const results: RoiResults = { narrative: extracted.data, summary: summarizeFacts(facts), factsFileId, ...(artifactId ? { artifactId } : {}) }
  return prisma.roiAnalysis.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: { status: 'completed', error: null, results: jsonValue(results), reportHtml },
  })
}

/** A finished Account 360 run: render the page from its stored result, headed by the agent's line. */
async function completeAccount360(row: RoiAnalysis, text: string): Promise<RoiAnalysis> {
  const fail = (error: string) => prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { status: 'failed', error } })
  const factsFileId = row.executionId ? await factsFileIdFor(row.executionId, 'prepare_account360') : null
  const stored = factsFileId ? await readStoredFile(factsFileId, row.organizationId) : null
  if (!factsFileId || !stored) return fail('The run finished without computing the analysis (prepare_account360 did not store a result). Open the run to see what happened.')
  let facts: Account360Facts
  try {
    facts = JSON.parse(stored.buffer.toString('utf8')) as Account360Facts
  } catch {
    return fail('The stored analysis could not be read.')
  }
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
  const results: Account360Results = { template: 'account360', headline: lede, summary: summarizeAccount360(facts), factsFileId, ...(artifactId ? { artifactId } : {}) }
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

export function serializeRoiAnalysis(row: RoiAnalysis & { datasets?: RoiDataset[] }): RoiAnalysisView {
  return {
    id: row.id,
    account: row.account,
    template: row.template,
    timeframe: row.timeframe as RoiTimeframe,
    timeframeLabel: timeframeLabel(row.timeframe as RoiTimeframe),
    context: row.context,
    status: row.status,
    error: row.error,
    executionId: row.executionId,
    agentTaskId: row.agentTaskId,
    artifactId: row.artifactId,
    hasReport: Boolean(row.reportHtml),
    results: (row.results as RoiResults | null) ?? null,
    chat: chatOf(row),
    datasets: row.datasets ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}


/** Recompute an analysis's facts with added metrics (a carried-over view). */
async function recomputeWithMetrics(row: RoiAnalysis, view: RoiView): Promise<RoiFacts> {
  const docs = await prisma.knowledgeDocument.findMany({ where: { id: { in: datasetIdsOf(row) }, organizationId: row.organizationId, assetType: 'dataset' }, select: { filename: true, storedFileId: true } })
  const datasets = []
  for (const doc of docs) {
    if (!doc.storedFileId) continue
    const stored = await readStoredFile(doc.storedFileId, row.organizationId)
    if (stored) datasets.push({ name: frameName(doc.filename), filename: doc.filename, bytes: stored.buffer })
  }
  return runRoiPrep(datasets, { extraMetrics: view.extraMetrics })
}

/**
 * Called by the executor when an ROI analysis run ends: bring the analysis
 * (and its artifact's first version) up to date without anyone opening a
 * page. The page reconciles too — this makes the notification land on a
 * dashboard that already exists.
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
