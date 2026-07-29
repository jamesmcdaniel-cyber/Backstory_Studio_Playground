import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { createSubmission, SourceNotFoundError, SUBMISSION_KINDS, type SubmissionKind } from '@/lib/catalogue/submissions'

const submitSchema = z.object({
  kind: z.enum(SUBMISSION_KINDS as unknown as [SubmissionKind, ...SubmissionKind[]]),
  sourceId: z.string().min(1),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
})

// The author's own queue: what this workspace has submitted and where it stands.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const submissions = await prisma.catalogueSubmission.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return { success: true, submissions }
}, { permission: 'template.author' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = submitSchema.parse(await request.json())
  try {
    const submission = await createSubmission({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      kind: data.kind,
      sourceId: data.sourceId,
      title: data.title,
      summary: data.summary,
    })
    return { success: true, submission }
  } catch (error) {
    // 404 rather than 403: a 403 would confirm the row exists in some other
    // workspace. Only the not-found case is translated — a real database
    // failure must keep its 500 rather than masquerading as a missing row.
    if (error instanceof SourceNotFoundError) {
      throw new ApiError(error.message, 404, 'NOT_FOUND')
    }
    throw error
  }
}, { permission: 'template.submit' })
