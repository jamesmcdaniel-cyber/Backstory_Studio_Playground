import { randomBytes, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma, systemPrisma, tenantTransaction } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'
import { ApiError } from '@/lib/server/api-handler'
import { GUEST_COPILOT_AGENT_TYPE, GUEST_COPILOT_LIMITS, TEMPLATE_COPILOT_INSTRUCTIONS, TEMPLATE_COPILOT_MODEL } from './template-policy'
import { startOfUtcDay } from '@/lib/usage/free-tier-limits'
import type { ArtifactChatMessage, GuestCopilotView } from './types'
import { addCopilotMcpServer, copilotMcpViews, removeCopilotMcpServer, testCopilotMcpServer, type CopilotMcpInput } from './copilot-mcp'

/** Explicit bearer-token export of published source only, into the caller's tenant. */
export async function useArtifactTemplate(token: string, organizationId: string, userId: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new ApiError('Template not available.', 404, 'NOT_FOUND')
  // systemPrisma: cross-tenant access is restricted to this opted-in public
  // token. Never fetch source agent/config/chat/app state or private history.
  const source = await systemPrisma.artifact.findFirst({
    where: { shareTokenDigest: hashToken(token), shareAnonymous: true, shareTemplate: true, archivedAt: null, templateSourceId: null },
    select: { id: true, organizationId: true, currentVersionId: true, title: true, kind: true },
  })
  if (!source?.currentVersionId) throw new ApiError('Template not available.', 404, 'NOT_FOUND')
  const where = { organizationId, userId, templateSourceId: source.id }
  const existing = await prisma.artifact.findFirst({ where, select: { id: true } })
  if (existing) return existing
  const version = await systemPrisma.artifactVersion.findFirst({
    where: {
      id: source.currentVersionId, artifactId: source.id, organizationId: source.organizationId,
      artifact: { shareTokenDigest: hashToken(token), shareAnonymous: true, shareTemplate: true, archivedAt: null, currentVersionId: source.currentVersionId },
    },
    select: { content: true },
  })
  if (!version) throw new ApiError('The template changed. Reload its link and try again.', 409, 'TEMPLATE_CHANGED')
  try {
    return await tenantTransaction(organizationId, async tx => {
      const id = randomUUID()
      const versionId = randomUUID()
      const agent = await tx.agentTask.create({ data: {
        organizationId, userId, artifactTemplateCopyId: id,
        type: 'agent', agentType: 'CUSTOM', status: 'ACTIVE', visibility: 'private',
        // The copy's own agent: listed among its owner's agents. Its only data
        // is the workspace's shareable (demo) MCP servers — never live data.
        description: `Copilot for your copy of "${source.title.slice(0, 120)}". Edits it and answers questions about it.`, objective: TEMPLATE_COPILOT_INSTRUCTIONS,
        schedule: { type: 'manual', isActive: false },
        metadata: { title: `${source.title.slice(0, 70)} · copilot`, model: TEMPLATE_COPILOT_MODEL, integrations: ['Backstory'], skills: [], icon: 'artifact' },
      } })
      const copy = await tx.artifact.create({ data: {
        id, organizationId, userId, templateSourceId: source.id,
        title: `${source.title.slice(0, 180)} · my copy`,
        // An ROI copy is editable source, not a pointer to private facts/files.
        kind: source.kind === 'roi_dashboard' ? 'page' : source.kind,
        agentTaskId: agent.id, workspaceAccess: 'view',
        currentVersionId: versionId, versionCount: 1,
      }, select: { id: true } })
      await tx.artifactVersion.create({ data: {
        id: versionId, organizationId, artifactId: id, number: 1,
        content: version.content, request: 'Created personal template copy', createdByUserId: userId,
      } })
      return copy
    })
  } catch (error) {
    // Double-clicks and concurrent tabs return the same copy, with no orphan
    // agents/versions: the losing transaction is rolled back in full.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const copy = await prisma.artifact.findFirst({ where, select: { id: true } })
      if (copy) return copy
    }
    throw error
  }
}

/**
 * The signed-in visitor's existing copy of a template link, if they have made
 * one. Never creates: just opening a link must not make a copy, but coming
 * back to it must show the copy they already changed.
 */
export async function findArtifactTemplateCopy(token: string, organizationId: string, userId: string): Promise<{ id: string } | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null
  // systemPrisma: same opted-in public-token lookup as useArtifactTemplate.
  const source = await systemPrisma.artifact.findFirst({
    where: { shareTokenDigest: hashToken(token), shareAnonymous: true, shareTemplate: true, archivedAt: null, templateSourceId: null },
    select: { id: true },
  })
  if (!source) return null
  return prisma.artifact.findFirst({ where: { organizationId, userId, templateSourceId: source.id }, select: { id: true } })
}

/**
 * The guest copilot: a public template link used by someone with no account.
 *
 * The sender opted in twice (anyone-with-the-link, and "offer as a template"),
 * so the visitor's copy is held in the SENDER's workspace: no owner, hidden
 * from every signed-in surface, and opened only by the digest of a random
 * token kept in the visitor's cookie. Its copilot is the same locked one a
 * personal copy gets and runs as the host — the template's owner — against
 * the sender's budget, within GUEST_COPILOT_LIMITS.
 */

const GUEST_TOKEN = /^[A-Za-z0-9_-]{43}$/

type TemplateSource = { id: string; organizationId: string; userId: string | null; currentVersionId: string | null; title: string; kind: string }

/** The template behind a public link, while the link and the offer are both on. */
async function publicTemplate(token: string): Promise<TemplateSource> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new ApiError('Template not available.', 404, 'NOT_FOUND')
  // systemPrisma: an anonymous visitor has no organization; the lookup is the
  // unique digest of the link's 192-bit token, and only while it is offered.
  const source = await systemPrisma.artifact.findFirst({
    where: { shareTokenDigest: hashToken(token), shareAnonymous: true, shareTemplate: true, archivedAt: null, templateSourceId: null },
    select: { id: true, organizationId: true, userId: true, currentVersionId: true, title: true, kind: true },
  })
  if (!source?.currentVersionId) throw new ApiError('Template not available.', 404, 'NOT_FOUND')
  return source
}

function guestDigestOf(guestToken: string | null | undefined): string | null {
  return guestToken && GUEST_TOKEN.test(guestToken) ? hashToken(guestToken) : null
}

async function findGuestCopy(source: TemplateSource, digest: string | null) {
  if (!digest) return null
  return prisma.artifact.findFirst({ where: { organizationId: source.organizationId, templateSourceId: source.id, guestDigest: digest, userId: null, archivedAt: null }, select: { id: true, agentTaskId: true } })
}

async function guestView(organizationId: string, copyId: string): Promise<GuestCopilotView> {
  const { artifactStatus } = await import('./service')
  await artifactStatus(organizationId, copyId) // settles a finished run's answer into the chat
  const row = await prisma.artifact.findFirst({ where: { id: copyId, organizationId }, select: { id: true, title: true, currentVersionId: true, versionCount: true, chat: true, copilotMcpServers: true } })
  if (!row) throw new ApiError('Template not available.', 404, 'NOT_FOUND')
  const chat = (Array.isArray(row.chat) ? row.chat : []) as unknown as ArtifactChatMessage[]
  const versions = await prisma.artifactVersion.findMany({ where: { artifactId: row.id, organizationId }, orderBy: { number: 'desc' }, take: 20, select: { id: true, number: true, request: true, createdAt: true, executionId: true } })
  return {
    copyId: row.id,
    title: row.title,
    versionId: row.currentVersionId,
    edited: row.versionCount > 1,
    mcpServers: copilotMcpViews(row.copilotMcpServers),
    // No run ids or authors: a guest's history is what changed and when.
    versions: versions.map((version) => ({
      id: version.id,
      number: version.number,
      request: version.number === 1 ? null : version.request,
      createdAt: version.createdAt.toISOString(),
      source: version.request?.startsWith('Restored version') ? 'restore' as const : version.number === 1 ? 'created' as const : 'agent' as const,
    })),
    chat: chat.map((m) => ({
      role: m.role,
      // A failed run's error is the workspace's business, not the visitor's.
      content: m.role === 'agent' && m.status === 'failed' ? 'The copilot could not finish that. Please try again.' : m.content,
      status: m.status,
      createdAt: m.createdAt,
      ...(m.question ? { question: m.question } : {}),
    })),
  }
}

/** The visitor's copy, if their cookie already has one for this link. */
export async function loadGuestCopy(token: string, guestToken: string | null | undefined): Promise<GuestCopilotView | null> {
  const source = await publicTemplate(token)
  const copy = await findGuestCopy(source, guestDigestOf(guestToken))
  return copy ? guestView(source.organizationId, copy.id) : null
}

/** Open the copilot: the visitor's copy, made on first use. Returns the token to keep in their cookie. */
export async function openGuestCopy(token: string, guestToken: string | null | undefined): Promise<{ view: GuestCopilotView; guestToken: string }> {
  const source = await publicTemplate(token)
  const kept = guestDigestOf(guestToken) ? guestToken! : null
  const existing = await findGuestCopy(source, guestDigestOf(kept))
  if (existing) return { view: await guestView(source.organizationId, existing.id), guestToken: kept! }
  // The copilot runs as the template's owner. Without one still active in the
  // workspace there is nobody to host it: the visitor signs in for a copy of
  // their own instead.
  const host = source.userId ? await prisma.user.findFirst({ where: { id: source.userId, organizationId: source.organizationId, isActive: true }, select: { id: true } }) : null
  if (!host) throw new ApiError('Sign in to use the copilot on this template.', 409, 'SIGN_IN_REQUIRED')
  const today = await prisma.artifact.count({ where: { organizationId: source.organizationId, templateSourceId: source.id, guestDigest: { not: null }, createdAt: { gte: startOfUtcDay() } } })
  if (today >= GUEST_COPILOT_LIMITS.copiesPerTemplate) throw new ApiError('This template is busy today. Try again tomorrow, or sign in to use your own copy.', 429, 'GUEST_LIMIT_REACHED')
  const version = await prisma.artifactVersion.findFirst({ where: { id: source.currentVersionId!, artifactId: source.id, organizationId: source.organizationId }, select: { content: true } })
  if (!version) throw new ApiError('The template changed. Reload its link and try again.', 409, 'TEMPLATE_CHANGED')
  const fresh = kept ?? randomBytes(32).toString('base64url')
  const guestDigest = hashToken(fresh)
  const organizationId = source.organizationId
  try {
    const copy = await tenantTransaction(organizationId, async tx => {
      const id = randomUUID()
      const versionId = randomUUID()
      const agent = await tx.agentTask.create({ data: {
        organizationId, userId: host.id, artifactTemplateCopyId: id,
        type: GUEST_COPILOT_AGENT_TYPE, agentType: 'CUSTOM', status: 'ACTIVE', visibility: 'private',
        description: 'Visitor template copilot', objective: TEMPLATE_COPILOT_INSTRUCTIONS,
        schedule: { type: 'manual', isActive: false },
        metadata: { title: 'AI Copilot', model: TEMPLATE_COPILOT_MODEL, integrations: [], skills: [] },
      } })
      const created = await tx.artifact.create({ data: {
        id, organizationId, userId: null, guestDigest, templateSourceId: source.id,
        title: `${source.title.slice(0, 180)} · visitor copy`,
        kind: source.kind === 'roi_dashboard' ? 'page' : source.kind,
        agentTaskId: agent.id, workspaceAccess: 'view',
        currentVersionId: versionId, versionCount: 1,
      }, select: { id: true } })
      await tx.artifactVersion.create({ data: { id: versionId, organizationId, artifactId: id, number: 1, content: version.content, request: 'Created visitor template copy' } })
      return created
    })
    return { view: await guestView(organizationId, copy.id), guestToken: fresh }
  } catch (error) {
    // Two tabs opening at once: the loser's transaction rolls back whole.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const copy = await findGuestCopy(source, guestDigest)
      if (copy) return { view: await guestView(organizationId, copy.id), guestToken: fresh }
    }
    throw error
  }
}

/** A visitor's message to their copy's copilot, within the link's daily limits. */
export async function askGuestCopy(token: string, guestToken: string | null | undefined, message: string): Promise<GuestCopilotView> {
  const source = await publicTemplate(token)
  const guestDigest = guestDigestOf(guestToken)
  const copy = await findGuestCopy(source, guestDigest)
  if (!copy?.agentTaskId || !guestDigest) throw new ApiError('Open the copilot again to continue.', 404, 'NOT_FOUND')
  const organizationId = source.organizationId
  const agent = await prisma.agentTask.findFirst({ where: { id: copy.agentTaskId, organizationId, artifactTemplateCopyId: copy.id, status: 'ACTIVE' }, select: { userId: true } })
  if (!agent?.userId) throw new ApiError('The copilot is no longer available on this template.', 409, 'COPILOT_UNAVAILABLE')
  const since = { gte: startOfUtcDay() }
  const [mine, all] = await Promise.all([
    prisma.agentExecution.count({ where: { organizationId, agentTaskId: copy.agentTaskId, startedAt: since } }),
    prisma.agentExecution.count({ where: { organizationId, startedAt: since, trigger: { path: ['guestTemplateId'], equals: source.id } } }),
  ])
  if (mine >= GUEST_COPILOT_LIMITS.messagesPerVisitor) throw new ApiError('You have reached today’s limit for this copilot. Come back tomorrow, or sign in to keep going in your own workspace.', 429, 'GUEST_LIMIT_REACHED')
  if (all >= GUEST_COPILOT_LIMITS.messagesPerTemplate) throw new ApiError('This template’s copilot is busy today. Try again tomorrow, or sign in to use your own copy.', 429, 'GUEST_LIMIT_REACHED')
  const { askArtifact } = await import('./service')
  try {
    await askArtifact({ organizationId, userId: agent.userId, id: copy.id, message, mode: 'auto', guestDigest })
  } catch (error) {
    const text = error instanceof Error ? error.message : ''
    // Only the visitor's own mistakes are theirs to read.
    throw new ApiError(/^(Wait for the current answer|Type a message first)/.test(text) ? text : 'The copilot is unavailable right now. Please try again.', 400, 'MESSAGE_REJECTED', error)
  }
  return guestView(organizationId, copy.id)
}

/** A visitor's answer to the question their copilot paused on. */
export async function replyGuestCopy(token: string, guestToken: string | null | undefined, message: string): Promise<GuestCopilotView> {
  const source = await publicTemplate(token)
  const guestDigest = guestDigestOf(guestToken)
  const copy = await findGuestCopy(source, guestDigest)
  if (!copy || !guestDigest) throw new ApiError('Open the copilot again to continue.', 404, 'NOT_FOUND')
  const { replyToArtifactQuestion } = await import('./service')
  try {
    await replyToArtifactQuestion({ organizationId: source.organizationId, id: copy.id, message, guestDigest })
  } catch (error) {
    const text = error instanceof Error ? error.message : ''
    throw new ApiError(/^(The assistant is not waiting|Type a message first)/.test(text) ? text.replace('assistant', 'copilot') : 'The copilot is unavailable right now. Please try again.', 400, 'MESSAGE_REJECTED', error)
  }
  return guestView(source.organizationId, copy.id)
}

/** A visitor puts an earlier version of their copy back, as a new version on top (history is kept). */
export async function restoreGuestCopy(token: string, guestToken: string | null | undefined, versionId: string): Promise<GuestCopilotView> {
  const source = await publicTemplate(token)
  const copy = await findGuestCopy(source, guestDigestOf(guestToken))
  if (!copy?.agentTaskId) throw new ApiError('Open the copilot again to continue.', 404, 'NOT_FOUND')
  const organizationId = source.organizationId
  const [row, agent] = await Promise.all([
    prisma.artifact.findFirst({ where: { id: copy.id, organizationId }, select: { chat: true } }),
    prisma.agentTask.findFirst({ where: { id: copy.agentTaskId, organizationId, artifactTemplateCopyId: copy.id }, select: { userId: true } }),
  ])
  if (Array.isArray(row?.chat) && (row.chat as unknown as ArtifactChatMessage[]).some((m) => m.status === 'pending')) throw new ApiError('Wait for the copilot to finish before restoring a version.', 409, 'COPILOT_BUSY')
  // Recorded against the host, who the copy's copilot also runs as.
  if (!agent?.userId) throw new ApiError('The copilot is no longer available on this template.', 409, 'COPILOT_UNAVAILABLE')
  const { restoreVersion } = await import('./service')
  try {
    await restoreVersion({ organizationId, userId: agent.userId, artifactId: copy.id, versionId })
  } catch (error) {
    const text = error instanceof Error ? error.message : ''
    throw new ApiError(/^(That version is already|Version not found)/.test(text) ? text : 'The version could not be restored. Please try again.', 400, 'RESTORE_REJECTED', error)
  }
  return guestView(organizationId, copy.id)
}

/**
 * A visitor connects (or disconnects) their own MCP server for their copy's
 * copilot. The copy is found by the link's token and the visitor's cookie, as
 * everywhere else; the server and its credential are stored on that copy alone.
 */
export async function changeGuestCopyMcp(token: string, guestToken: string | null | undefined, change: { add: CopilotMcpInput } | { remove: string }): Promise<GuestCopilotView> {
  const source = await publicTemplate(token)
  const copy = await findGuestCopy(source, guestDigestOf(guestToken))
  if (!copy) throw new ApiError('Open the copilot again to continue.', 404, 'NOT_FOUND')
  if ('add' in change) await addCopilotMcpServer(source.organizationId, copy.id, change.add)
  else await removeCopilotMcpServer(source.organizationId, copy.id, change.remove)
  return guestView(source.organizationId, copy.id)
}

/** A visitor starts a new chat with their copy's copilot: the conversation is cleared, the copy and its versions stay. */
export async function clearGuestCopyChat(token: string, guestToken: string | null | undefined): Promise<GuestCopilotView> {
  const source = await publicTemplate(token)
  const copy = await findGuestCopy(source, guestDigestOf(guestToken))
  if (!copy) throw new ApiError('Open the copilot again to continue.', 404, 'NOT_FOUND')
  // Settle a finished run's answer first, so "pending" means still working.
  await guestView(source.organizationId, copy.id)
  const { clearArtifactChat } = await import('./service')
  try {
    await clearArtifactChat({ organizationId: source.organizationId, id: copy.id })
  } catch (error) {
    const text = error instanceof Error ? error.message : ''
    throw new ApiError(/^Wait for the current answer/.test(text) ? text : 'A new chat could not be started. Please try again.', 409, 'CHAT_BUSY', error)
  }
  return guestView(source.organizationId, copy.id)
}

/** A visitor tests a server before connecting it: its tools, nothing stored. */
export async function testGuestCopyMcp(token: string, guestToken: string | null | undefined, input: CopilotMcpInput): Promise<{ toolCount: number; toolNames: string[] }> {
  const source = await publicTemplate(token)
  const copy = await findGuestCopy(source, guestDigestOf(guestToken))
  if (!copy) throw new ApiError('Open the copilot again to continue.', 404, 'NOT_FOUND')
  return testCopilotMcpServer(source.organizationId, copy.id, input)
}

/** One version of a guest copy as a page. The copy's id is a 122-bit random value only its visitor was given. */
export async function guestCopyContent(token: string, copyId: string, versionId: string): Promise<{ content: string; kind: string } | null> {
  const source = await publicTemplate(token).catch(() => null)
  if (!source || !/^[0-9a-f-]{36}$/.test(copyId) || !versionId || versionId.length > 64) return null
  const copy = await prisma.artifact.findFirst({ where: { id: copyId, organizationId: source.organizationId, templateSourceId: source.id, guestDigest: { not: null }, userId: null, archivedAt: null }, select: { id: true, kind: true } })
  if (!copy) return null
  const version = await prisma.artifactVersion.findFirst({ where: { id: versionId, artifactId: copy.id, organizationId: source.organizationId }, select: { content: true } })
  return version ? { content: version.content, kind: copy.kind } : null
}
