import { z } from 'zod'
import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { createPendingUpload, DirectUploadUnavailableError, maxBytesForFile } from '@/lib/files/storage'

export const runtime = 'nodejs'

const bodySchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().max(200).optional(),
  size: z.number().int().positive(),
})

// POST /api/files/upload-url — start a direct-to-storage upload. The browser
// PUTs the bytes to the returned URL, then calls /api/files/:id/complete. This
// is how a 30 MB dataset gets in: the app server never carries the bytes.
// 501 when object storage is not configured (local/CI); the client falls back
// to the multipart route, which keeps the 10 MB ceiling.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Send filename, mimeType and size.', 400, 'INVALID_BODY')
  const { filename, mimeType, size } = parsed.data
  const ceiling = maxBytesForFile(filename)
  if (size > ceiling) throw new ApiError(`Files can be at most ${Math.round(ceiling / 1_000_000)} MB.`, 413, 'FILE_TOO_LARGE')
  try {
    const upload = await createPendingUpload({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      filename,
      mimeType: mimeType || 'application/octet-stream',
      size,
    })
    return { success: true, upload: { id: upload.id, uploadUrl: upload.uploadUrl, token: upload.token, bucket: upload.bucket, path: upload.storagePath } }
  } catch (error) {
    if (error instanceof DirectUploadUnavailableError) throw new ApiError(error.message, 501, 'DIRECT_UPLOAD_UNAVAILABLE')
    throw new ApiError(error instanceof Error ? error.message : 'The upload could not be started.', 400, 'UPLOAD_REJECTED')
  }
}, { permission: 'flow.write' })
