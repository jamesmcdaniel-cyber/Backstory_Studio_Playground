import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { finalizeUpload, DirectUploadUnavailableError } from '@/lib/files/storage'

export const runtime = 'nodejs'
// A configured malware scanner means reading the whole file back; give it room.
export const maxDuration = 120

// POST /api/files/:id/complete — the browser finished its direct PUT. Verify
// what landed and make the file readable. Until this succeeds the row is
// pending and nothing (reads, run_code, the repository) can see it.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('File id is required.', 400, 'FILE_ID_REQUIRED')
  try {
    const file = await finalizeUpload({ id, organizationId: auth.organizationId })
    return { success: true, file: { ...file, url: `/api/files/${file.id}` } }
  } catch (error) {
    if (error instanceof DirectUploadUnavailableError) throw new ApiError(error.message, 501, 'DIRECT_UPLOAD_UNAVAILABLE')
    throw new ApiError(error instanceof Error ? error.message : 'The upload could not be completed.', 400, 'UPLOAD_REJECTED')
  }
}, { permission: 'flow.write' })
