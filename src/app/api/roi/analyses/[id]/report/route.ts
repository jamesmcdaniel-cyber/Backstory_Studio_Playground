import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

// GET /api/roi/analyses/:id/report — the rendered dashboard as a document,
// for the sandboxed iframe on /roi/:id. Served (not srcDoc'd) because it is
// a few hundred KB with a script tag: as a real navigation the frame gets a
// proper origin-less sandbox, a CSP header, and can load Chart.js from
// /vendor, which is the only thing it is allowed to fetch.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Analysis id is required.', 400, 'ID_REQUIRED')
  const row = await prisma.roiAnalysis.findFirst({ where: { id, organizationId: auth.organizationId }, select: { reportHtml: true } })
  if (!row?.reportHtml) throw new ApiError('The report is not ready yet.', 404, 'NOT_READY')
  return new Response(row.reportHtml, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'",
    },
  })
}, { permission: 'agent.read', internalOnly: true })
