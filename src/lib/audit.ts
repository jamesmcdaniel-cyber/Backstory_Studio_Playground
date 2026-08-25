/**
 * Append-only audit log. Every consequential action (tool write, config
 * change, connection, approval decision) records an immutable AuditEvent.
 * Writing must never break the action it records — failures are swallowed and
 * reported, not thrown.
 */

import crypto from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

export interface AuditInput {
  organizationId: string
  action: string
  actorUserId?: string | null
  actorKind?: 'user' | 'agent' | 'system'
  resourceType?: string | null
  resourceId?: string | null
  tool?: string | null
  executionId?: string | null
  /** Hashed, not stored raw, to keep sensitive tool args out of the log. */
  payload?: unknown
  detail?: Record<string, unknown> | null
  ip?: string | null
}

export function hashPayload(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null
  try {
    return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Which audit action a tool call is, decided by whether the tool WRITES.
 *
 * Shared by the agent loop and the flow runtime so the two cannot drift. Both
 * previously decided this with /^(nango|slack|email|backstory)/i against the
 * PROVIDER name, which was wrong in both directions: every Slack and Gmail read
 * arrives on the `nango` plane and was recorded as `tool.write`, while a
 * genuinely writing MCP tool was recorded as a read.
 *
 * That matters more than a mislabel usually would — audit_events is
 * append-only, is deliberately excluded from the retention sweep, and is the
 * record a compliance question gets answered from. The accurate flag comes from
 * the tool's binding, which the approval gate (src/lib/agents/approval.ts) was
 * already using correctly.
 */
export function toolAuditAction(isWrite: boolean): 'tool.write' | 'tool.call' {
  return isWrite ? 'tool.write' : 'tool.call'
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const row = await prisma.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        action: input.action,
        actorUserId: input.actorUserId ?? null,
        actorKind: input.actorKind ?? 'user',
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        tool: input.tool ?? null,
        executionId: input.executionId ?? null,
        payloadHash: hashPayload(input.payload),
        detail: (input.detail ?? undefined) as never,
        ip: input.ip ?? null,
      },
    })

    // Forward to any destination this workspace configured. AFTER the write, so
    // our own trail is the record of last resort and is already durable; and
    // never throwing, so a customer's misconfigured endpoint cannot turn an
    // audit write into a failure.
    const { enqueueAuditStream } = await import('@/lib/audit/stream-delivery')
    await enqueueAuditStream({
      id: row.id,
      action: row.action,
      organizationId: row.organizationId,
      actorUserId: row.actorUserId,
      actorKind: row.actorKind,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      executionId: row.executionId,
      ip: row.ip,
      createdAt: row.createdAt,
    })
  } catch (error) {
    apiLogger.error('audit write failed', {
      action: input.action,
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { scope: 'audit', action: input.action })
  }
}

/** Serialize audit rows to CSV for export. */
export function auditRowsToCsv(
  rows: Array<{
    createdAt: Date
    action: string
    actorKind: string
    actorUserId: string | null
    tool: string | null
    resourceType: string | null
    resourceId: string | null
    executionId: string | null
    payloadHash: string | null
  }>,
): string {
  const header = ['createdAt', 'action', 'actorKind', 'actorUserId', 'tool', 'resourceType', 'resourceId', 'executionId', 'payloadHash']
  const escape = (value: unknown) => {
    const str = value === null || value === undefined ? '' : String(value)
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
  }
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.createdAt.toISOString(),
        row.action,
        row.actorKind,
        row.actorUserId,
        row.tool,
        row.resourceType,
        row.resourceId,
        row.executionId,
        row.payloadHash,
      ]
        .map(escape)
        .join(','),
    )
  }
  return lines.join('\n')
}
