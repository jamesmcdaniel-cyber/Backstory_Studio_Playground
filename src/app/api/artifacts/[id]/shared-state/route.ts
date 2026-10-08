import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { requireEditable, requireReadable } from '@/lib/artifacts/route-access'
import { stateKeySchema, stateWriteSchema, MAX_STATE_BYTES } from '@/lib/artifacts/app-state'
import { readSharedState, writeSharedState } from '@/lib/artifacts/shared-state'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'

// GET /api/artifacts/:id/shared-state?key= — the value every viewer shares.
// Readable by anyone who can open the artifact.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const url = new URL(request.url)
  const artifactId = url.pathname.split('/').at(-2)!
  await requireReadable(auth, artifactId)
  const key = stateKeySchema.parse(url.searchParams.get('key'))
  return { success: true, ...await readSharedState({ organizationId: auth.organizationId, artifactId, key }) }
}, { permission: 'agent.read' })

// PUT /api/artifacts/:id/shared-state — compare-and-set a shared value.
// Writable by anyone who can edit the artifact.
export const PUT = withAuthenticatedApi(async (request, auth) => {
  const artifactId = new URL(request.url).pathname.split('/').at(-2)!
  await requireEditable(auth, artifactId)
  const limited = await rateLimit(`artifact-shared-state:${auth.organizationId}:${auth.dbUser.id}`, { limit: 120, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Saving too quickly. Retry shortly.', 429, 'RATE_LIMITED')
  const raw = await request.text()
  if (Buffer.byteLength(raw) > MAX_STATE_BYTES + 1024) throw new ApiError('Shared state too large.', 413, 'STATE_TOO_LARGE')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new ApiError('Invalid JSON.', 400, 'INVALID_JSON') }
  const { key, revision, value, versionId } = stateWriteSchema.parse(parsed)
  return { success: true, ...await writeSharedState({ organizationId: auth.organizationId, artifactId, key }, revision, value, versionId, auth.dbUser.id) }
}, { permission: 'agent.read' })
