import { NextRequest, NextResponse } from 'next/server'

export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.API_BODY_READ_TIMEOUT_MS) || 15_000,
)

export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 408 | 413 | 415,
    readonly code: 'INVALID_BODY' | 'BODY_READ_TIMEOUT' | 'BODY_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE',
  ) {
    super(message)
    this.name = 'RequestBodyError'
  }
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('maxBytes must be a non-negative safe integer')
}

/**
 * Read a request incrementally and stop as soon as its actual bytes exceed the
 * ceiling. Content-Length remains a cheap early rejection, but is never trusted
 * as the enforcement boundary: omitted, false, and chunked lengths all meet the
 * same streamed limit.
 */
export async function readRequestBytesLimited(
  request: Request,
  maxBytes: number,
  timeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
): Promise<Uint8Array> {
  validateLimit(maxBytes)
  const declaredHeader = request.headers.get('content-length')
  const declared = declaredHeader === null ? null : Number(declaredHeader)
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
    throw new RequestBodyError('Invalid Content-Length header.', 400, 'INVALID_BODY')
  }
  if (declared !== null && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined)
    throw new RequestBodyError('Request body is too large.', 413, 'BODY_TOO_LARGE')
  }
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new RequestBodyError('Request body timed out.', 408, 'BODY_READ_TIMEOUT')), timeoutMs)
  })

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestBodyError('Request body is too large.', 413, 'BODY_TOO_LARGE')
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    reader.releaseLock()
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

export async function readRequestTextLimited(request: Request, maxBytes: number): Promise<string> {
  const bytes = await readRequestBytesLimited(request, maxBytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new RequestBodyError('Request body is not valid UTF-8.', 400, 'INVALID_BODY')
  }
}

export async function readRequestJsonLimited<T = unknown>(request: Request, maxBytes: number): Promise<T> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType && contentType !== 'application/json' && !contentType.endsWith('+json')) {
    throw new RequestBodyError('Content-Type must be application/json.', 415, 'UNSUPPORTED_MEDIA_TYPE')
  }
  const text = await readRequestTextLimited(request, maxBytes)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new RequestBodyError('Request body is not valid JSON.', 400, 'INVALID_BODY')
  }
}

/** Rebuild a NextRequest after bounded reading so existing handlers may keep
 * using request.json(), text(), formData(), and arrayBuffer() unchanged. */
export async function boundedNextRequest(request: NextRequest, maxBytes: number): Promise<NextRequest> {
  const bytes = await readRequestBytesLimited(request, maxBytes)
  const headers = new Headers(request.headers)
  headers.set('content-length', String(bytes.byteLength))
  return new NextRequest(request.url, {
    method: request.method,
    headers,
    body: bytes.byteLength ? Buffer.from(bytes) : undefined,
    signal: request.signal,
  })
}

export function requestBodyErrorResponse(error: RequestBodyError): NextResponse {
  return NextResponse.json(
    { success: false, error: error.message, code: error.code },
    { status: error.status },
  )
}
