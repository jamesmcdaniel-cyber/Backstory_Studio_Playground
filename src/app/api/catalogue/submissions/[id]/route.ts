import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import type { NextRequest } from 'next/server'

type Context = { params: Promise<{ id: string }> }

// Withdraw: an author pulls back a submission a reviewer has not decided yet.
// Decided rows are immutable — the decision is the record, and the status
// filter is what stops a withdrawal from erasing a rejection.
export const DELETE = withAuthenticatedApi(async (_request: NextRequest, auth, context?: unknown) => {
  const { id } = await (context as Context).params
  const result = await prisma.catalogueSubmission.updateMany({
    where: { id, organizationId: auth.organizationId, status: 'pending' },
    data: { status: 'withdrawn' },
  })
  if (!result.count) throw new ApiError('That submission is not pending.', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'template.submit' })
