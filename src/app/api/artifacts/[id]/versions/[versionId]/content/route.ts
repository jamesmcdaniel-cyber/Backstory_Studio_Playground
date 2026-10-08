import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { versionContent } from '@/lib/artifacts/service'
import { artifactPageResponse } from '@/lib/artifacts/serve'
import { requireReadable } from '@/lib/artifacts/route-access'

export const runtime = 'nodejs'

/**
 * A saved version never changes, so the browser keeps its page: opening the
 * same report again (the ROI page, a revisited artifact) draws from the cache
 * instead of downloading megabytes. Private (per browser, never a shared
 * cache), for a day; after that one revalidation answers 304. The ETag carries
 * the deploy, so a release that changes how pages are served (the injected
 * runtime, the policy) is fetched fresh once. "current" is never cached.
 */
const SERVE_REVISION = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.npm_package_version ?? 'dev').slice(0, 12)
const VERSION_CACHE = 'private, max-age=86400'

// GET /api/artifacts/:id/versions/:versionId/content — the document itself
// ("current" for the current version), served as a page for the viewer's
// iframe with a policy matched to what it holds (src/lib/artifacts/serve.ts).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const parts = new URL(request.url).pathname.split('/')
  const versionId = parts.at(-2)
  const id = parts.at(-4)
  if (!id || !versionId) throw new ApiError('Artifact and version ids are required.', 400, 'ID_REQUIRED')
  await requireReadable(auth, id)
  const saved = versionId !== 'current'
  const etag = `"${versionId}.${SERVE_REVISION}"`
  if (saved && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': VERSION_CACHE } })
  }
  const found = await versionContent(auth.organizationId, id, saved ? versionId : 'current')
  if (!found) throw new ApiError('Version not found.', 404, 'NOT_FOUND')
  // ?download=1 hands over the document as authored (no injected runtime), as
  // a file: the one export path, so a page can leave the platform whole.
  if (new URL(request.url).searchParams.get('download') === '1') {
    const html = /<\s*(!doctype|html|head|body|div|section|script)\b/i.test(found.content.slice(0, 4_000))
    return new Response(found.content, {
      status: 200,
      headers: {
        'content-type': html ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="artifact-${id}-${saved ? versionId : 'current'}.${html ? 'html' : 'md'}"`,
        'cache-control': 'private, no-store',
      },
    })
  }
  const response = artifactPageResponse(found, new URL(request.url).origin)
  if (saved) {
    response.headers.set('cache-control', VERSION_CACHE)
    response.headers.set('etag', etag)
  }
  return response
}, { permission: 'agent.read' })
