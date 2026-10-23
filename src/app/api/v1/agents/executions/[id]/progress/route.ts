import { authenticatePublicApi, publicApiJson } from '@/lib/public-api/auth'
import { rateLimit } from '@/lib/ratelimit'
import { readRequestJsonLimited, RequestBodyError } from '@/lib/server/request-body'
import { ambientOrganization } from '@/lib/tenant-database-context'
import { recordExternalProgress, verifyReplyCapability } from '@/lib/agents/external/settle'
import { externalProgressSchema } from '@/lib/agents/external/schemas'
import { AGENTS_REPLY_SCOPE } from '@/lib/agents/external/types'
import { executionIdFromPath, externalIngressLimited, externalNotFound, presentedReplyToken } from '@/lib/agents/external/public-api'

export const runtime = 'nodejs'

const PROGRESS_MAX_BODY_BYTES = 8_000

/**
 * POST /api/v1/agents/executions/[id]/progress — an interim status line
 * ("Pulled the account history, drafting now"), narrated live in the run's
 * feed. Same two credentials as a reply; the token is checked, not consumed.
 * Bounded per run (30 a minute, 200 in all).
 */
export async function POST(request: Request) {
  const flooded = await externalIngressLimited(request, 'progress', 240)
  if (flooded) return flooded
  const auth = await authenticatePublicApi(request, AGENTS_REPLY_SCOPE)
  if (auth instanceof Response) return auth

  let raw: unknown
  try {
    raw = await readRequestJsonLimited(request, PROGRESS_MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyError) return publicApiJson({ error: { code: error.code, message: error.message } }, error.status)
    throw error
  }
  const parsed = externalProgressSchema.safeParse(raw)
  if (!parsed.success) {
    return publicApiJson({ error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'Invalid progress body.' } }, 400)
  }
  const token = presentedReplyToken(request, parsed.data)
  const executionId = executionIdFromPath(request, true)
  if (!token || !executionId) return externalNotFound()

  return ambientOrganization.run(auth.organizationId, async () => {
    const capability = await verifyReplyCapability({ organizationId: auth.organizationId, apiKeyId: auth.keyId, executionId, presentedToken: token })
    if (!capability) return externalNotFound()
    const perRun = await rateLimit(`external-agent-progress:${capability.executionId}`, { limit: 30, windowMs: 60_000, failureMode: 'closed' })
    if (!perRun.ok) return publicApiJson({ error: { code: 'RATE_LIMITED', message: 'Too many progress updates for this task.' } }, 429)
    const recorded = await recordExternalProgress({ executionId: capability.executionId, text: parsed.data.message })
    if (!recorded) return publicApiJson({ error: { code: 'PROGRESS_LIMIT', message: 'This task already has the most progress updates it can keep.' } }, 429)
    return publicApiJson({ data: { executionId: capability.executionId, recorded: true } }, 202)
  })
}
