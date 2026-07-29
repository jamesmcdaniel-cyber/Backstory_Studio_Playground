import { NextRequest } from 'next/server'
import { getGranolaApiKey, GRANOLA_BASE_URL } from '@/lib/integrations/granola'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const GET = withAuthenticatedApi(async (request: NextRequest, auth) => {
  const resolved = await getGranolaApiKey(auth.organizationId)
  if (!resolved) {
    throw new ApiError('Granola is not connected', 503, 'INTEGRATION_UNAVAILABLE')
  }

  // Extract id from the URL path: /api/granola/notes/<id>
  const segments = request.nextUrl.pathname.split('/')
  const id = segments[segments.length - 1]
  if (!id) throw new ApiError('Note id is required', 400, 'BAD_REQUEST')

  let raw: unknown
  try {
    const url = `${GRANOLA_BASE_URL}/notes/${encodeURIComponent(id)}?include=transcript`
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 404) throw new ApiError('Note not found', 404, 'NOT_FOUND')
    if (!response.ok) throw new ApiError(`Granola returned an error (status ${response.status})`, 502, 'UPSTREAM_ERROR')
    raw = await response.json()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('Could not reach Granola. Please try again.', 502, 'UPSTREAM_ERROR')
  }

  const n = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const note = {
    id: String(n.id ?? id),
    title: String(n.title ?? 'Untitled'),
    summary: typeof n.summary === 'string' ? n.summary : '',
  }

  return { success: true, note }
}, { permission: 'agent.read' })
