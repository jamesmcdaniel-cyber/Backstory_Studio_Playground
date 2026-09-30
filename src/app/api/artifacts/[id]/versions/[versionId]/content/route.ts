import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { versionContent, isInteractiveContent } from '@/lib/artifacts/service'
import { looksLikeHtml } from '@/lib/html-detect'
import { vendorScripts } from '@/lib/artifacts/vendor-scripts'

export const runtime = 'nodejs'

// Script-less document: styles and data images only. An interactive page (an
// ROI dashboard, an uploaded page, any agent HTML with its own script) may run
// inline script and load from our origin — never anything else. Both carry a
// CSP sandbox, so even opened directly (not in the viewer's sandboxed iframe)
// the page has an opaque origin: no cookies, no session, no app APIs.
const STATIC_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:"
const INTERACTIVE_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads; default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"

// Links out of a page (a CRM record, a source) open in a new tab rather than
// inside the frame, where most sites refuse to load. In-page links (#views)
// and the page's own click handlers are left alone.
const LINK_SCRIPT = `<script>document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a||e.defaultPrevented)return;var h=a.getAttribute('href')||'';if(/^https?:\\/\\//i.test(h)){e.preventDefault();window.open(h,'_blank','noopener');}});</script>`

function withLinkScript(html: string): string {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${LINK_SCRIPT}</body>`) : `${html}${LINK_SCRIPT}`
}

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
  // A Markdown document is not a page: the viewer renders it itself.
  if (!looksLikeHtml(found.content.slice(0, 4_000))) {
    return new Response(found.content, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'private, no-store' } })
  }
  const interactive = isInteractiveContent(found.kind, found.content)
  const content = interactive ? vendorScripts(found.content) : found.content
  const page = /<html[\s>]/i.test(content)
    ? content
    : `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:ui-sans-serif,system-ui,sans-serif;color:#1f2937;font-size:14px;line-height:1.55;word-break:break-word}</style></head><body>${content}</body></html>`
  const body = interactive ? withLinkScript(page) : page
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
