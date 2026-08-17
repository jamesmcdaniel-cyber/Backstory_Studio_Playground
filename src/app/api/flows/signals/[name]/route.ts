import type { NextRequest } from 'next/server'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { emitFlowSignal } from '@/features/flows/signals'

export const runtime = 'nodejs'
export const maxDuration = 1800

// Signal fan-out endpoint: fires `name` to every ACTIVE, published, listening
// flow in the caller's org. The request body (if JSON) becomes the payload
// each matching flow receives as its run input.
export const POST = withAuthenticatedApi(async (request: NextRequest, auth) => {
  const name = decodeURIComponent(request.nextUrl.pathname.split('/').at(-1) ?? '')
  if (!name || name.length > 100) {
    throw new ApiError('Signal name must be non-blank and at most 100 characters', 400, 'INVALID_SIGNAL_NAME')
  }
  const payload = await request.json().catch(() => ({}))
  const result = await emitFlowSignal({ organizationId: auth.organizationId, signal: name, payload })
  return { success: true, matched: result.matched }
}, { permission: 'flow.run' })
