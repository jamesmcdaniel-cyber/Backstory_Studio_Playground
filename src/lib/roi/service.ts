import type { Prisma, RoiAnalysis } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { unwrapHtmlFence } from '@/lib/roi/text'
import { readStoredFile } from '@/lib/files/storage'
import { createArtifact } from '@/lib/artifacts/service'
import { ensureRoiAgent } from './agent'
import { extractRoiNarrative, type RoiNarrative } from './contract'
import { renderRoiDashboard } from './dashboard'
import type { RoiFacts } from './prep'
import { summarizeFacts, type RoiFactsSummary } from './facts'
import { timeframeInstruction, timeframeLabel, type RoiTimeframe } from './timeframe'
import { resolveRoiDatasetIds } from './sources'

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

export type RoiResults = { narrative: RoiNarrative; summary: RoiFactsSummary; factsFileId: string; artifactId?: string }

export function buildFollowUpPrompt(params: { account: string; question: string; results: RoiResults | null; chat: RoiChatMessage[]; datasets: RoiDataset[] }): string {
  const history = params.chat
    .filter((message) => message.content && message.status !== 'pending')
    .slice(-8)
    .map((message) => `${message.role === 'user' ? 'User' : 'You'}: ${message.content.slice(0, 1_500)}`)
    .join('\n\n')
  const summary = params.results ? JSON.stringify(params.results.summary).slice(0, 60_000) : 'The analysis produced no facts summary.'
  const narrative = params.results ? JSON.stringify(params.results.narrative).slice(0, 12_000) : ''
  return [
    `FOLLOW-UP on the finished ROI analysis for "${params.account}". Answer the question below in Markdown; use run_code over the same datasets when the answer needs a number the facts summary does not already hold. Do not call prepare_roi_facts again.`,
    '',
    'DATASETS:',
    datasetsBlock(params.datasets),
    '',
    'FACTS SUMMARY (computed by prepare_roi_facts):',
    summary,
    '',
    'THE NARRATIVE ON THE DASHBOARD:',
    narrative,
    history ? `\nCONVERSATION SO FAR:\n${history}` : '',
    '',
    `QUESTION: ${params.question.trim()}`,
  ].join('\n')
}

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
}): Promise<RoiAnalysis> {
  // The account's extracts live in the repository, tagged by account; an
  // explicit list (the API's older shape) still wins when one is given.
  const ids = params.datasetIds?.length ? params.datasetIds : await resolveRoiDatasetIds(params.organizationId, params.account)
  const datasets = await loadDatasets(params.organizationId, ids.slice(0, ROI_MAX_DATASETS))
  if (!datasets.length) throw new Error(`No extracts are loaded for "${params.account.trim()}" yet. An operator loads them into the repository.`)
  const agent = await ensureRoiAgent(params.organizationId, params.userId)
  const row = await prisma.roiAnalysis.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      agentTaskId: agent.id,
      account: params.account.trim().slice(0, 200),
      timeframe: jsonValue(params.timeframe),
      context: params.context.trim().slice(0, ROI_CONTEXT_MAX_CHARS),
      datasetIds: jsonValue(datasets.map((dataset) => dataset.documentId)),
      status: 'pending',
    },
  })
  const input = buildAnalysisPrompt({ account: row.account, timeframe: params.timeframe, context: row.context, datasets })
  try {
    const executionId = await startRun({
      organizationId: params.organizationId,
      userId: params.userId,
      agentId: agent.id,
      agentType: agent.agentType,
      title: `ROI analysis · ${row.account}`,
      input,
      trigger: { type: 'roi_analysis', analysisId: row.id, link: `/roi/${row.id}` },
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

/** The facts file the run's prepare_roi_facts call stored — the newest, if it ran more than once. */
async function factsFileIdFor(executionId: string): Promise<string | null> {
  const steps = await prisma.workflowStep.findMany({
    where: { executionId, node: { contains: 'prepare_roi_facts' } },
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
  const extracted = extractRoiNarrative(run.text)
  if (extracted.error !== undefined) {
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: row.organizationId },
      data: { status: 'failed', error: `${extracted.error} Open the run for the agent's full output.` },
    })
  }
  const factsFileId = await factsFileIdFor(row.executionId)
  const stored = factsFileId ? await readStoredFile(factsFileId, row.organizationId) : null
  if (!factsFileId || !stored) {
    return prisma.roiAnalysis.update({
      where: { id: row.id, organizationId: row.organizationId },
      data: { status: 'failed', error: 'The run finished without computing the facts (prepare_roi_facts did not store a result). Open the run to see what happened.' },
    })
  }
  let facts: RoiFacts
  try {
    facts = JSON.parse(stored.buffer.toString('utf8')) as RoiFacts
  } catch {
    return prisma.roiAnalysis.update({ where: { id: row.id, organizationId: row.organizationId }, data: { status: 'failed', error: 'The stored facts could not be read.' } })
  }
  const generatedAt = new Date().toISOString()
  const timeframe = row.timeframe as RoiTimeframe | null
  const reportHtml = renderRoiDashboard(facts, extracted.data, { account: row.account, generatedAt, timeframePreset: timeframe?.preset })
  // The dashboard is an artifact like any other report: it gets a home on
  // /artifacts with versions and a conversation, alongside the ROI page.
  const artifactId = await createArtifact({
    organizationId: row.organizationId,
    userId: row.userId,
    kind: 'roi_dashboard',
    title: `ROI analysis · ${row.account}`,
    content: reportHtml,
    agentTaskId: row.agentTaskId,
    executionId: row.executionId,
  }).then(({ artifact }) => artifact.id).catch(() => undefined)
  const results: RoiResults = { narrative: extracted.data, summary: summarizeFacts(facts), factsFileId, ...(artifactId ? { artifactId } : {}) }
  return prisma.roiAnalysis.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: { status: 'completed', error: null, results: jsonValue(results), reportHtml },
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

export async function askRoiQuestion(params: { organizationId: string; userId: string; id: string; question: string }): Promise<RoiAnalysis> {
  const row = await prisma.roiAnalysis.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
  if (!row) throw new Error('Analysis not found.')
  if (row.status !== 'completed' || !row.agentTaskId) throw new Error('Ask once the analysis has finished.')
  const question = params.question.trim().slice(0, ROI_QUESTION_MAX_CHARS)
  if (!question) throw new Error('Type a question first.')
  const chat = chatOf(row)
  if (chat.some((message) => message.status === 'pending')) throw new Error('Wait for the current answer before asking another question.')
  const agent = await prisma.agentTask.findFirst({ where: { id: row.agentTaskId, organizationId: params.organizationId, status: 'ACTIVE' } })
  if (!agent) throw new Error('The ROI Analyst agent is no longer available.')
  const datasets = await loadDatasets(params.organizationId, datasetIdsOf(row))
  const input = buildFollowUpPrompt({
    account: row.account,
    question,
    results: (row.results as RoiResults | null) ?? null,
    chat,
    datasets,
  })
  const now = new Date().toISOString()
  const executionId = await startRun({
    organizationId: params.organizationId,
    userId: params.userId,
    agentId: agent.id,
    agentType: agent.agentType,
    title: `ROI follow-up · ${row.account}`,
    input,
    trigger: { type: 'roi_followup', analysisId: row.id, link: `/roi/${row.id}` },
  })
  const nextChat: RoiChatMessage[] = [
    ...chat,
    { role: 'user', content: question, createdAt: now },
    { role: 'agent', content: '', executionId, status: 'pending', createdAt: now },
  ]
  return prisma.roiAnalysis.update({ where: { id: row.id, organizationId: params.organizationId }, data: { chat: jsonValue(nextChat) } })
}

export function serializeRoiAnalysis(row: RoiAnalysis & { datasets?: RoiDataset[] }): RoiAnalysisView {
  return {
    id: row.id,
    account: row.account,
    timeframe: row.timeframe as RoiTimeframe,
    timeframeLabel: timeframeLabel(row.timeframe as RoiTimeframe),
    context: row.context,
    status: row.status,
    error: row.error,
    executionId: row.executionId,
    agentTaskId: row.agentTaskId,
    hasReport: Boolean(row.reportHtml),
    results: (row.results as RoiResults | null) ?? null,
    chat: chatOf(row),
    datasets: row.datasets ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

