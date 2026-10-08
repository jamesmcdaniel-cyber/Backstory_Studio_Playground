import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { auditRowsToCsv } from '@/lib/audit'

export const runtime = 'nodejs'

/**
 * Export this workspace's audit log as CSV (admin-only, org-scoped). Enterprise
 * compliance surface — an immutable record of what agents did.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  // Exports are the expensive reads: a full-table scan serialized into one
  // response. One budget across every export route, per user.
  const limited = await rateLimit(`export:${auth.userId}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many exports — wait a minute and try again.', 429, 'RATE_LIMITED')

  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 5000, 20000)
  const rows = await prisma.auditEvent.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      createdAt: true,
      action: true,
      actorKind: true,
      actorUserId: true,
      tool: true,
      resourceType: true,
      resourceId: true,
      executionId: true,
      payloadHash: true,
    },
  })

  const csv = auditRowsToCsv(rows)
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="backstory-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}, { permission: 'audit.read' })
