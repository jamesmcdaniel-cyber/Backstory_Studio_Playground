import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { saveStoredFile, STORED_FILE_MAX_BYTES } from '@/lib/files/storage'
import { extractTextAuto, isSupported } from '@/lib/knowledge/extract'

export const runtime = 'nodejs'

// Cap the extracted text echoed back to the uploader — it lands inside the
// run-input JSON, not in storage (the original bytes are the stored artifact).
const CONTENT_PREVIEW_MAX_CHARS = 200_000

// POST /api/files — store an uploaded file for this org (multipart, field
// "file"). Returns the file id plus extracted text when the format supports
// it (PDF included), so flow inputs can carry both the reference and the
// readable content.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) throw new ApiError('Attach a file in the "file" field.', 400, 'FILE_REQUIRED')
  if (file.size > STORED_FILE_MAX_BYTES) {
    throw new ApiError(`Files can be at most ${Math.round(STORED_FILE_MAX_BYTES / 1_000_000)} MB.`, 400, 'FILE_TOO_LARGE')
  }
  const buffer = Buffer.from(await file.arrayBuffer())
  const mimeType = file.type || 'application/octet-stream'
  const saved = await saveStoredFile({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    filename: file.name,
    mimeType,
    buffer,
  })
  let content: string | undefined
  if (isSupported(mimeType, file.name)) {
    content = (await extractTextAuto(buffer, mimeType, file.name).catch(() => '')).slice(0, CONTENT_PREVIEW_MAX_CHARS) || undefined
  }
  return { success: true, file: { ...saved, url: `/api/files/${saved.id}`, content } }
}, { permission: 'flow.write' })
