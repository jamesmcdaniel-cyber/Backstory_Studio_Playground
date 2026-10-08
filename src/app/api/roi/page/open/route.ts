import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { openRoiAccount, RoiBusyError } from '@/lib/roi/service'

export const runtime = 'nodejs'

const bodySchema = z.object({
  account: z.string().trim().min(1, 'Pick an account.').max(200),
  /** Take the account report's newer data onto the page. */
  update: z.boolean().optional(),
})

// POST /api/roi/page/open — show an account on the person's own ROI page:
// its latest version there, or — the first time — the account's report put
// on their page in their layout. Never a new artifact. `update` takes the
// report's newer data. Returns needs_build when the account has no report yet.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`roi-open:${auth.organizationId}:${auth.dbUser.id}`, { limit: 30, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many accounts opened at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Pick an account.', 400, 'INVALID_BODY')
  try {
    const result = await openRoiAccount({ organizationId: auth.organizationId, userId: auth.dbUser.id, account: parsed.data.account, update: parsed.data.update === true })
    return { success: true, result }
  } catch (error) {
    if (error instanceof RoiBusyError) throw new ApiError(error.message, 409, 'REPORT_BUSY')
    throw new ApiError(error instanceof Error ? error.message : 'The account could not be opened.', 400, 'OPEN_FAILED')
  }
}, { permission: 'agent.run', internalOnly: true })
