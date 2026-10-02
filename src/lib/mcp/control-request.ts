/** Retry transient gateway failures only for MCP setup/discovery. A tools/call
 * may already have written externally and must never be replayed implicitly. */
export async function fetchMcpControlRequest(url: string, method: string, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const retryable = ['initialize', 'notifications/initialized', 'tools/list'].includes(method)
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(url, init)
    if (!retryable || attempt >= 2 || ![500, 502, 503, 504].includes(response.status) || init.signal?.aborted) return response
    await response.body?.cancel()
    await new Promise(resolve => setTimeout(resolve, 150 * 2 ** attempt))
    init.signal?.throwIfAborted()
  }
}
