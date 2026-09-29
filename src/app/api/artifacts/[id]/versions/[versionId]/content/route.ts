import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { versionContent, isInteractiveKind } from '@/lib/artifacts/service'

export const runtime = 'nodejs'

// Script-less document: styles and data images only. Interactive kinds (an
// ROI dashboard) may run their own inline script and load from our origin —
// never anything else. Both are viewed in a sandboxed iframe.
const STATIC_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:"
const INTERACTIVE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"

// GET /api/artifacts/:id/versions/:versionId/content — the document itself
// ("current" for the current version), served as a page for the viewer's
// iframe with a policy matched to the artifact's kind.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const parts = new URL(request.url).pathname.split('/')
  const versionId = parts.at(-2)
  const id = parts.at(-4)
  if (!id || !versionId) throw new ApiError('Artifact and version ids are required.', 400, 'ID_REQUIRED')
  const found = await versionContent(auth.organizationId, id, versionId === 'current' ? 'current' : versionId)
  if (!found) throw new ApiError('Version not found.', 404, 'NOT_FOUND')
  const interactive = isInteractiveKind(found.kind)
  const body = /<html[\s>]/i.test(found.content)
    ? found.content
    : `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:ui-sans-serif,system-ui,sans-serif;color:#1f2937;font-size:14px;line-height:1.55;word-break:break-word}</style></head><body>${found.content}</body></html>`
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': interactive ? INTERACTIVE_CSP : STATIC_CSP,
    },
  })
}, { permission: 'agent.read' })
