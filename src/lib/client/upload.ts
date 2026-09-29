/**
 * Browser-side file upload with one rule: bytes that can go straight to object
 * storage do. The app server (a serverless function with a small request
 * body) only ever sees the file's name and size, then verifies what landed.
 *
 * Flow: POST /api/files/upload-url → PUT bytes to the signed URL →
 * POST /api/files/:id/complete. Where direct upload is unavailable (local/CI
 * without Supabase, answered with 501) the multipart route is used instead,
 * with its 10 MB ceiling.
 */

import { createClient } from '@/lib/supabase/client'

export type UploadedFile = { id: string; filename: string; mimeType: string; size: number; url: string; content?: string }

export const DIRECT_UPLOAD_MIN_BYTES = 4_000_000

export function isDatasetFile(file: File): boolean {
  return /\.(csv|tsv)$/i.test(file.name)
}

async function readError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({})) as { error?: string }
  return data.error || fallback
}

async function uploadMultipart(file: File, endpoint: string): Promise<UploadedFile> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch(endpoint, { method: 'POST', body: form })
  if (!response.ok) throw new Error(await readError(response, `Could not upload ${file.name}.`))
  const data = await response.json() as { file: UploadedFile }
  return data.file
}

/** Upload straight to storage; returns null when the deployment cannot. */
export async function uploadDirect(file: File): Promise<UploadedFile | null> {
  const started = await fetch('/api/files/upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', size: file.size }),
  })
  if (started.status === 501) return null
  if (!started.ok) throw new Error(await readError(started, `Could not upload ${file.name}.`))
  const { upload } = await started.json() as { upload: { id: string; uploadUrl: string; token: string; bucket: string; path: string } }
  // The PUT goes through the Supabase SDK, not a bare fetch: the storage
  // gateway wants the project apikey alongside the signed token, and the
  // SDK sets that (and the exact x-upsert the signature was made with).
  const supabase = createClient()
  const put = await supabase.storage.from(upload.bucket).uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type || 'application/octet-stream' })
  if (put.error) throw new Error(`The upload of ${file.name} failed: ${put.error.message}`)
  const completed = await fetch(`/api/files/${upload.id}/complete`, { method: 'POST' })
  if (!completed.ok) throw new Error(await readError(completed, `Could not finish uploading ${file.name}.`))
  const data = await completed.json() as { file: UploadedFile }
  return data.file
}

/**
 * Upload a file to org storage and return its record. Datasets and anything
 * over DIRECT_UPLOAD_MIN_BYTES go direct; small files take the multipart
 * route (which also returns extracted text for run inputs).
 */
export async function uploadFile(file: File, options: { multipartEndpoint?: string } = {}): Promise<UploadedFile> {
  const endpoint = options.multipartEndpoint ?? '/api/files'
  if (isDatasetFile(file) || file.size > DIRECT_UPLOAD_MIN_BYTES) {
    const direct = await uploadDirect(file)
    if (direct) return direct
  }
  return uploadMultipart(file, endpoint)
}
