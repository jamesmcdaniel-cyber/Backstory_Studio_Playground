/**
 * POST to an interactive AI route and stream its answer. Asks for
 * `text/event-stream`; a route that answers JSON instead (an error before the
 * model call, or a route that does not stream) is read the ordinary way, so
 * callers handle one shape either way.
 */
export type StreamResult<T> = { ok: boolean; status: number; data: T }

export async function postStreaming<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  onDelta: (text: string) => void,
  init: { signal?: AbortSignal } = {},
): Promise<StreamResult<T>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: init.signal,
  })
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream') || !response.body) {
    const data = (await response.json().catch(() => ({}))) as T
    return { ok: response.ok, status: response.status, data }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: { ok: boolean; data: T } | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = /^event: (.*)$/m.exec(frame)?.[1]
      const raw = /^data: (.*)$/m.exec(frame)?.[1]
      if (event && raw) {
        const data = JSON.parse(raw) as T & { text?: string }
        if (event === 'delta' && typeof data.text === 'string') onDelta(data.text)
        else if (event === 'done') final = { ok: true, data }
        else if (event === 'error') final = { ok: false, data }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  if (!final) return { ok: false, status: 502, data: { success: false, error: 'The answer was cut off. Try again.' } as T }
  return { ok: final.ok, status: final.ok ? 200 : 502, data: final.data }
}
