/**
 * Read a fetch response without allowing an untrusted peer to make the process
 * buffer an unbounded body. `Response.text()` / `arrayBuffer()` read to EOF
 * before callers can truncate, which is too late to protect a flow worker.
 */
export async function readResponseBytesLimited(
  response: Response,
  maxBytes: number,
  label = 'Response',
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${label} exceeded ${maxBytes} bytes.`)
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} exceeded ${maxBytes} bytes.`)
      }
      chunks.push(value)
    }
  } finally {
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

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
  label = 'Response',
): Promise<string> {
  return new TextDecoder().decode(await readResponseBytesLimited(response, maxBytes, label))
}
