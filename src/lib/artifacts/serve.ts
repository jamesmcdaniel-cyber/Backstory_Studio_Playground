import { isInteractiveContent } from './service'
import { looksLikeHtml } from '@/lib/html-detect'
import { vendorScripts } from './vendor-scripts'
import { compileArtifactPage, hasPythonScript } from './runtime'

/**
 * Serving an artifact version as a page: the one place its policy is decided,
 * shared by the signed-in viewer's content route and the public link.
 */

// Script-less document: styles and data images only. An interactive page (an
// ROI dashboard, an uploaded page, any agent HTML with its own script) may run
// inline script and load from our origin — never anything else. Both carry a
// CSP sandbox, so even opened directly (not in the viewer's sandboxed iframe)
// the page has an opaque origin: no cookies, no session, no app APIs.
const STATIC_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:"
const INTERACTIVE_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads; default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src data: blob:; worker-src 'self' blob:; connect-src 'none'"

// Links out of a page (a CRM record, a source) open in a new tab rather than
// inside the frame, where most sites refuse to load. In-page links (#views)
// and the page's own click handlers are left alone.
const LINK_SCRIPT = `<script>document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a||e.defaultPrevented)return;var h=a.getAttribute('href')||'';if(/^https?:\\/\\//i.test(h)){e.preventDefault();window.open(h,'_blank','noopener');}});</script>`

/**
 * A page that runs Python (Pyodide) also needs WebAssembly and to fetch the
 * Python runtime's files — from our /vendor/pyodide/ and nowhere else.
 */
function pythonCsp(origin: string): string {
  return INTERACTIVE_CSP
    .replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'")
    .replace("connect-src 'none'", `connect-src ${origin}/vendor/pyodide/`)
}

function withLinkScript(html: string): string {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${LINK_SCRIPT}</body>`) : `${html}${LINK_SCRIPT}`
}

/**
 * The response for a version: Markdown as text (the viewer renders it), HTML
 * as a sandboxed page — library URLs swapped to our copies, JSX compiled, and
 * the policy matched to what the page needs.
 */
export function artifactPageResponse(found: { content: string; kind: string }, origin: string): Response {
  // A Markdown document is not a page: the viewer renders it itself.
  if (!looksLikeHtml(found.content.slice(0, 4_000))) {
    return new Response(found.content, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'private, no-store' } })
  }
  const interactive = isInteractiveContent(found.kind, found.content)
  // Library URLs swap to our copies; JSX (a React artifact) compiles here.
  const content = interactive ? compileArtifactPage(vendorScripts(found.content)) : found.content
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
      'content-security-policy': !interactive ? STATIC_CSP : hasPythonScript(found.content) ? pythonCsp(origin) : INTERACTIVE_CSP,
    },
  })
}
