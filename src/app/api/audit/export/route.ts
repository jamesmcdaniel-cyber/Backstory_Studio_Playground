import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { auditRowsToCsv } from '@/lib/audit'

export const runtime = 'nodejs'

/**
 * Export this workspace's audit log as CSV (admin-only, org-scoped). Enterprise
 * compliance surface — an immutable record of what agents did.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')

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
