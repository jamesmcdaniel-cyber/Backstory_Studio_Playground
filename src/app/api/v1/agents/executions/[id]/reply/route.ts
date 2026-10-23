import { authenticatePublicApi, publicApiJson } from '@/lib/public-api/auth'
import { rateLimit } from '@/lib/ratelimit'
import { readRequestJsonLimited, RequestBodyError } from '@/lib/server/request-body'
import { ambientOrganization } from '@/lib/tenant-database-context'
import { keepDetachedWorkAlive } from '@/lib/flows/keep-alive'
import { acceptExternalReply, kickSettle } from '@/lib/agents/external/settle'
import { externalReplySchema } from '@/lib/agents/external/schemas'
import { AGENTS_REPLY_SCOPE } from '@/lib/agents/external/types'
import {
  executionIdFromPath,
  externalIngressLimited,
  externalNotFound,
  presentedReplyToken,
  safeLinks,
} from '@/lib/agents/external/public-api'

export const runtime = 'nodejs'

const REPLY_MAX_BODY_BYTES = 256_000

/**
 * POST /api/v1/agents/executions/[id]/reply — an external agent answers a task.
 *
 * Two credentials, both required: the agent's own API key (scope
 * agents:reply, bound to that one agent) and the task's single-use reply
 * token. The token is consumed atomically with the durable handoff that
 * resumes the run, so the reply cannot be applied twice and cannot be lost.
 * Unknown execution, another agent's execution, a wrong, reused or expired
 * token: one indistinguishable 404.
 *
 * The run then completes through the normal path — the Slack thread gets the
 * answer posted as the teammate, a flow continues with the output, a chat
 * shows it. 202: completion is asynchronous.
 */
export async function POST(request: Request) {
  const flooded = await externalIngressLimited(request, 'reply', 120)
  if (flooded) return flooded
  const auth = await authenticatePublicApi(request, AGENTS_REPLY_SCOPE)
  if (auth instanceof Response) return auth
  const perKey = await rateLimit(`external-agent-reply-key:${auth.keyId}`, { limit: 120, windowMs: 60_000, failureMode: 'closed' })
  if (!perKey.ok) return publicApiJson({ error: { code: 'RATE_LIMITED', message: 'Too many replies.' } }, 429)

  let raw: unknown
  try {
    raw = await readRequestJsonLimited(request, REPLY_MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyError) return publicApiJson({ error: { code: error.code, message: error.message } }, error.status)
    throw error
  }
  const parsed = externalReplySchema.safeParse(raw)
  if (!parsed.success) {
    return publicApiJson({ error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'Invalid reply body.' } }, 400)
  }
  const body = parsed.data
  const token = presentedReplyToken(request, body)
  const executionId = executionIdFromPath(request, true)
  if (!token || !executionId) return externalNotFound()

  const output = body.status === 'failed'
    ? (body.error || body.output || 'The agent reported that it could not complete the task.').trim()
    : body.output
  const settleId = await ambientOrganization.run(auth.organizationId, () =>
    acceptExternalReply({
      organizationId: auth.organizationId,
      apiKeyId: auth.keyId,
      executionId,
      presentedToken: token,
      reply: { status: body.status, output, links: safeLinks([...(body.links ?? []), ...(body.artifacts ?? [])]) },
    }),
  )
  if (!settleId) return externalNotFound()

  // Finish now when possible; the outbox retries anything this does not.
  keepDetachedWorkAlive(ambientOrganization.run(auth.organizationId, () => kickSettle(settleId)))
  return publicApiJson({ data: { executionId, accepted: true, status: 'completing' } }, 202)
}
