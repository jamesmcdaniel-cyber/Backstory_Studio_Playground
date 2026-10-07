import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { ReadoutFormatError } from '@/lib/roi/readout-import'
import { importReadout } from '@/lib/roi/readout-service'

export const runtime = 'nodejs'

const MAX_BYTES = 8_000_000

// POST /api/roi/readout — load a value readout (an .html page with its data
// embedded, like Backstory's own) as an account's ROI report: Backstory's
// unless `account` names another. Multipart: `file`, optional `account`.
// Platform operators only, like loading an account's extracts.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`roi-readout:${auth.organizationId}`, { limit: 6, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many readouts loaded at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!file || typeof file === 'string') throw new ApiError('Choose the readout file (its .html page).', 400, 'NO_FILE')
  if (file.size > MAX_BYTES) throw new ApiError('The readout is larger than 8 MB; that is not a value readout page.', 413, 'TOO_LARGE')
  const account = typeof form?.get('account') === 'string' ? String(form.get('account')).trim().slice(0, 200) : ''
  try {
    const imported = await importReadout({ organizationId: auth.organizationId, userId: auth.dbUser.id, html: await file.text(), account: account || undefined })
    return { success: true, ...imported }
  } catch (error) {
    if (error instanceof ReadoutFormatError) throw new ApiError(error.message, 400, 'NOT_A_READOUT')
    throw new ApiError(error instanceof Error ? error.message : 'The readout could not be loaded.', 400, 'IMPORT_FAILED')
  }
}, { permission: 'platform.administer', internalOnly: true })
