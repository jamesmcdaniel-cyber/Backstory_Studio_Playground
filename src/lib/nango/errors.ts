import { ApiError } from '@/lib/server/api-handler'
import { upstreamDetail } from '@/lib/upstream-error'

// Converts a Nango SDK / config failure into a clear ApiError instead of a
// generic 500. The Nango node SDK is axios-based, so upstream HTTP failures
// surface as errors with a `response.status` (or `status`) field.
export function nangoApiError(error: unknown): ApiError {
  // Already typed (e.g. getNangoClient's "not configured" 503) — keep its
  // status and code instead of flattening it to a generic 502.
  if (error instanceof ApiError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/not configured/i.test(message)) {
    return new ApiError('Nango is not configured for this environment.', 503, 'NANGO_UNAVAILABLE')
  }
  const err = error as {
    response?: { status?: number; data?: { error?: { message?: string; code?: string } } }
    status?: number
    statusCode?: number
  }
  const status = err?.response?.status ?? err?.status ?? err?.statusCode
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 403) {
    // Every other 4xx is a fact about OUR request — a malformed body, an
    // unknown provider config key — and the provider says which in its
    // response body. Reporting only the status code sent the reader hunting
    // through layers that were all working.
    const upstream = upstreamDetail(error)
    return new ApiError(
      upstream ? `Nango rejected the request: ${upstream}` : `Nango rejected the request (${status}).`,
      502,
      'NANGO_BAD_REQUEST',
    )
  }
  if (status === 401 || status === 403) {
    // Pass Nango's own reason through. "invalid or unauthorized" sent someone
    // hunting for a bad/expired key when Nango was saying something far more
    // specific and actionable — that the key is a SCOPED API key missing
    // `environment:integrations:list`, which no amount of re-copying the key
    // fixes. The upstream text is the difference between a dead end and a fix.
    const upstream = err?.response?.data?.error?.message
    return new ApiError(
      upstream
        ? `Nango rejected our credentials: ${upstream.slice(0, 200)}`
        : 'Nango credentials are invalid or unauthorized.',
      502,
      'NANGO_UNAUTHORIZED',
    )
  }
  return new ApiError(`Nango request failed: ${message.slice(0, 160)}`, 502, 'NANGO_ERROR')
}
