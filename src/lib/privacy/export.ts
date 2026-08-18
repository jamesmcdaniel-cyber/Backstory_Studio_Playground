import { ORG_SCOPED_MODELS } from '@/lib/tenant-guard'
import { systemPrisma } from '@/lib/prisma'
import { readStoredFile } from '@/lib/files/storage'

/**
 * Credential-bearing columns, named explicitly.
 *
 * This list alone was the whole boundary once, and it failed the way any
 * hand-kept denylist fails: `Flow.shareToken` — a live, non-expiring token that
 * opens a flow from ANOTHER workspace, or with no session at all — was never on
 * it, so every export shipped working share links while its own manifest said
 * `secretsIncluded: false`. (That column now stores a digest, and its successor
 * `shareTokenDigest` is listed below for the same reason: a digest is still a
 * credential-shaped value nobody is owed in an export.) `AgentTask.metadata.triggerSecret` and
 * `OrganizationDomain.verificationToken` had the same gap.
 *
 * The convention rule below is what actually holds the line now; this set
 * covers names the convention would miss.
 */
const OMIT_KEYS = new Set([
  'tokenHash', 'keyHash', 'verificationTokenHash', 'peopleAiWebhookSecret',
  'secretConfig', 'authConfig', 'accessToken', 'refreshToken', 'apiKey',
  'webhookSecretHash', 'shareTokenDigest', 'verificationToken', 'resumeTokenHash',
  'triggerSecret',
])

/**
 * Anything NAMED like a credential is omitted even if nobody remembered to add
 * it above — so a new secret column is safe by default rather than safe only if
 * someone edits this file. `export-secrets.test.ts` walks the Prisma schema and
 * fails when a field escapes both this rule and the list above.
 */
const SECRET_KEY_PATTERN = /(token|secret|password|passphrase|credential|api[-_]?key|privatekey)/i

/**
 * Token COUNTERS, which are usage data a customer is entitled to and merely
 * happen to contain the word "token". Kept explicit so the pattern above can
 * stay broad.
 */
export const NOT_SECRET_KEYS = new Set([
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'totalTokens', 'tokenCount', 'maxTokens',
])

/** Whether this key must never appear in an export. */
export function isOmittedExportKey(key: string): boolean {
  if (NOT_SECRET_KEYS.has(key)) return false
  return OMIT_KEYS.has(key) || SECRET_KEY_PATTERN.test(key)
}

function portable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return { encoding: 'base64', data: value.toString('base64') }
  if (Array.isArray(value)) return value.map(portable)
  if (value && typeof value === 'object') {
    // Recursive, so a secret nested inside a Json column (AgentTask.metadata's
    // legacy plaintext triggerSecret) is filtered at whatever depth it sits.
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isOmittedExportKey(key))
      .map(([key, item]) => [key, portable(item)]))
  }
  return value
}

const propertyOf = (model: string) => model.charAt(0).toLowerCase() + model.slice(1)

/**
 * Complete, streaming NDJSON export. Secrets are intentionally omitted, but
 * all customer-authored records and original file bytes are included. Each
 * line is independent so a multi-gigabyte workspace never accumulates in RAM.
 */
export function organizationExportStream(organizationId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, data: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify({ type, data: portable(data) })}\n`))
      try {
        emit('manifest', { format: 'backstory.ndjson.v1', organizationId, exportedAt: new Date(), secretsIncluded: false })
        const organization = await systemPrisma.organization.findUnique({ where: { id: organizationId } })
        if (organization) emit('Organization', organization)
        for (const user of await systemPrisma.user.findMany({ where: { organizationId }, orderBy: { id: 'asc' } })) emit('User', user)

        for (const model of [...ORG_SCOPED_MODELS].sort()) {
          // PlatformAllowedDomain is platform config that merely POINTS at this
          // workspace; its rows carry internal operator notes and the staff user
          // who granted access. Exporting it would hand a customer our access
          // administration, so it is skipped despite carrying an organizationId.
          if (model === 'PlatformAllowedDomain') continue
          // LlmCall is internal cost accounting: high-volume per-call rows
          // carrying our price-table version, not customer-authored content.
          // Cost is deliberately not a customer-facing surface.
          if (model === 'LlmCall') continue
          const delegate = (systemPrisma as unknown as Record<string, { findMany(args: unknown): Promise<Array<{ id: string }>> }>)[propertyOf(model)]
          if (!delegate) continue
          let cursor: string | undefined
          do {
            const rows = await delegate.findMany({ where: { organizationId }, orderBy: { id: 'asc' }, take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) })
            for (const row of rows) emit(model, model === 'StoredFile' ? { ...row, data: undefined } : row)
            cursor = rows.length === 500 ? rows.at(-1)?.id : undefined
          } while (cursor)
        }

        // Transitively tenant-owned tables without their own organizationId.
        const children = await Promise.all([
          systemPrisma.executionMessage.findMany({ where: { execution: { organizationId } } }),
          systemPrisma.workflowStep.findMany({ where: { execution: { organizationId } } }),
          systemPrisma.workflowEvent.findMany({ where: { execution: { organizationId } } }),
          systemPrisma.flowRunStep.findMany({ where: { run: { organizationId } } }),
          systemPrisma.flowCollaborator.findMany({ where: { flow: { organizationId } } }),
        ])
        for (const [index, rows] of children.entries()) {
          const type = ['ExecutionMessage', 'WorkflowStep', 'WorkflowEvent', 'FlowRunStep', 'FlowCollaborator'][index]
          for (const row of rows) emit(type, row)
        }

        const files = await systemPrisma.storedFile.findMany({ where: { organizationId }, select: { id: true } })
        for (const file of files) {
          const content = await readStoredFile(file.id, organizationId)
          if (content) emit('StoredFileContent', { id: file.id, filename: content.filename, mimeType: content.mimeType, base64: content.buffer.toString('base64') })
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}
