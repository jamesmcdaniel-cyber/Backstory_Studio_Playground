export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/** Read a request body without first buffering an attacker-controlled payload. */
export async function readRequestBytesLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLargeError(maxBytes)
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestBodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

export async function readRequestTextLimited(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8', { fatal: false }).decode(await readRequestBytesLimited(request, maxBytes))
}
