import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { useArtifactTemplate } from '@/lib/artifacts/templates'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`artifact-template:${auth.organizationId}:${auth.dbUser.id}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Please wait a minute before trying again.', 429, 'RATE_LIMITED')
  const token = new URL(request.url).pathname.split('/').at(-2) ?? ''
  const copy = await useArtifactTemplate(token, auth.organizationId, auth.dbUser.id)
  return { success: true, artifactId: copy.id }
}, { permission: 'agent.read' })
