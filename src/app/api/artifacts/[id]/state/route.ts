import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { requireEditable } from '@/lib/artifacts/route-access'
import { readAppState, writeAppState, stateKeySchema, stateWriteSchema, MAX_STATE_BYTES } from '@/lib/artifacts/app-state'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'
export const GET = withAuthenticatedApi(async (request, auth) => {
  const url = new URL(request.url)
  const artifactId = url.pathname.split('/').at(-2)!
  await requireEditable(auth, artifactId)
  const key = stateKeySchema.parse(url.searchParams.get('key'))
  return { success: true, ...await readAppState({ organizationId: auth.organizationId, userId: auth.dbUser.id, artifactId, key }) }
}, { permission: 'agent.read' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const artifactId = new URL(request.url).pathname.split('/').at(-2)!
  await requireEditable(auth, artifactId)
  const limited = await rateLimit(`artifact-state:${auth.organizationId}:${auth.dbUser.id}`, { limit: 120, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Saving too quickly. Retry shortly.', 429, 'RATE_LIMITED')
  const raw = await request.text()
  if (Buffer.byteLength(raw) > MAX_STATE_BYTES + 1024) throw new ApiError('Application state too large.', 413, 'STATE_TOO_LARGE')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new ApiError('Invalid JSON.', 400, 'INVALID_JSON') }
  const { key, revision, value, versionId } = stateWriteSchema.parse(parsed)
  return { success: true, ...await writeAppState({ organizationId: auth.organizationId, userId: auth.dbUser.id, artifactId, key }, revision, value, versionId) }
}, { permission: 'agent.read' })
