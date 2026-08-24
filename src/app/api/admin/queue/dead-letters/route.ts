import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import {
  DEAD_LETTER_QUEUES,
  DeadLetterOperationError,
  countDeadLetters,
  dropDeadLetter,
  listDeadLetters,
  replayDeadLetter,
  showDeadLetter,
} from '@/lib/queue/dead-letter-admin'

/**
 * Operator read/repair surface over the dead-letter queues. `npm run queue:dlq`
 * is still the primary path mid-incident (it needs only REDIS_URL and a
 * terminal), but this route also backs /admin/queue — the page the queue-plane
 * alert links to, for the operator who just got the notification and does not
 * have production secrets to hand. See docs/runbooks/queue-incident.md.
 *
 * Internal edition only, `platform.administer`: a dead-lettered payload is the
 * raw job data of some workspace's run, so this reaches across every tenant for
 * the same reason /api/admin/costs does.
 */

const postSchema = z.object({
  action: z.enum(['replay', 'drop']),
  id: z.string().min(1).max(200),
  /**
   * Both actions are destructive (a replay re-runs a job with external side
   * effects; a drop discards the only durable record of a failure), so the
   * caller must say so explicitly — the same rule the CLI enforces with
   * --confirm.
   */
  confirm: z.literal(true),
})

function asApiError(error: unknown): never {
  if (error instanceof DeadLetterOperationError) {
    throw new ApiError(error.message, error.status, error.code)
  }
  throw error
}

export const GET = withAuthenticatedApi(async (request) => {
  const params = request.nextUrl.searchParams
  const id = params.get('id')

  try {
    if (id) {
      return { success: true, deadLetter: await showDeadLetter(id) }
    }

    const dlq = params.get('queue') ?? undefined
    const limit = Number(params.get('limit')) || undefined
    const [counts, deadLetters] = await Promise.all([
      countDeadLetters(),
      listDeadLetters({ dlq, limit }),
    ])
    return { success: true, queues: DEAD_LETTER_QUEUES, counts, deadLetters }
  } catch (error) {
    asApiError(error)
  }
}, { permission: 'platform.administer', internalOnly: true })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = postSchema.parse(await request.json())

  try {
    if (body.action === 'replay') {
      const result = await replayDeadLetter(body.id)
      await recordAudit({
        organizationId: auth.organizationId,
        action: 'platform.dead_letter_replayed',
        actorUserId: auth.dbUser.id,
        resourceType: 'dead_letter',
        resourceId: body.id,
        detail: { queue: result.queue, jobName: result.jobName, newJobId: result.newJobId },
      })
      return { success: true, replayed: result }
    }

    const result = await dropDeadLetter(body.id)
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'platform.dead_letter_dropped',
      actorUserId: auth.dbUser.id,
      resourceType: 'dead_letter',
      resourceId: body.id,
    })
    return { success: true, dropped: result }
  } catch (error) {
    asApiError(error)
  }
}, { permission: 'platform.administer', internalOnly: true })
