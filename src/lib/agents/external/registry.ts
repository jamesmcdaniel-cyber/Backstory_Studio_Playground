/**
 * Registering and managing an external agent.
 *
 * Registration creates, in one transaction:
 *   - the AgentTask the rest of the platform sees (agentType EXTERNAL) — it is
 *     on the roster, @mentionable in Slack, pickable in a flow agent step and
 *     reachable from its Assistant chat like any teammate;
 *   - an ApiKey carrying ONLY `agents:reply`, bound to this agent by the
 *     ExternalAgent relation (a key answers only its own agent's tasks);
 *   - the ExternalAgent row: the SSRF-checked webhook and the encrypted
 *     signing secret.
 * The signing secret and the key's client secret are returned once and never
 * again; rotation replaces either and returns the new one once.
 */

import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { encryptSecret } from '@/lib/crypto/secrets'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { ApiError } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { recordCredentialGrant, recordCredentialRotation } from '@/lib/credentials/audit'
import { MAX_TOKEN_LIFETIME_DAYS } from '@/lib/credentials/lifetime'
import { mintClientCredentials } from '@/lib/public-api/client-credentials'
import { mintSigningSecret } from './signing'
import {
  AGENTS_REPLY_SCOPE,
  EXTERNAL_AGENT_TYPE,
  EXTERNAL_TIMEOUT_DEFAULT_MINUTES,
  WAITING_FOR_EXTERNAL,
  webhookHostOf,
  type ExternalAgentSecrets,
  type ExternalAgentView,
} from './types'

/** The reply key lives as long as a minted token may (one year), then rotates. */
const KEY_LIFETIME_MS = (MAX_TOKEN_LIFETIME_DAYS - 1) * 24 * 60 * 60 * 1000

/** Refuse a webhook the SSRF guard will not deliver to, with the reason. */
export async function assertDeliverableWebhook(url: string): Promise<void> {
  try {
    await assertPublicUrl(url)
  } catch (error) {
    if (error instanceof SsrfError) {
      throw new ApiError(`The webhook must be a public https URL — ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}.`, 400, 'WEBHOOK_NOT_ALLOWED')
    }
    throw error
  }
}

type ExternalRow = Prisma.ExternalAgentGetPayload<{ include: { agentTask: true; apiKey: true } }>

export function serializeExternalAgent(row: ExternalRow): ExternalAgentView {
  const title = (row.agentTask.metadata as { title?: unknown } | null)?.title
  return {
    id: row.id,
    agentId: row.agentTaskId,
    name: typeof title === 'string' && title ? title : row.agentTask.description,
    webhookUrl: row.webhookUrl,
    webhookHost: webhookHostOf(row.webhookUrl),
    capabilities: row.capabilities,
    replyTimeoutMinutes: row.replyTimeoutMinutes,
    enabled: row.agentTask.status === 'ACTIVE',
    signingSecretRotatedAt: row.signingSecretRotatedAt?.toISOString() ?? null,
    apiKey: row.apiKey
      ? { id: row.apiKey.id, clientId: row.apiKey.clientId, expiresAt: row.apiKey.expiresAt?.toISOString() ?? null, revoked: Boolean(row.apiKey.revokedAt) }
      : null,
    lastDelivery: row.lastDeliveryAt && (row.lastDeliveryStatus === 'delivered' || row.lastDeliveryStatus === 'failed')
      ? { at: row.lastDeliveryAt.toISOString(), status: row.lastDeliveryStatus, error: row.lastDeliveryError }
      : null,
    lastReplyAt: row.lastReplyAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function loadExternalAgent(organizationId: string, agentId: string) {
  return prisma.externalAgent.findFirst({
    where: { organizationId, agentTaskId: agentId, agentTask: { status: { not: 'DELETED' } } },
    include: { agentTask: true, apiKey: true },
  })
}

function mintReplyKey(organizationId: string, userId: string, name: string) {
  const { clientId, clientSecret, clientSecretHash } = mintClientCredentials()
  const expiresAt = new Date(Date.now() + KEY_LIFETIME_MS)
  return {
    secret: { clientId, clientSecret, tokenUrl: '/api/v1/token', expiresAt: expiresAt.toISOString() },
    data: {
      organizationId,
      userId,
      name: `External agent: ${name}`.slice(0, 80),
      scopes: [AGENTS_REPLY_SCOPE],
      expiresAt,
      clientId,
      keyHash: clientSecretHash,
      prefix: clientId.slice(0, 12),
    },
  }
}

export type RegisterExternalAgentInput = {
  name: string
  roleLabel?: string | null
  description?: string | null
  avatarSeed?: string | null
  webhookUrl: string
  capabilities?: string | null
  replyTimeoutMinutes?: number
}

export async function registerExternalAgent(params: {
  organizationId: string
  actorUserId: string
  input: RegisterExternalAgentInput
}): Promise<{ view: ExternalAgentView; secrets: Required<ExternalAgentSecrets> }> {
  const { organizationId, actorUserId, input } = params
  await assertDeliverableWebhook(input.webhookUrl)
  const signingSecret = mintSigningSecret()
  const key = mintReplyKey(organizationId, actorUserId, input.name)
  const description = input.description?.trim() || `${input.name} works outside Backstory and answers the tasks it is sent.`
  const row = await tenantTransaction(organizationId, async (tx) => {
    const agent = await tx.agentTask.create({
      data: {
        type: 'agent',
        agentType: EXTERNAL_AGENT_TYPE,
        description,
        // What a Run with no typed input sends: the job the admin described.
        objective: input.capabilities?.trim() || description,
        context: {},
        schedule: { type: 'manual', timezone: 'UTC', isActive: false },
        status: 'ACTIVE',
        visibility: 'shared',
        organizationId,
        userId: actorUserId,
        metadata: {
          title: input.name,
          description,
          ...(input.roleLabel?.trim() ? { roleLabel: input.roleLabel.trim() } : {}),
          ...(input.avatarSeed?.trim() ? { avatarSeed: input.avatarSeed.trim() } : {}),
          integrations: [],
          skills: [],
          icon: '',
        },
      },
    })
    const apiKey = await tx.apiKey.create({ data: key.data, select: { id: true } })
    return tx.externalAgent.create({
      data: {
        organizationId,
        agentTaskId: agent.id,
        webhookUrl: input.webhookUrl,
        signingSecretCiphertext: encryptSecret(signingSecret),
        apiKeyId: apiKey.id,
        capabilities: input.capabilities?.trim() || null,
        replyTimeoutMinutes: input.replyTimeoutMinutes ?? EXTERNAL_TIMEOUT_DEFAULT_MINUTES,
        createdById: actorUserId,
      },
      include: { agentTask: true, apiKey: true },
    })
  })
  await recordCredentialGrant({
    organizationId,
    kind: 'api_key',
    credentialId: row.apiKeyId!,
    provider: 'backstory_api',
    ownerUserId: actorUserId,
    actorUserId,
    scopes: [AGENTS_REPLY_SCOPE],
    method: 'external_agent_registration',
  })
  await recordCredentialGrant({
    organizationId,
    kind: 'external_agent',
    credentialId: row.id,
    provider: webhookHostOf(row.webhookUrl),
    actorUserId,
    method: 'external_agent_registration',
  })
  await recordAudit({
    organizationId,
    action: 'agent.external_registered',
    actorUserId,
    resourceType: 'agent',
    resourceId: row.agentTaskId,
    detail: { webhookHost: webhookHostOf(row.webhookUrl), replyTimeoutMinutes: row.replyTimeoutMinutes },
  })
  return { view: serializeExternalAgent(row), secrets: { signingSecret, apiKey: key.secret } }
}

export async function updateExternalAgent(params: {
  organizationId: string
  actorUserId: string
  agentId: string
  patch: Partial<Pick<RegisterExternalAgentInput, 'name' | 'roleLabel' | 'description' | 'avatarSeed' | 'webhookUrl' | 'capabilities' | 'replyTimeoutMinutes'>> & { enabled?: boolean }
}): Promise<ExternalAgentView> {
  const { organizationId, agentId, patch } = params
  const existing = await loadExternalAgent(organizationId, agentId)
  if (!existing) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  if (patch.webhookUrl !== undefined && patch.webhookUrl !== existing.webhookUrl) await assertDeliverableWebhook(patch.webhookUrl)
  const metadata = { ...((existing.agentTask.metadata as Record<string, unknown> | null) ?? {}) }
  if (patch.name !== undefined) metadata.title = patch.name
  if (patch.description !== undefined) metadata.description = patch.description?.trim() || ''
  if (patch.roleLabel !== undefined) {
    if (patch.roleLabel?.trim()) metadata.roleLabel = patch.roleLabel.trim()
    else delete metadata.roleLabel
  }
  if (patch.avatarSeed !== undefined) {
    if (patch.avatarSeed?.trim()) metadata.avatarSeed = patch.avatarSeed.trim()
    else delete metadata.avatarSeed
  }
  await tenantTransaction(organizationId, async (tx) => {
    await tx.agentTask.update({
      where: { id: agentId, organizationId },
      data: {
        metadata: metadata as Prisma.InputJsonValue,
        ...(patch.description !== undefined && patch.description?.trim() ? { description: patch.description.trim() } : {}),
        ...(patch.capabilities !== undefined && patch.capabilities?.trim() ? { objective: patch.capabilities.trim() } : {}),
        ...(patch.enabled !== undefined ? { status: patch.enabled ? 'ACTIVE' : 'PAUSED' } : {}),
      },
    })
    await tx.externalAgent.update({
      where: { id: existing.id, organizationId },
      data: {
        ...(patch.webhookUrl !== undefined ? { webhookUrl: patch.webhookUrl } : {}),
        ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities?.trim() || null } : {}),
        ...(patch.replyTimeoutMinutes !== undefined ? { replyTimeoutMinutes: patch.replyTimeoutMinutes } : {}),
      },
    })
  })
  await recordAudit({
    organizationId,
    action: patch.enabled === false ? 'agent.external_disabled' : patch.enabled === true ? 'agent.external_enabled' : 'agent.external_updated',
    actorUserId: params.actorUserId,
    resourceType: 'agent',
    resourceId: agentId,
    detail: { fields: Object.keys(patch), ...(patch.webhookUrl ? { webhookHost: webhookHostOf(patch.webhookUrl) } : {}) },
  })
  const fresh = await loadExternalAgent(organizationId, agentId)
  return serializeExternalAgent(fresh!)
}

/** Revoke a reply key and every access token minted from it, in one breath. */
async function revokeReplyKey(tx: Prisma.TransactionClient, organizationId: string, apiKeyId: string) {
  const now = new Date()
  await tx.apiKey.updateMany({ where: { id: apiKeyId, organizationId, revokedAt: null }, data: { revokedAt: now } })
  await tx.apiAccessToken.updateMany({ where: { apiKeyId, organizationId, revokedAt: null }, data: { revokedAt: now } })
}

export async function rotateExternalAgentCredential(params: {
  organizationId: string
  actorUserId: string
  agentId: string
  credential: 'signing_secret' | 'api_key'
}): Promise<{ view: ExternalAgentView; secrets: ExternalAgentSecrets }> {
  const { organizationId, actorUserId, agentId } = params
  const existing = await loadExternalAgent(organizationId, agentId)
  if (!existing) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  const name = serializeExternalAgent(existing).name
  let secrets: ExternalAgentSecrets
  if (params.credential === 'signing_secret') {
    const signingSecret = mintSigningSecret()
    await prisma.externalAgent.update({
      where: { id: existing.id, organizationId },
      data: { signingSecretCiphertext: encryptSecret(signingSecret), signingSecretRotatedAt: new Date() },
    })
    await recordCredentialRotation({ organizationId, kind: 'external_agent', credentialId: existing.id, provider: webhookHostOf(existing.webhookUrl), actorUserId, reason: 'rotated_by_user' })
    secrets = { signingSecret }
  } else {
    const key = mintReplyKey(organizationId, actorUserId, name)
    const apiKeyId = await tenantTransaction(organizationId, async (tx) => {
      if (existing.apiKeyId) await revokeReplyKey(tx, organizationId, existing.apiKeyId)
      const created = await tx.apiKey.create({ data: key.data, select: { id: true } })
      await tx.externalAgent.update({ where: { id: existing.id, organizationId }, data: { apiKeyId: created.id } })
      return created.id
    })
    await recordCredentialRotation({
      organizationId,
      kind: 'api_key',
      credentialId: apiKeyId,
      provider: 'backstory_api',
      ownerUserId: actorUserId,
      actorUserId,
      scopes: [AGENTS_REPLY_SCOPE],
      reason: 'rotated_by_user',
    })
    secrets = { apiKey: key.secret }
  }
  const fresh = await loadExternalAgent(organizationId, agentId)
  return { view: serializeExternalAgent(fresh!), secrets }
}

/**
 * Remove an external agent: its key and tokens revoked, its endpoint and
 * secret deleted, its AgentTask soft-deleted like any agent — and every task
 * still waiting on it failed, so no Slack thread or flow is left hanging.
 */
export async function removeExternalAgent(params: { organizationId: string; actorUserId: string; agentId: string }): Promise<void> {
  const { organizationId, actorUserId, agentId } = params
  const existing = await loadExternalAgent(organizationId, agentId)
  if (!existing) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  const name = serializeExternalAgent(existing).name
  await tenantTransaction(organizationId, async (tx) => {
    if (existing.apiKeyId) await revokeReplyKey(tx, organizationId, existing.apiKeyId)
    await tx.agentTask.update({ where: { id: agentId, organizationId }, data: { status: 'DELETED', deletedAt: new Date() } })
    await tx.externalAgent.delete({ where: { id: existing.id, organizationId } })
  })
  if (existing.apiKeyId) {
    await recordAudit({
      organizationId,
      action: 'credential.revoked',
      actorUserId,
      resourceType: 'api_key',
      resourceId: existing.apiKeyId,
      detail: { provider: 'backstory_api', reason: 'external_agent_removed' },
    })
  }
  await recordAudit({ organizationId, action: 'agent.external_removed', actorUserId, resourceType: 'agent', resourceId: agentId, detail: { webhookHost: webhookHostOf(existing.webhookUrl) } })

  const waiting = await prisma.agentExecution.findMany({
    where: { organizationId, agentTaskId: agentId, status: WAITING_FOR_EXTERNAL },
    select: { id: true },
    take: 200,
  })
  const { settleExternalExecution, kickSettle } = await import('./settle')
  for (const execution of waiting) {
    const settleId = await settleExternalExecution({
      organizationId,
      executionId: execution.id,
      reply: { status: 'failed', output: `${name} was removed from this workspace before it replied.`, links: [], source: 'removed' },
    })
    if (settleId) await kickSettle(settleId)
  }
}

