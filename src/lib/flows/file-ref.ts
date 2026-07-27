/**
 * A file flowing through a flow is a REFERENCE, never inline bytes: a StoredFile
 * id + metadata + a download URL, plus the extracted text when the file is a
 * text/CSV/PDF type. Downstream steps read `{{step.x.output.content}}` (text) or
 * `{{step.x.output.fileId}}` / `{{step.x.output.url}}` (to re-download or hand to
 * another API). This keeps run rows small and avoids base64-in-JSON.
 */

export type FlowFileReference = {
  fileId: string
  filename: string
  mimeType: string
  size: number
  url: string
  /** Extracted text, when the file type supports it (text/CSV/JSON/PDF/…). */
  content?: string
}

export function fileReference(
  saved: { id: string; filename: string; mimeType: string; size: number },
  opts?: { content?: string; baseUrl?: string },
): FlowFileReference {
  const base = opts?.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? ''
  return {
    fileId: saved.id,
    filename: saved.filename,
    mimeType: saved.mimeType,
    size: saved.size,
    url: `${base}/api/files/${saved.id}`,
    ...(opts?.content ? { content: opts.content } : {}),
  }
}

export function isFileReference(value: unknown): value is FlowFileReference {
  return Boolean(value && typeof value === 'object' && typeof (value as { fileId?: unknown }).fileId === 'string')
}
