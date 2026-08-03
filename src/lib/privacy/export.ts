import { ORG_SCOPED_MODELS } from '@/lib/tenant-guard'
import { systemPrisma } from '@/lib/prisma'
import { readStoredFile } from '@/lib/files/storage'

const OMIT_KEYS = new Set([
  'tokenHash', 'keyHash', 'verificationTokenHash', 'peopleAiWebhookSecret',
  'secretConfig', 'authConfig', 'accessToken', 'refreshToken', 'apiKey',
  'webhookSecretHash',
])

function portable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return { encoding: 'base64', data: value.toString('base64') }
  if (Array.isArray(value)) return value.map(portable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !OMIT_KEYS.has(key))
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
