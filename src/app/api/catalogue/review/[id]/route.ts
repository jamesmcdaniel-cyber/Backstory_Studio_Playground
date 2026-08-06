import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { publishSubmission, resolveInternalOrgId } from '@/lib/catalogue/publish'
import { recordAudit } from '@/lib/audit'
import { notify } from '@/lib/notifications/service'
import { sendEmail } from '@/lib/integrations/email'
import { buildDecisionEmail } from '@/lib/catalogue/decision-email'
import type { NextRequest } from 'next/server'

type Context = { params: Promise<{ id: string }> }

const decisionSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested', 'rejected']),
    note: z.string().max(2000).optional(),
  })
  .refine((value) => value.decision === 'approved' || Boolean(value.note?.trim()), {
    message: 'Explain what needs to change so the author can act on it.',
    path: ['note'],
  })

export const POST = withAuthenticatedApi(async (request: NextRequest, auth, context?: unknown) => {
  const { id } = await (context as Context).params
  const data = decisionSchema.parse(await request.json())

  // Conditional on status='pending': two reviewers deciding at once cannot both
  // win, so an entry is never double-published.
  const claimed = await systemPrisma.catalogueSubmission.updateMany({
    where: { id, status: 'pending' },
    data: {
      status: data.decision,
      reviewNote: data.note ?? null,
      reviewerUserId: auth.dbUser.id,
      decidedAt: new Date(),
    },
  })
  if (!claimed.count) throw new ApiError('That submission has already been decided.', 409, 'ALREADY_DECIDED')

  const submission = await systemPrisma.catalogueSubmission.findUnique({ where: { id } })
  let publishedEntryId: string | null = null

  if (data.decision === 'approved') {
    const internalOrgId = await resolveInternalOrgId()
    try {
      ;({ publishedEntryId } = await publishSubmission({
        submissionId: id,
        reviewerUserId: auth.dbUser.id,
        internalOrgId,
      }))
      await systemPrisma.catalogueSubmission.update({ where: { id }, data: { publishedEntryId } })
    } catch (error) {
      // Publishing failed after the claim: return the row to pending so the
      // decision can be retried rather than stranding it approved-but-unpublished.
      await systemPrisma.catalogueSubmission.update({
        where: { id },
        data: { status: 'pending', decidedAt: null, reviewerUserId: null },
      })
      throw new ApiError('Publishing failed; the submission is still pending.', 500, 'PUBLISH_FAILED', error)
    }
  }

  await recordAudit({
    organizationId: auth.organizationId,
    action: `catalogue.${data.decision}`,
    actorUserId: auth.dbUser.id,
    resourceType: submission?.kind ?? null,
    resourceId: publishedEntryId ?? id,
    detail: { submissionId: id, submittingOrgId: submission?.organizationId ?? null },
  })

  if (submission) {
    const titles: Record<typeof data.decision, string> = {
      approved: `"${submission.title}" is published to the catalogue`,
      changes_requested: `"${submission.title}" needs changes`,
      rejected: `"${submission.title}" was not accepted to the catalogue`,
    }
    await notify({
      organizationId: submission.organizationId,
      userId: submission.submittedByUserId,
      type: 'catalogue.decision',
      level: data.decision === 'approved' ? 'success' : data.decision === 'rejected' ? 'error' : 'action',
      title: titles[data.decision],
      body: data.note ?? 'Your submission was approved and is now in the shared catalogue.',
      link: '/templates',
    })

    // Best-effort: the decision stands whether or not the email lands.
    if (submission.submittedByUserId) {
      try {
        const author = await systemPrisma.user.findUnique({
          where: { id: submission.submittedByUserId },
          select: { email: true, isActive: true },
        })
        if (author?.isActive && author.email) {
          const appUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, '')
          const email = buildDecisionEmail({
            decision: data.decision,
            title: submission.title,
            note: data.note,
            appUrl,
          })
          await sendEmail({ to: author.email, ...email })
        }
      } catch {
        // Email delivery failed — the in-app notification above still lands.
      }
    }
  }

  return { success: true, status: data.decision, publishedEntryId }
}, { permission: 'catalogue.publish', internalOnly: true })
