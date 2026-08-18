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

/** Whether a form-data body object has any file-reference field (top level or
 *  in an array value) — the signal to build a real multipart upload. */
export function bodyHasFileReference(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  return Object.values(body as Record<string, unknown>).some(
    (value) => isFileReference(value) || (Array.isArray(value) && value.some(isFileReference)),
  )
}

// ── HTTP step: binding an upstream file to a multipart field ────────────────

/**
 * One multipart file part on an HTTP step: the form field name, and the flow
 * data it takes its file from. `source` is a bare context path (e.g.
 * `step.n1.output`) — the builder shows it as a picked chip, never as typed
 * token syntax.
 */
export type FormFileBinding = { field: string; source: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/**
 * A value a user bound to a file field, reduced to the file reference(s) it
 * carries: the reference itself, a list of them, or a step-output envelope
 * wrapping one (`{ output: … }`, `{ file: … }`, `{ files: [...] }`).
 */
function fileReferencesIn(value: unknown): FlowFileReference[] {
  if (isFileReference(value)) return [value]
  if (Array.isArray(value)) return value.filter(isFileReference)
  if (isRecord(value)) {
    for (const key of ['output', 'file', 'files', 'body', 'data']) {
      if (key in value) {
        const nested = fileReferencesIn(value[key])
        if (nested.length) return nested
      }
    }
  }
  return []
}

/**
 * Merge an HTTP step's file bindings into its resolved form-data body, so the
 * executor's existing file path (bodyHasFileReference → real Blobs) picks them
 * up. Returns an error message instead of throwing so the interpreter can fail
 * the step with the same shape as its other resolution failures.
 */
export function bindFormFiles(
  body: unknown,
  bindings: FormFileBinding[],
  read: (path: string) => unknown,
): { body: Record<string, unknown> } | { error: string } {
  let base: Record<string, unknown>
  if (body == null || body === '') base = {}
  else if (isRecord(body)) base = { ...body }
  else return { error: 'This request attaches files, so its body fields must be a JSON object. Switch the body to key/value fields and try again.' }

  for (const binding of bindings) {
    const field = binding.field.trim()
    if (!field) return { error: 'A file attachment on this request has no form field name — name the field the API expects.' }
    const found = fileReferencesIn(read(binding.source))
    if (!found.length) {
      return {
        error: `The file attached to "${field}" is not there — the step it comes from produced no file. Pick a step that outputs a file, or make that step run first.`,
      }
    }
    base[field] = found.length === 1 ? found[0] : found
  }
  return { body: base }
}

export type StoredFileBytes = { buffer: Buffer | Uint8Array; filename: string; mimeType: string }

/**
 * Build the multipart body for a form-data HTTP step: file-reference fields
 * become real binary parts (correct filename + content-type), everything else
 * stays a text field. Returning FormData (rather than hand-rolled bytes) lets
 * the fetch runtime own the boundary — the caller must NOT set a content-type.
 *
 * A referenced file that can no longer be read is an error, not a dropped part:
 * silently posting a request without its attachment looks like success.
 */
export async function buildMultipartBody(
  body: unknown,
  readFile: (fileId: string) => Promise<StoredFileBytes | null>,
): Promise<FormData> {
  const form = new FormData()
  if (!isRecord(body)) return form
  for (const [key, value] of Object.entries(body)) {
    const values = Array.isArray(value) ? value : [value]
    for (const entry of values) {
      if (isFileReference(entry)) {
        const file = await readFile(entry.fileId)
        if (!file) throw new Error(`The file for "${key}" (${entry.filename}) is no longer available, so the request was not sent.`)
        const bytes = file.buffer instanceof Uint8Array ? file.buffer : new Uint8Array(file.buffer)
        form.append(key, new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }), file.filename)
      } else if (entry != null) {
        form.append(key, typeof entry === 'object' ? JSON.stringify(entry) : String(entry))
      }
    }
  }
  return form
}
