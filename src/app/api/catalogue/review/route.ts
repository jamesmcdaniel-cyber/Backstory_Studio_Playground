import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// The reviewer queue. systemPrisma: this read crosses tenants BY DESIGN — the
// queue's whole purpose is seeing other workspaces' submissions. The
// catalogue.review permission is what makes it safe, and only a reviewer
// inside an internal org holds it.
export const GET = withAuthenticatedApi(async (request) => {
  const status = request.nextUrl.searchParams.get('status') ?? 'pending'
  const submissions = await systemPrisma.catalogueSubmission.findMany({
    where: { status },
    orderBy: { createdAt: 'asc' },
    take: 200,
    // The submitting workspace rides along because ANY workspace may now
    // propose an entry: whether this came from staff or from an outside
    // customer changes how hard a reviewer looks, so it must be on screen.
    include: { organization: { select: { name: true, kind: true } } },
  })
  return { success: true, submissions }
}, { permission: 'catalogue.review', internalOnly: true })
