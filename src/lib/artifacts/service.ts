import { artifactOutline } from './outline'
import type { Artifact, ArtifactVersion, Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { htmlDocumentOf, htmlTitleOf, looksLikeHtml, markdownDocumentOf, markdownTitleOf, unwrapHtmlFence } from '@/lib/html-detect'
import { reactArtifactDocument, reactComponentOf } from './runtime'
import { readAssistantConfig } from './assistant-settings'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { maxArtifactCharsFor, validateArtifactContent, validateArtifactPython } from './validate-content'
import { validateArtifactRuntime } from './preflight'
import { ARTIFACT_CAPABILITIES } from './capabilities'
import { GUEST_COPILOT_LIMITS, SHARED_UPDATE_REQUEST, TEMPLATE_COPILOT_MODEL, templateCopyRunsAs } from './template-policy'
import { guestChangesToday } from './guest-limits'
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
// A page up to this size is given to the assistant whole, so it edits without
// first searching for what it was already handed. (Prompt caching makes the
// repeat turns cheap; the search turns it replaces were each a model round trip.)
const CONTEXT_MAX_CHARS = 120_000

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

function chatOf(row: Artifact): ArtifactChatMessage[] {
  return Array.isArray(row.chat) ? (row.chat as ArtifactChatMessage[]) : []
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === 'report' || value === 'roi_dashboard' || value === 'document' || value === 'page'
}

/** Kinds whose documents carry scripts the viewer should run (own-origin only). */
export function isInteractiveKind(kind: string): boolean {
  // An ROI dashboard (rendered by the platform) and an interactive page a
  // person uploaded run their own scripts — sandboxed, with no network.
  return kind === 'roi_dashboard' || kind === 'page'
}

/** Whether HTML carries its own script — tabs, views, charts — and so must run to work. */
export function htmlHasScript(content: string): boolean {
  return /<script[\s>]/i.test(content)
}

/** JSX contains paired HTML tags; recognize the module before generic HTML. */
export function executionArtifactDocument(summary: string): string | null {
  const component = reactComponentOf(summary)
  return component ? reactArtifactDocument(component) : htmlDocumentOf(summary)
}

/**
 * A version runs its scripts when its kind is interactive or its HTML has
 * any: a report an agent wrote with tabs and views is a page, whatever it
 * was registered as. Scripts run sandboxed (opaque origin, no network).
 */
export function isInteractiveContent(kind: string, content: string): boolean {
  return isInteractiveKind(kind) || htmlHasScript(content) || Boolean(reactComponentOf(content))
}

// Just under the platform's 4.5 MB request-body ceiling.
export const ARTIFACT_UPLOAD_MAX_BYTES = 4_000_000

type TriggerShape = {
  type?: unknown
  artifactId?: unknown
  artifactMode?: unknown
  artifactRequest?: unknown
  artifactBaseVersionId?: unknown
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

type AddVersionParams = {
  artifactId: string
  organizationId: string
  content: string
  executionId?: string | null
  flowRunId?: string | null
  request?: string | null
  createdByUserId?: string | null
  state?: Prisma.InputJsonValue | null
  expectedVersionId?: string | null
}

export async function addVersion(params: AddVersionParams): Promise<ArtifactVersion> {
  const target = await prisma.artifact.findFirst({ where: { id: params.artifactId, organizationId: params.organizationId }, select: { kind: true } })
  validateArtifactContent(params.content, maxArtifactCharsFor(target?.kind))
  await validateArtifactPython(params.content)
  await validateArtifactRuntime(params.content)
  return tenantTransaction(params.organizationId, tx => insertValidatedVersion(tx, params))
}

/** Database-only publication. Callers must finish validation before opening a transaction. */
async function insertValidatedVersion(tx: Prisma.TransactionClient, params: AddVersionParams): Promise<ArtifactVersion> {
    // Atomic increment takes the row lock before reading the next number.
    // Competing saves serialize; a stale editing base fails without publishing.
    const claimed = await tx.artifact.updateMany({
      where: { id: params.artifactId, organizationId: params.organizationId, ...(params.expectedVersionId !== undefined ? { currentVersionId: params.expectedVersionId } : {}) },
      data: { versionCount: { increment: 1 } },
    })
    if (!claimed.count) throw new Error('Artifact changed while editing, or is no longer available. Reload the current version and retry; nothing was saved.')
    const artifact = await tx.artifact.findFirst({ where: { id: params.artifactId, organizationId: params.organizationId }, select: { versionCount: true } })
    if (!artifact) throw new Error('Artifact not found.')
    // One run, one linked version: a second edit in the same run is still a
    // version, but only the first carries the run id (the column is unique).
    const executionTaken = params.executionId
      ? await tx.artifactVersion.findFirst({ where: { executionId: params.executionId, organizationId: params.organizationId }, select: { id: true } })
      : null
    const version = await tx.artifactVersion.create({
      data: {
        organizationId: params.organizationId,
        artifactId: params.artifactId,
        number: artifact.versionCount,
        executionId: executionTaken ? null : params.executionId ?? null,
        flowRunId: params.flowRunId ?? null,
        request: params.request ?? null,
        content: params.content,
        createdByUserId: params.createdByUserId ?? null,
        ...(params.state ? { state: params.state } : {}),
      },
    })
    await tx.artifact.update({
      where: { id: params.artifactId, organizationId: params.organizationId },
      data: { currentVersionId: version.id, archivedAt: null },
    })
    return version
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
  state?: Prisma.InputJsonValue | null
}): Promise<{ artifact: Artifact; version: ArtifactVersion }> {
  validateArtifactContent(params.content, maxArtifactCharsFor(params.kind))
  await validateArtifactPython(params.content)
  await validateArtifactRuntime(params.content)
  return prisma.$transaction(async tx => {
  const artifact = await tx.artifact.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId ?? null,
      kind: params.kind,
      title: params.title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled artifact',
      agentTaskId: params.agentTaskId ?? null,
      flowId: params.flowId ?? null,
      versionCount: 1,
    },
  })
  const version = await tx.artifactVersion.create({ data: {
    artifactId: artifact.id,
    organizationId: params.organizationId,
    content: params.content,
    executionId: params.executionId,
    flowRunId: params.flowRunId,
    createdByUserId: params.userId ?? null,
    number: 1,
    ...(params.state ? { state: params.state } : {}),
  } })
  await tx.artifact.update({ where: { id: artifact.id, organizationId: params.organizationId }, data: { currentVersionId: version.id } })
  return { artifact: { ...artifact, currentVersionId: version.id, versionCount: 1 }, version }
  })
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
  // An HTML document, or a React component (a Claude-style artifact) served
  // as a page the content route compiles.
  const html = executionArtifactDocument(params.summary)
  const t = (params.trigger ?? {}) as TriggerShape
  const targetId = str(t.artifactId)
  if (targetId) {
    // The assistant's tools make versions themselves (revise_artifact,
    // update_roi_dashboard); the answer is then prose about what changed.
    const made = await prisma.artifactVersion.findFirst({ where: { executionId: params.executionId, organizationId: params.organizationId }, select: { id: true, artifactId: true } })
    if (made) return { artifactId: made.artifactId, versionId: made.id, created: false }
    const target = await prisma.artifact.findFirst({ where: { id: targetId, organizationId: params.organizationId }, select: { id: true, kind: true, templateSourceId: true, userId: true, guestDigest: true, agentTaskId: true } })
    if (target?.templateSourceId && (!templateCopyRunsAs(target, params.userId) || target.agentTaskId !== params.agentTaskId)) throw new Error('Template copy access denied.')
    // A change to a Markdown document comes back as Markdown; a change to an
    // HTML report must come back as HTML (a prose reply is an answer, not a
    // version — the chat shows it as such).
    const revised = target?.kind === 'roi_dashboard'
      ? null // rendered from state; only update_roi_dashboard makes its versions
      : html ?? (target?.kind === 'document' && (t.artifactMode === 'change' || markdownDocumentOf(params.summary)) ? unwrapHtmlFence(params.summary).trim() || null : null)
    if (target && revised) {
      const version = await addVersion({
        artifactId: target.id,
        organizationId: params.organizationId,
        content: revised,
        executionId: params.executionId,
        request: str(t.artifactRequest),
        createdByUserId: params.userId,
        ...(typeof t.artifactBaseVersionId === 'string' ? { expectedVersionId: t.artifactBaseVersionId } : {}),
      })
      await markChatVersion(params.organizationId, target.id, params.executionId, version.id)
      return { artifactId: target.id, versionId: version.id, created: false }
    }
  }
  const markdown = html ? null : markdownDocumentOf(params.summary)
  if (!html && !markdown) return null
  const content = html ?? markdown!
  // The document's own title (its <title> or first heading) names it best; the
  // run's one-line headline is a summary of the run, not a name for the page.
  const title = (html ? htmlTitleOf(html) : markdownTitleOf(content)) || params.headline?.trim() || `${params.agentTitle} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  const { artifact, version } = await createArtifact({
    organizationId: params.organizationId,
    userId: params.userId,
    kind: html ? (htmlHasScript(html) ? 'page' : 'report') : 'document',
    title,
    content,
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

export async function listArtifacts(organizationId: string, options: { userId?: string; kind?: ArtifactKind; agentTaskId?: string; includeArchived?: boolean } = {}): Promise<ArtifactListItem[]> {
  const rows = await prisma.artifact.findMany({
    where: {
      organizationId,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.agentTaskId ? { agentTaskId: options.agentTaskId } : {}),
      ...(options.includeArchived ? {} : { archivedAt: null }),
      OR: [{ templateSourceId: null }, ...(options.userId ? [{ userId: options.userId }] : [])],
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
    archivedAt: row.archivedAt?.toISOString() ?? null,
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
export async function artifactStatus(organizationId: string, id: string) {
  const found = await prisma.artifact.findFirst({ where: { id, organizationId } })
  if (!found) return null
  const row = await reconcileChat(found)
  return { id: row.id, currentVersionId: row.currentVersionId, updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt, userId: row.userId, workspaceAccess: row.workspaceAccess, editorIds: row.editorIds, templateSourceId: row.templateSourceId }
}

export async function loadArtifact(organizationId: string, id: string, before?: number): Promise<ArtifactView | null> {
  let row = await prisma.artifact.findFirst({ where: { id, organizationId } })
  if (!row) return null
  row = await reconcileChat(row)
  const versions = await prisma.artifactVersion.findMany({
    where: { artifactId: id, organizationId, ...(before ? { number: { lt: before } } : {}) },
    orderBy: { number: 'desc' },
    take: 20,
    select: { id: true, number: true, executionId: true, flowRunId: true, request: true, createdAt: true, content: true, createdByUserId: true },
  })
  const refs = await references(organizationId, [row])
  const authorIds = [...new Set(versions.map((version) => version.createdByUserId).filter((id): id is string => Boolean(id)))]
  const authors = new Map((authorIds.length ? await prisma.user.findMany({ where: { id: { in: authorIds }, organizationId }, select: { id: true, name: true, email: true } }) : []).map((user) => [user.id, user.name || user.email || 'A teammate']))
  return {
    configurationLocked: Boolean(row.templateSourceId),
    id: row.id,
    kind: isArtifactKind(row.kind) ? row.kind : 'report',
    title: row.title,
    agent: row.agentTaskId ? refs.agents.get(row.agentTaskId) ?? null : null,
    flow: row.flowId ? refs.flows.get(row.flowId) ?? null : null,
    currentVersionId: row.currentVersionId,
    versionCount: row.versionCount,
    nextVersionBefore: versions.length === 20 && versions.at(-1)!.number > 1 ? versions.at(-1)!.number : null,
    versions: versions.map((version) => ({
      id: version.id,
      number: version.number,
      executionId: version.executionId,
      flowRunId: version.flowRunId,
      request: version.request,
      createdAt: version.createdAt.toISOString(),
      bytes: Buffer.byteLength(version.content),
      format: reactComponentOf(version.content) || looksLikeHtml(version.content.slice(0, 4_000)) ? 'html' : 'markdown',
      author: version.createdByUserId ? authors.get(version.createdByUserId) ?? null : null,
      source: version.executionId ? 'agent' : version.flowRunId ? 'flow' : version.request?.startsWith('Restored version') ? 'restore' : version.request === SHARED_UPDATE_REQUEST ? 'shared' : version.number === 1 ? 'created' : 'agent',
    })),
    chat: chatOf(row),
    interactive: isInteractiveKind(row.kind),
    // ROI dashboards, and pages an Account 360 analysis builds, follow their run.
    build: row.kind === 'roi_dashboard' || (row.kind === 'page' && versions.length === 0)
      ? await import('@/lib/roi/service').then(({ roiBuildFor }) => roiBuildFor(organizationId, row.id)).then((b) => (b && (b.status !== 'completed' || versions.length === 0) ? { status: b.status, executionId: b.executionId, error: b.error, account: b.account } : null)).catch(() => null)
      : null,
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
      const run = await prisma.agentExecution.findFirst({ where: { id: message.executionId, organizationId: row.organizationId }, select: { status: true, output: true, error: true, metadata: true } })
      if (run && !isTerminalRunStatus(run.status)) {
        // A run paused on a question surfaces it on its message, so it is
        // asked — and answered — in the conversation that started the run.
        const pendingQuestion = (run.metadata as { pendingQuestion?: { question?: unknown; toolCallId?: unknown } } | null)?.pendingQuestion
        // Not one already answered here and waiting for its resume to be picked up.
        const open = run.status === 'waiting_for_input' && !(message.answeredQuestionId && message.answeredQuestionId === str(pendingQuestion?.toolCallId))
        const asked = open ? str(pendingQuestion?.question) || 'The assistant needs your input to continue.' : undefined
        if (message.question !== asked) {
          if (asked) message.question = asked
          else delete message.question
          changed = true
        }
        continue
      }
      if (!run) continue
      delete message.question
      changed = true
      const text = typeof (run.output as { summary?: unknown } | null)?.summary === 'string' ? String((run.output as { summary: string }).summary) : ''
      if (run.status === 'completed') {
        const version = await prisma.artifactVersion.findFirst({ where: { executionId: message.executionId, organizationId: row.organizationId }, select: { id: true } })
        // The agent's own words, unless its answer WAS the document (the
        // pre-tool path), which is the version, not a reply.
        const reply = htmlDocumentOf(text) ? '' : unwrapHtmlFence(text).trim()
        if (version) {
          message.versionId = version.id
          message.content = reply || 'Done — a new version is ready.'
        } else if (message.mode === 'change') {
          message.content = reply ? `No new version was saved.\n\n${reply.slice(0, 4_000)}` : 'No new version was saved.'
        } else {
          message.content = reply || 'The agent finished without an answer.'
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

export type ArtifactChatMode = 'auto' | 'ask' | 'change'

const ROI_ASSISTANT_RULES = `You are the assistant for the ROI dashboard this conversation is about. The user can ask you three kinds of thing; decide which each message is:
1. A QUESTION about the analysis ("why did win rate rise?", "how many reps are users?", "what does the persona chart mean?"). Call get_artifact for the facts summary and narrative and answer in Markdown from them. If the answer needs a number the summary does not hold, compute it with run_code over the same extracts (the repository datasets). Never guess a number.
2. A CHANGE to the dashboard ("remove the adoption tab", "drop pipeline metrics", "add accounts touched as a metric", "rename VP meetings", "rewrite the headline for a CFO", "default to year-over-year"). Call get_artifact to see the tabs, sections, metrics and activity-extract columns you can use, then call update_roi_dashboard once with every edit the request needs. For a new metric, map the user's words to activity-extract columns (e.g. "accounts touched" → accounts_touched). Tell the user in one or two sentences what changed; mention anything rejected and why.
3. The SAME DASHBOARD FOR ANOTHER ACCOUNT or time frame ("show me this for Acme", "run it for last 12 months"). Call list_roi_accounts, match the account the user named, then start_roi_analysis. Share the link it returns and say it will be ready in a few minutes. If the account has no extracts loaded, say so and list the accounts that do.
4. A question the dashboard's facts cannot answer — live or recent account context: an account's recent activity, who is engaged, a deal's status or risks, a named opportunity, news. Answer it from the live sources you have: the Sales AI / Backstory MCP tools (find the account first, then its status, activity or engaged people) and any other connected integration. Say which source each fact came from, and keep it distinct from the analysis's computed numbers.
A message can combine these — handle each part. Never write or return HTML: the page is rendered from what your tools store. Keep replies short, and keep units exact: say "usage records", "reps" or "deals" as the facts do, never one for another.`

// A shared-template copy has no "save as a new artifact": the copy IS the
// visitor's own artifact, made to be changed. Told to save "a new one"
// elsewhere, its copilot apologised for a tool it does not have and rebuilt
// the page from scratch; these rules make every such request an in-place edit.
const TEMPLATE_COPY_NEW_ONE_RULE = `3. "A NEW ONE" ("create a new artifact", "make one for Acme", "a version for the EMEA team"): this page is the user's own copy, made for them to change, so the request means CHANGE THIS PAGE. Do it here with edit_artifact: keep its layout, design, sections and working features, and change what was asked — usually the data it shows. Do not rebuild it as a different page of your own design unless a different design is what they asked for, and do not add a link, toggle or banner leading back to the earlier content (History already keeps every earlier version). Never say you could not create something or that you can only edit this copy — say what changed.`

const DOCUMENT_ASSISTANT_RULES = (isHtml: boolean, templateCopy = false) => `You are the assistant for the artifact this conversation is about. Decide what each message is:
1. A QUESTION about it: answer in Markdown, grounded in the document (and your tools where a fact is missing). Do not return the document.
2. A CHANGE to it ("remove the risks section", "update the Q3 numbers", "make the header blue"): make it with edit_artifact — exact find-and-replace edits of the parts that change, everything else untouched. When the whole document is given below, edit from it directly — do not search for what you can already see. For a page too large to be given whole, use its map to read the part you need (read_artifact), look up anything else with ONE find_in_artifact call carrying every term, and copy the exact snippet into \`find\`. Use revise_artifact only to rewrite a small document from scratch. ${isHtml ? 'It is HTML: keep it valid, and if it is an interactive page keep its scripts working — chart data usually lives in inline <script> blocks, so a data change is an edit there.' : 'It is Markdown: keep its structure.'} Then tell the user in one or two sentences what changed.
${templateCopy ? TEMPLATE_COPY_NEW_ONE_RULE : `3. A COPY or VARIANT ("make a version for the EMEA team", "save this as a new one"): make the edits with saveAsNew: true and a fitting title, and share the new artifact's link. The original stays as it is.`}
4. A question or change that needs facts the document does not hold: fetch them with the tools you have — ${templateCopy ? 'the data tools attached to this copilot (shared demo data, or servers the user connected themselves)' : 'the Sales AI / Backstory MCP and the integrations that produced this artifact'} — and say where each fact came from.${templateCopy ? '' : `
5. THE SAME ANALYSIS FOR ANOTHER ACCOUNT — when get_artifact shows an \`analysis\` (the page was built from repository extracts, e.g. an Account 360 ROI dashboard): answer questions from its summary, and for "show me this for Acme" call list_roi_accounts, match the account, then start_roi_analysis; share the link it returns.`}
Recompute with your tools only where a change needs new facts.`

/** The owner's standing instructions, placed after the rules they must not override. */
function standingInstructions(instructions?: string): string {
  const text = instructions?.trim()
  return text ? `\nSTANDING INSTRUCTIONS FOR THIS ARTIFACT (from the people who use it — follow them on every message unless they conflict with the rules above):\n${text}\n` : ''
}

export function buildArtifactPrompt(params: { mode: ArtifactChatMode; kind?: string; title: string; content: string; message: string; chat: ArtifactChatMessage[]; instructions?: string; templateCopy?: boolean; /** An anonymous visitor's copy: changes still allowed today. */ changesLeft?: number }): string {
  const history = params.chat
    .filter((m) => m.content && m.status !== 'pending')
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content.slice(0, 1_200)}`)
    .join('\n\n')
  const hint = params.mode === 'change' ? '\n(The user marked this as a change request.)' : params.mode === 'ask' ? '\n(The user marked this as a question.)' : ''
  if (params.kind === 'roi_dashboard') {
    // The dashboard page is ~2 MB of rendered HTML; the agent works from the
    // facts and narrative its tools return, never from the page.
    return [ROI_ASSISTANT_RULES, standingInstructions(params.instructions), `ARTIFACT: "${params.title}"`, history ? `\nCONVERSATION SO FAR:\n${history}` : '', '', `MESSAGE: ${params.message.trim()}${hint}`].join('\n')
  }
  const isHtml = looksLikeHtml(params.content.slice(0, 4_000))
  // A larger page is not pasted in: the assistant gets its start and a map of
  // it by character offset, and reads the parts a request touches.
  const outline = params.content.length > CONTEXT_MAX_CHARS ? artifactOutline(params.content) : ''
  const doc = params.content.length > CONTEXT_MAX_CHARS
    ? `${params.content.slice(0, 4_000)}\n<!-- ${params.content.length.toLocaleString()} characters in all; this is the start. -->${outline ? `\n\nMAP OF THE DOCUMENT (@character offset, what is there). Go straight to the part you need with read_artifact at that offset; use find_in_artifact — with EVERY term you need in one call — only for text the map does not locate:\n${outline}` : '\nUse find_in_artifact (every term you need in one call) and read_artifact to see the rest.'}`
    : params.content
  const allowance = params.changesLeft === undefined ? '' : params.changesLeft > 0
    ? `\nCHANGES LEFT TODAY: ${params.changesLeft}. Each message that changes the page uses one, so make everything a request asks for in one go.`
    : '\nCHANGES LEFT TODAY: 0. Do not edit the page — a save will be refused. Answer questions as usual; if this message asks for a change, say today\'s changes are used up and it can be made tomorrow, or straight away in their own workspace if they sign in.'
  return [DOCUMENT_ASSISTANT_RULES(isHtml, params.templateCopy), allowance, ARTIFACT_CAPABILITIES, 'Work directly on the requested edit. Batch independent lookups and edits; do not draft a long plan or rebuild unaffected sections. Reply in two sentences after the save.', standingInstructions(params.instructions), `ARTIFACT: "${params.title}"`, '', 'CURRENT DOCUMENT:', doc, history ? `\nCONVERSATION SO FAR:\n${history}` : '', '', `MESSAGE: ${params.message.trim()}${hint}`].join('\n')
}

/**
 * Start a new chat: the conversation is cleared, the artifact and every
 * version of it stay exactly as they are. Refused while the assistant is still
 * working, so a run in flight never loses the message its answer belongs to.
 */
export async function clearArtifactChat(params: { organizationId: string; id: string }): Promise<void> {
  const row = await prisma.artifact.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
  if (!row) throw new Error('Artifact not found.')
  if (chatOf(row).some((m) => m.status === 'pending')) throw new Error('Wait for the current answer before starting a new chat.')
  await prisma.artifact.update({ where: { id: row.id, organizationId: params.organizationId }, data: { chat: jsonValue([]) } })
}

/** Ask the producing agent a question, or ask it for a change (a new version). */
export async function askArtifact(params: { organizationId: string; userId: string; id: string; message: string; mode: ArtifactChatMode; model?: string; guestDigest?: string }): Promise<ArtifactView> {
  const row = await prisma.artifact.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
  if (!row) throw new Error('Artifact not found.')
  if (!row.agentTaskId) throw new Error('This artifact has no producing agent to ask.')
  // A guest copy answers only to the visitor whose token made it (the public
  // copilot route); a signed-in caller never reaches one.
  if (row.guestDigest || params.guestDigest) {
    if (!row.templateSourceId || row.userId !== null || !row.guestDigest || row.guestDigest !== params.guestDigest) throw new Error('Artifact not found.')
  }
  if (row.templateSourceId) {
    if (!row.guestDigest && row.userId !== params.userId) throw new Error('Artifact not found.')
    // The browser's general model preference is not a configuration grant.
    params = { ...params, model: TEMPLATE_COPILOT_MODEL }
  }
  const message = params.message.trim().slice(0, ARTIFACT_QUESTION_MAX_CHARS)
  if (!message) throw new Error('Type a message first.')
  const chat = chatOf(row)
  if (chat.some((m) => m.status === 'pending')) throw new Error('Wait for the current answer before sending another.')
  const agent = await prisma.agentTask.findFirst({ where: { id: row.agentTaskId, organizationId: params.organizationId, status: 'ACTIVE' } })
  if (!agent) throw new Error('The producing agent is no longer available.')
  const current = row.currentVersionId ? await prisma.artifactVersion.findFirst({ where: { id: row.currentVersionId, organizationId: params.organizationId }, select: { content: true } }) : null
  const assistant = readAssistantConfig(row.assistantConfig)
  // A visitor's copy takes a fixed number of changes a day; the copilot is told how many are left.
  const changesLeft = row.guestDigest ? Math.max(0, GUEST_COPILOT_LIMITS.changesPerVisitor - await guestChangesToday(params.organizationId, row.id)) : undefined
  const input = buildArtifactPrompt({ mode: params.mode, kind: row.kind, title: row.title, content: row.kind === 'roi_dashboard' ? '' : current?.content ?? '', message, chat, instructions: assistant.instructions, templateCopy: Boolean(row.templateSourceId), ...(changesLeft !== undefined ? { changesLeft } : {}) })
  const execution = await prisma.agentExecution.create({
    data: {
      agentType: agent.agentType,
      agentTaskId: agent.id,
      status: 'pending',
      input: { prompt: input },
      // A guest run is marked so it is capped per link, never against the
      // host's own daily allowance; it links to the template the host can open.
      trigger: jsonValue({ type: 'artifact', artifactId: row.id, artifactBaseVersionId: row.currentVersionId, artifactMode: params.mode, artifactRequest: params.mode === 'ask' ? null : message, artifactToolQuery: message, ...(row.guestDigest ? { guest: true, guestTemplateId: row.templateSourceId, link: `/artifacts/${row.templateSourceId}` } : { link: `/artifacts/${row.id}` }) }),
      metadata: { title: `${row.guestDigest ? 'Visitor copilot' : params.mode === 'change' ? 'Change to' : params.mode === 'ask' ? 'Question on' : 'Assistant'} · ${row.title}` },
      userId: params.userId,
      organizationId: params.organizationId,
    },
  })
  try {
    // The model the person picked, and the connected tools they turned on
    // for this artifact's assistant (granted for the run like a flow step's).
    const stepOverrides = { ...(params.model ? { model: params.model } : {}), ...(assistant.toolConnectionIds.length ? { toolConnectionIds: assistant.toolConnectionIds } : {}) }
    await dispatchAgentExecution({ executionId: execution.id, agentId: agent.id, organizationId: params.organizationId, userId: params.userId, input, ...(Object.keys(stepOverrides).length ? { stepOverrides } : {}) })
  } catch (error) {
    await prisma.agentExecution.update({ where: { id: execution.id, organizationId: params.organizationId }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), completedAt: new Date() } }).catch(() => undefined)
    throw error
  }
  const now = new Date().toISOString()
  const next: ArtifactChatMessage[] = [
    ...chat,
    { role: 'user', mode: params.mode, content: message, createdAt: now },
    { role: 'agent', mode: params.mode, content: '', executionId: execution.id, status: 'pending', createdAt: now, ...(params.model ? { model: params.model } : {}) },
  ]
  await prisma.artifact.update({ where: { id: row.id, organizationId: params.organizationId }, data: { chat: jsonValue(next) } })
  return (await loadArtifact(params.organizationId, row.id))!
}

/**
 * Answer the question an artifact's assistant paused on. Authorised by the
 * artifact (the caller has already shown they may change it), not by who owns
 * the agent: whoever is in the conversation can answer it. The run resumes as
 * the person it was already running as.
 */
export async function replyToArtifactQuestion(params: { organizationId: string; id: string; message: string; guestDigest?: string }): Promise<ArtifactView> {
  const found = await prisma.artifact.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
  if (!found) throw new Error('Artifact not found.')
  if (found.guestDigest || params.guestDigest) {
    if (!found.templateSourceId || found.userId !== null || !found.guestDigest || found.guestDigest !== params.guestDigest) throw new Error('Artifact not found.')
  }
  const answer = params.message.trim().slice(0, ARTIFACT_QUESTION_MAX_CHARS)
  if (!answer) throw new Error('Type a message first.')
  const row = await reconcileChat(found)
  const chat = chatOf(row)
  const index = chat.findIndex((m) => m.role === 'agent' && m.status === 'pending' && m.executionId && m.question)
  const waiting = chat[index]
  if (!waiting?.executionId) throw new Error('The assistant is not waiting for an answer.')
  // Only a run still paused on this artifact's question is answered. (Two
  // answers racing both reach the resume; its waiting -> running claim is
  // atomic, so the run continues once.)
  const execution = await prisma.agentExecution.findFirst({ where: { id: waiting.executionId, organizationId: params.organizationId, status: 'waiting_for_input', agentTaskId: row.agentTaskId ?? undefined } })
  const trigger = execution?.trigger as { type?: string; artifactId?: string } | null
  if (!execution?.agentTaskId || trigger?.type !== 'artifact' || trigger.artifactId !== row.id) throw new Error('The assistant is not waiting for an answer.')
  await prisma.executionMessage.create({ data: { executionId: execution.id, role: 'user', content: answer } })
  // The exchange becomes part of the conversation: the question as the
  // assistant's message, the answer as the person's, then the run carries on.
  const now = new Date().toISOString()
  const { question, ...resumed } = waiting
  const next: ArtifactChatMessage[] = [
    ...chat.slice(0, index),
    { role: 'agent', content: question!, status: 'completed', createdAt: waiting.createdAt },
    { role: 'user', content: answer, createdAt: now },
    { ...resumed, createdAt: now, answeredQuestionId: str((execution.metadata as { pendingQuestion?: { toolCallId?: unknown } } | null)?.pendingQuestion?.toolCallId) ?? undefined },
    ...chat.slice(index + 1),
  ]
  await prisma.artifact.update({ where: { id: row.id, organizationId: params.organizationId }, data: { chat: jsonValue(next) } })
  const { resumeAgentExecution } = await import('@/features/agents/execute-agent')
  try {
    await resumeAgentExecution({ executionId: execution.id, agentId: execution.agentTaskId, organizationId: params.organizationId, userId: execution.userId, reply: answer })
  } catch (error) {
    await prisma.agentExecution.updateMany({ where: { id: execution.id, organizationId: params.organizationId, status: { in: ['waiting_for_input', 'running'] } }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), completedAt: new Date() } }).catch(() => undefined)
  }
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
    trigger: { type: 'manual', artifactId: row.id, artifactBaseVersionId: row.currentVersionId, artifactRequest: message } as never,
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
  const publish = await prepareFlowArtifactVersion(params)
  return publish ? tenantTransaction(params.organizationId, publish) : null
}

/** Validate off-transaction; publish atomically with the flow terminal state and outbox. */
export async function prepareFlowArtifactVersion(params: { organizationId: string; flowRunId: string; trigger: unknown; output: unknown }): Promise<((tx: Prisma.TransactionClient) => Promise<string>) | null> {
  const t = (params.trigger ?? {}) as TriggerShape & { artifactRequest?: unknown }
  const artifactId = str(t.artifactId)
  if (!artifactId) return null
  const html = findHtml(params.output)
  if (!html) throw new Error('Artifact publication failed: the flow output did not contain a document. No version was saved.')
  const target = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId: params.organizationId }, select: { id: true, templateSourceId: true } })
  if (!target) throw new Error('Artifact publication failed: the artifact is no longer available.')
  if (target.templateSourceId) throw new Error('Template copies cannot be changed by flows.')
  validateArtifactContent(html)
  await validateArtifactPython(html)
  await validateArtifactRuntime(html)
  return async tx => {
    const existing = await tx.artifactVersion.findFirst({ where: { organizationId: params.organizationId, flowRunId: params.flowRunId }, select: { id: true } })
    if (existing) return existing.id
    const version = await insertValidatedVersion(tx, { artifactId, organizationId: params.organizationId, content: html, flowRunId: params.flowRunId, request: str(t.artifactRequest), ...(typeof t.artifactBaseVersionId === 'string' ? { expectedVersionId: t.artifactBaseVersionId } : {}) })
    return version.id
  }
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

/**
 * Restore an earlier version. History is never rewritten: the restored
 * content (and, for a rendered kind, its state) becomes a NEW version at the
 * top, so restoring is itself undoable and the trail shows who went back.
 */
export async function restoreVersion(params: { organizationId: string; userId: string; artifactId: string; versionId: string }): Promise<ArtifactVersion> {
  const artifact = await prisma.artifact.findFirst({ where: { id: params.artifactId, organizationId: params.organizationId }, select: { id: true, currentVersionId: true } })
  if (!artifact) throw new Error('Artifact not found.')
  if (artifact.currentVersionId === params.versionId) throw new Error('That version is already the current one.')
  const source = await prisma.artifactVersion.findFirst({ where: { id: params.versionId, artifactId: params.artifactId, organizationId: params.organizationId }, select: { number: true, content: true, state: true } })
  if (!source) throw new Error('Version not found.')
  return addVersion({
    artifactId: artifact.id,
    organizationId: params.organizationId,
    content: source.content,
    request: `Restored version ${source.number}`,
    createdByUserId: params.userId,
    state: (source.state ?? null) as Prisma.InputJsonValue | null,
  })
}
