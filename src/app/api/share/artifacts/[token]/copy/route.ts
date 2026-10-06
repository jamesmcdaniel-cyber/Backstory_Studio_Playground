import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { findArtifactTemplateCopy, takeLatestTemplateCopy, templateCopyUpdate, useArtifactTemplate } from '@/lib/artifacts/templates'
import { rateLimit } from '@/lib/ratelimit'
import { readRequestJsonLimited } from '@/lib/server/request-body'

export const runtime = 'nodejs'
// GET — the caller's existing copy of this template, or null, and whether the
// original has a newer version than the copy took. Read-only: the share page
// asks on load so a returning person sees their latest version.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const token = new URL(request.url).pathname.split('/').at(-2) ?? ''
  const copy = await findArtifactTemplateCopy(token, auth.organizationId, auth.dbUser.id)
  return { success: true, artifactId: copy?.id ?? null, sharedUpdate: copy ? await templateCopyUpdate(token, auth.organizationId, copy.id) : null }
}, { permission: 'agent.read' })

// POST — make (or find) the caller's copy. With { action: 'take_latest' }, take
// the template's current version into that copy as a new version on top.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`artifact-template:${auth.organizationId}:${auth.dbUser.id}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Please wait a minute before trying again.', 429, 'RATE_LIMITED')
  const token = new URL(request.url).pathname.split('/').at(-2) ?? ''
  const body = await readRequestJsonLimited(request, 1_024).catch(() => null) as { action?: unknown } | null
  if (body?.action === 'take_latest') {
    const copy = await takeLatestTemplateCopy(token, auth.organizationId, auth.dbUser.id)
    return { success: true, artifactId: copy.id, sharedUpdate: null }
  }
  const copy = await useArtifactTemplate(token, auth.organizationId, auth.dbUser.id)
  return { success: true, artifactId: copy.id, sharedUpdate: await templateCopyUpdate(token, auth.organizationId, copy.id) }
}, { permission: 'agent.read' })
