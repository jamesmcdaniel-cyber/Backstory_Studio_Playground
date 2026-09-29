import type { Artifact, ArtifactVersion, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { htmlDocumentOf, htmlTitleOf, unwrapHtmlFence } from '@/lib/html-detect'
import { readAgentMetadata } from '@/lib/agents/metadata'
import type { ArtifactChatMessage, ArtifactKind, ArtifactListItem, ArtifactView } from './types'

/**
 * Artifacts: the durable handles on what agents produce.
 *
 * Registration is automatic — when a run finishes with an HTML document as
 * its answer, the executor calls `registerVersionFromExecution`: a new
 * artifact for a fresh report, or a new version when the run was asked for a
 * change to an existing one (the run's trigger carries the artifact id).
 * Nothing is ever overwritten; the current pointer moves.
 *
 * The conversation about an artifact is a list of messages on the artifact.
 * An "ask" is a run of the producing agent that answers in prose; a "change"
 * is a run that must answer with the whole revised document, which the
 * executor then registers as the next version. Both are ordinary runs — they
 * show in the Runs panel and notify like any other.
 */

export const ARTIFACT_QUESTION_MAX_CHARS = 2_000
export const ARTIFACT_CONTENT_MAX_CHARS = 2_000_000
/** How much of the current document a change/ask run is shown. */
const CONTEXT_MAX_CHARS = 120_000

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

function chatOf(row: Artifact): ArtifactChatMessage[] {
  return Array.isArray(row.chat) ? (row.chat as ArtifactChatMessage[]) : []
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === 'report' || value === 'roi_dashboard' || value === 'document'
}

/** Kinds whose documents carry scripts the viewer should run (own-origin only). */
export function isInteractiveKind(kind: string): boolean {
  return kind === 'roi_dashboard'
}

type TriggerShape = {
  type?: unknown
  artifactId?: unknown
  artifactMode?: unknown
  artifactRequest?: unknown
  flowId?: unknown
  parentFlowId?: unknown
  flowRunId?: unknown
  parentRunId?: unknown
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** The flow behind a run, when the run's trigger names one. */
export function flowIdFromTrigger(trigger: unknown): string | null {
  const t = (trigger ?? {}) as TriggerShape
  return str(t.flowId) ?? str(t.parentFlowId)
}

async function addVersion(params: {
  artifactId: string
  organizationId: string
  content: string
  executionId?: string | null
  flowRunId?: string | null
  request?: string | null
  createdByUserId?: string | null
}): Promise<ArtifactVersion> {
  return prisma.$transaction(async (tx) => {
    const artifact = await tx.artifact.findFirst({ where: { id: params.artifactId, organizationId: params.organizationId }, select: { versionCount: true } })
    if (!artifact) throw new Error('Artifact not found.')
    const version = await tx.artifactVersion.create({
      data: {
        organizationId: params.organizationId,
        artifactId: params.artifactId,
        number: artifact.versionCount + 1,
        executionId: params.executionId ?? null,
        flowRunId: params.flowRunId ?? null,
        request: params.request ?? null,
        content: params.content.slice(0, ARTIFACT_CONTENT_MAX_CHARS),
        createdByUserId: params.createdByUserId ?? null,
      },
    })
    await tx.artifact.update({
      where: { id: params.artifactId, organizationId: params.organizationId },
      data: { currentVersionId: version.id, versionCount: artifact.versionCount + 1, archivedAt: null },
    })
    return version
  })
}

/** Create an artifact with its first version. */
export async function createArtifact(params: {
  organizationId: string
  userId?: string | null
  kind: ArtifactKind
  title: string
  content: string
  agentTaskId?: string | null
  flowId?: string | null
  executionId?: string | null
  flowRunId?: string | null
}): Promise<{ artifact: Artifact; version: ArtifactVersion }> {
  const artifact = await prisma.artifact.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId ?? null,
      kind: params.kind,
      title: params.title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled artifact',
      agentTaskId: params.agentTaskId ?? null,
      flowId: params.flowId ?? null,
    },
  })
  const version = await addVersion({
    artifactId: artifact.id,
    organizationId: params.organizationId,
    content: params.content,
    executionId: params.executionId,
    flowRunId: params.flowRunId,
    createdByUserId: params.userId,
  })
  return { artifact: { ...artifact, currentVersionId: version.id, versionCount: 1 }, version }
}

/**
 * Called by the executor once a run has completed. Decides whether the
 * answer is an artifact and registers it. Returns the artifact id (for the
 * completion notification's deep link) or null when the answer was prose.
 */
export async function registerVersionFromExecution(params: {
  organizationId: string
  userId: string
  executionId: string
  agentTaskId: string
  agentTitle: string
  trigger: unknown
  summary: string
  headline?: string | null
}): Promise<{ artifactId: string; versionId: string; created: boolean } | null> {
  const html = htmlDocumentOf(params.summary)
  if (!html) return null
  const t = (params.trigger ?? {}) as TriggerShape
  const targetId = str(t.artifactId)
  if (targetId) {
    const target = await prisma.artifact.findFirst({ where: { id: targetId, organizationId: params.organizationId }, select: { id: true } })
    if (target) {
      const version = await addVersion({
        artifactId: target.id,
        organizationId: params.organizationId,
        content: html,
        executionId: params.executionId,
        request: str(t.artifactRequest),
        createdByUserId: params.userId,
      })
      await markChatVersion(params.organizationId, target.id, params.executionId, version.id)
      return { artifactId: target.id, versionId: version.id, created: false }
    }
  }
  const title = params.headline?.trim() || htmlTitleOf(html) || `${params.agentTitle} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  const { artifact, version } = await createArtifact({
    organizationId: params.organizationId,
    userId: params.userId,
    kind: 'report',
    title,
    content: html,
    agentTaskId: params.agentTaskId,
    flowId: flowIdFromTrigger(params.trigger),
    executionId: params.executionId,
  })
  return { artifactId: artifact.id, versionId: version.id, created: true }
}

/** Attach the produced version to the pending chat message that asked for it. */
async function markChatVersion(organizationId: string, artifactId: string, executionId: string, versionId: string): Promise<void> {
  const row = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId } })
  if (!row) return
  const chat = chatOf(row)
  const message = chat.find((m) => m.role === 'agent' && m.executionId === executionId)
  if (!message) return
  message.versionId = versionId
  message.status = 'completed'
  message.content = message.content || 'Done — a new version is ready.'
  await prisma.artifact.update({ where: { id: artifactId, organizationId }, data: { chat: jsonValue(chat) } })
}

export async function listArtifacts(organizationId: string, options: { kind?: ArtifactKind; agentTaskId?: string; includeArchived?: boolean } = {}): Promise<ArtifactListItem[]> {
  const rows = await prisma.artifact.findMany({
    where: {
      organizationId,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.agentTaskId ? { agentTaskId: options.agentTaskId } : {}),
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  const refs = await references(organizationId, rows)
  return rows.map((row) => ({
    id: row.id,
    kind: (isArtifactKind(row.kind) ? row.kind : 'report'),
    title: row.title,
    agent: row.agentTaskId ? refs.agents.get(row.agentTaskId) ?? null : null,
    flow: row.flowId ? refs.flows.get(row.flowId) ?? null : null,
    versionCount: row.versionCount,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }))
}

async function references(organizationId: string, rows: Artifact[]) {
  const agentIds = [...new Set(rows.map((row) => row.agentTaskId).filter((id): id is string => Boolean(id)))]
  const flowIds = [...new Set(rows.map((row) => row.flowId).filter((id): id is string => Boolean(id)))]
  const [agents, flows] = await Promise.all([
    agentIds.length ? prisma.agentTask.findMany({ where: { id: { in: agentIds }, organizationId }, select: { id: true, description: true, metadata: true, status: true } }) : [],
    flowIds.length ? prisma.flow.findMany({ where: { id: { in: flowIds }, organizationId }, select: { id: true, name: true, status: true } }) : [],
  ])
  return {
    agents: new Map(agents.map((agent) => [agent.id, { id: agent.id, title: readAgentMetadata(agent.metadata).title || agent.description }])),
    flows: new Map(flows.map((flow) => [flow.id, { id: flow.id, name: flow.name, active: flow.status === 'ACTIVE' }])),
  }
}

/** The artifact with its pending conversation reconciled against the runs. */
export async function loadArtifact(organizationId: string, id: string): Promise<ArtifactView | null> {
  let row = await prisma.artifact.findFirst({ where: { id, organizationId } })
  if (!row) return null
  row = await reconcileChat(row)
  const versions = await prisma.artifactVersion.findMany({
    where: { artifactId: id, organizationId },
    orderBy: { number: 'desc' },
    select: { id: true, number: true, executionId: true, flowRunId: true, request: true, createdAt: true, content: true },
  })
  const refs = await references(organizationId, [row])
  return {
    id: row.id,
    kind: isArtifactKind(row.kind) ? row.kind : 'report',
    title: row.title,
    agent: row.agentTaskId ? refs.agents.get(row.agentTaskId) ?? null : null,
    flow: row.flowId ? refs.flows.get(row.flowId) ?? null : null,
    currentVersionId: row.currentVersionId,
    versionCount: row.versionCount,
    versions: versions.map((version) => ({
      id: version.id,
      number: version.number,
      executionId: version.executionId,
      flowRunId: version.flowRunId,
      request: version.request,
      createdAt: version.createdAt.toISOString(),
      bytes: Buffer.byteLength(version.content),
    })),
    chat: chatOf(row),
    interactive: isInteractiveKind(row.kind),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function versionContent(organizationId: string, artifactId: string, versionId: string | 'current'): Promise<{ content: string; kind: string } | null> {
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId }, select: { kind: true, currentVersionId: true } })
  if (!artifact) return null
  const id = versionId === 'current' ? artifact.currentVersionId : versionId
  if (!id) return null
  const version = await prisma.artifactVersion.findFirst({ where: { id, artifactId, organizationId }, select: { content: true } })
  return version ? { content: version.content, kind: artifact.kind } : null
}

async function reconcileChat(row: Artifact): Promise<Artifact> {
  const chat = chatOf(row)
  const pending = chat.filter((message) => message.role === 'agent' && message.status === 'pending')
  if (!pending.length) return row
  let changed = false
  for (const message of pending) {
    if (message.executionId) {
      const run = await prisma.agentExecution.findFirst({ where: { id: message.executionId, organizationId: row.organizationId }, select: { status: true, output: true, error: true } })
      if (!run || !isTerminalRunStatus(run.status)) continue
      changed = true
      const text = typeof (run.output as { summary?: unknown } | null)?.summary === 'string' ? String((run.output as { summary: string }).summary) : ''
      if (run.status === 'completed') {
        const version = await prisma.artifactVersion.findFirst({ where: { executionId: message.executionId, organizationId: row.organizationId }, select: { id: true } })
        if (version) {
          message.versionId = version.id
          message.content = message.mode === 'change' ? 'Done — a new version is ready.' : 'The answer is a new version of the artifact.'
        } else if (message.mode === 'change' && htmlDocumentOf(text) === null) {
          message.content = `The agent replied without a revised document:\n\n${unwrapHtmlFence(text).slice(0, 4_000)}`
        } else {
          message.content = unwrapHtmlFence(text) || 'The agent finished without an answer.'
        }
        message.status = 'completed'
      } else {
        message.content = (typeof run.error === 'string' && run.error) || `The run ${run.status}.`
        message.status = 'failed'
      }
    } else if (message.flowRunId) {
      const run = await prisma.flowRun.findFirst({ where: { id: message.flowRunId, organizationId: row.organizationId }, select: { status: true, error: true } })
      if (!run || run.status === 'running' || run.status === 'waiting') continue
      changed = true
      const version = await prisma.artifactVersion.findFirst({ where: { flowRunId: message.flowRunId, organizationId: row.organizationId }, select: { id: true } })
      if (run.status === 'succeeded') {
        message.status = 'completed'
        message.versionId = version?.id
        message.content = version ? 'The flow finished — a new version is ready.' : 'The flow finished, but its output was not a document, so no version was added.'
      } else {
        message.status = 'failed'
        message.content = run.error || `The flow run ${run.status}.`
      }
    }
  }
  if (!changed) return row
  return prisma.artifact.update({ where: { id: row.id, organizationId: row.organizationId }, data: { chat: jsonValue(chat) } })
}

export function buildArtifactPrompt(params: { mode: 'ask' | 'change'; title: string; content: string; message: string; chat: ArtifactChatMessage[] }): string {
  const history = params.chat
    .filter((m) => m.content && m.status !== 'pending')
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content.slice(0, 1_200)}`)
    .join('\n\n')
  const doc = params.content.length > CONTEXT_MAX_CHARS ? `${params.content.slice(0, CONTEXT_MAX_CHARS)}\n<!-- truncated: the document continues -->` : params.content
  const head = params.mode === 'change'
    ? `CHANGE REQUEST for the artifact "${params.title}". Revise the document below as asked and answer with the COMPLETE revised HTML document — every section, not only the changed part — inside one \`\`\`html fence and nothing else. Keep everything the request does not touch exactly as it is. Recompute with your tools only where the change needs new facts.`
    : `QUESTION about the artifact "${params.title}". Answer in Markdown, grounded in the document below (and your tools where a fact is missing). Do not return the document.`
  return [head, '', 'CURRENT DOCUMENT:', doc, history ? `\nCONVERSATION SO FAR:\n${history}` : '', '', `${params.mode === 'change' ? 'REQUEST' : 'QUESTION'}: ${params.message.trim()}`].join('\n')
}

/** Ask the producing agent a question, or ask it for a change (a new version). */
export async function askArtifact(params: { organizationId: string; userId: string; id: string; message: string; mode: 'ask' | 'change' }): Promise<ArtifactView> {
  const row = await prisma.artifact.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
  if (!row) throw new Error('Artifact not found.')
  if (!row.agentTaskId) throw new Error('This artifact has no producing agent to ask.')
  const message = params.message.trim().slice(0, ARTIFACT_QUESTION_MAX_CHARS)
  if (!message) throw new Error('Type a message first.')
  const chat = chatOf(row)
  if (chat.some((m) => m.status === 'pending')) throw new Error('Wait for the current answer before sending another.')
  const agent = await prisma.agentTask.findFirst({ where: { id: row.agentTaskId, organizationId: params.organizationId, status: 'ACTIVE' } })
  if (!agent) throw new Error('The producing agent is no longer available.')
  const current = row.currentVersionId ? await prisma.artifactVersion.findFirst({ where: { id: row.currentVersionId, organizationId: params.organizationId }, select: { content: true } }) : null
  const input = buildArtifactPrompt({ mode: params.mode, title: row.title, content: current?.content ?? '', message, chat })
  const execution = await prisma.agentExecution.create({
    data: {
      agentType: agent.agentType,
      agentTaskId: agent.id,
      status: 'pending',
      input: { prompt: input },
      trigger: jsonValue({ type: 'artifact', artifactId: row.id, artifactMode: params.mode, artifactRequest: params.mode === 'change' ? message : null, link: `/artifacts/${row.id}` }),
      metadata: { title: `${params.mode === 'change' ? 'Change to' : 'Question on'} · ${row.title}` },
      userId: params.userId,
      organizationId: params.organizationId,
    },
  })
  try {
    await dispatchAgentExecution({ executionId: execution.id, agentId: agent.id, organizationId: params.organizationId, userId: params.userId, input })
  } catch (error) {
    await prisma.agentExecution.update({ where: { id: execution.id, organizationId: params.organizationId }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), completedAt: new Date() } }).catch(() => undefined)
    throw error
  }
  const now = new Date().toISOString()
  const next: ArtifactChatMessage[] = [
    ...chat,
    { role: 'user', mode: params.mode, content: message, createdAt: now },
    { role: 'agent', mode: params.mode, content: '', executionId: execution.id, status: 'pending', createdAt: now },
  ]
  await prisma.artifact.update({ where: { id: row.id, organizationId: params.organizationId }, data: { chat: jsonValue(next) } })
  return (await loadArtifact(params.organizationId, row.id))!
}

/** Re-run the producing flow; its output, when it is a document, becomes the next version. */
export async function rerunArtifactFlow(params: { organizationId: string; userId: string; id: string; message: string }): Promise<ArtifactView> {
  const row = await prisma.artifact.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
  if (!row) throw new Error('Artifact not found.')
  if (!row.flowId) throw new Error('This artifact was not produced by a flow.')
  const chat = chatOf(row)
  if (chat.some((m) => m.status === 'pending')) throw new Error('Wait for the current answer before sending another.')
  const { startFlowExecution } = await import('@/features/flows/execute-flow')
  const message = params.message.trim().slice(0, ARTIFACT_QUESTION_MAX_CHARS)
  const started = await startFlowExecution({
    flowId: row.flowId,
    organizationId: params.organizationId,
    userId: params.userId,
    usePublished: true,
    input: { artifactId: row.id, artifactTitle: row.title, request: message },
    trigger: { type: 'manual', artifactId: row.id, artifactRequest: message } as never,
  })
  const now = new Date().toISOString()
  const next: ArtifactChatMessage[] = [
    ...chat,
    { role: 'user', mode: 'change', content: message || 'Re-run the flow.', createdAt: now },
    { role: 'agent', mode: 'change', content: '', flowRunId: started.flowRunId, status: 'pending', createdAt: now },
  ]
  await prisma.artifact.update({ where: { id: row.id, organizationId: params.organizationId }, data: { chat: jsonValue(next) } })
  return (await loadArtifact(params.organizationId, row.id))!
}

/** Called by the flow finalizer: a succeeded run started for an artifact whose output holds a document adds a version. */
export async function registerVersionFromFlowRun(params: { organizationId: string; flowRunId: string; trigger: unknown; output: unknown }): Promise<string | null> {
  const t = (params.trigger ?? {}) as TriggerShape & { artifactRequest?: unknown }
  const artifactId = str(t.artifactId)
  if (!artifactId) return null
  const html = findHtml(params.output)
  if (!html) return null
  const target = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId: params.organizationId }, select: { id: true } })
  if (!target) return null
  const version = await addVersion({ artifactId, organizationId: params.organizationId, content: html, flowRunId: params.flowRunId, request: str(t.artifactRequest) })
  return version.id
}

/** The first HTML document inside a flow's output — a string, or a string field of an object. */
function findHtml(output: unknown, depth = 0): string | null {
  if (depth > 3 || output === null || output === undefined) return null
  if (typeof output === 'string') return htmlDocumentOf(output)
  if (Array.isArray(output)) {
    for (const item of output) { const found = findHtml(item, depth + 1); if (found) return found }
    return null
  }
  if (typeof output === 'object') {
    for (const value of Object.values(output as Record<string, unknown>)) { const found = findHtml(value, depth + 1); if (found) return found }
  }
  return null
}

export async function archiveArtifact(organizationId: string, id: string, archived: boolean): Promise<void> {
  await prisma.artifact.update({ where: { id, organizationId }, data: { archivedAt: archived ? new Date() : null } })
}
