import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Recent inbound People.ai signals for this workspace, with the runs each one
// triggered (provenance both ways: signal → runs, and the signal's source URL).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 100)
  const signals = await prisma.signal.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { receivedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      accountId: true,
      opportunityId: true,
      stakeholderId: true,
      provenanceUrl: true,
      receivedAt: true,
      processedAt: true,
      _count: { select: { subscriptionRuns: true } },
    },
  })
  return { success: true, signals }
}, { permission: 'agent.read' })
