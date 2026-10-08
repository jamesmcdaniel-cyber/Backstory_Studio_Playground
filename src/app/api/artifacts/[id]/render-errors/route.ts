import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { requireEditable, requireReadable } from '@/lib/artifacts/route-access'
import { latestRenderErrors, recordRenderErrors, renderErrorsWriteSchema } from '@/lib/artifacts/render-errors'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'

// GET /api/artifacts/:id/render-errors?versionId= — the latest runtime errors
// the page of that version reported, if any (the viewer's banner).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const url = new URL(request.url)
  const artifactId = url.pathname.split('/').at(-2)!
  await requireReadable(auth, artifactId)
  const versionId = url.searchParams.get('versionId') ?? ''
  if (!versionId || versionId.length > 80) throw new ApiError('versionId is required.', 400, 'VERSION_REQUIRED')
  return { success: true, report: await latestRenderErrors({ organizationId: auth.organizationId, artifactId }, versionId) }
}, { permission: 'agent.read' })

// PUT /api/artifacts/:id/render-errors — the frame reports what broke in a
// version's page (editors only: the report changes what the assistant is told).
export const PUT = withAuthenticatedApi(async (request, auth) => {
  const artifactId = new URL(request.url).pathname.split('/').at(-2)!
  await requireEditable(auth, artifactId)
  const limited = await rateLimit(`artifact-render-errors:${auth.organizationId}:${auth.dbUser.id}`, { limit: 60, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Reporting too quickly. Retry shortly.', 429, 'RATE_LIMITED')
  const raw = await request.text()
  if (Buffer.byteLength(raw) > 64_000) throw new ApiError('Error report too large.', 413, 'REPORT_TOO_LARGE')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new ApiError('Invalid JSON.', 400, 'INVALID_JSON') }
  const { versionId, errors } = renderErrorsWriteSchema.parse(parsed)
  await recordRenderErrors({ organizationId: auth.organizationId, artifactId }, versionId, auth.dbUser.id, errors)
  return { success: true, count: errors.length }
}, { permission: 'agent.read' })
