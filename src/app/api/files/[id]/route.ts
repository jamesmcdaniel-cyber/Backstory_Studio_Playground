import { NextResponse } from 'next/server'
import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { readStoredFile } from '@/lib/files/storage'

export const runtime = 'nodejs'

// GET /api/files/[id] — download an org file (attachment disposition).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('File id is required')
  const file = await readStoredFile(id, auth.organizationId)
  if (!file) throw new ApiError('File not found', 404, 'NOT_FOUND')
  const safeName = file.filename.replace(/"/g, '')
  return new NextResponse(new Uint8Array(file.buffer), {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}, { permission: 'flow.read' })
