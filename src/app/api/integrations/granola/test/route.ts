import { z } from 'zod'
import { getGranolaApiKey, testGranolaApiKey } from '@/lib/integrations/granola'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

// Tests a Granola API key against a lightweight endpoint (list notes).
// Uses the key from the request body when provided, otherwise the org's
// resolved key (saved key first, env fallback second).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { apiKey } = z
    .object({ apiKey: z.string().trim().min(1).optional() })
    .parse(await request.json().catch(() => ({})))

  let candidate = apiKey
  if (!candidate) {
    const resolved = await getGranolaApiKey(auth.organizationId)
    if (!resolved) {
      throw new ApiError('No Granola API key to test. Paste a key first.', 400, 'NOT_CONFIGURED')
    }
    candidate = resolved.apiKey
  }

  const test = await testGranolaApiKey(candidate)
  if (!test.ok) {
    if (test.status === 401 || test.status === 403) {
      throw new ApiError('Granola rejected that API key. Check the key and try again.', 400, 'INVALID_KEY')
    }
    throw new ApiError('Could not reach Granola to verify the key. Please try again.', 502, 'UPSTREAM_ERROR')
  }

  return { success: true, ok: true }
}, { permission: 'integration.manage' })
