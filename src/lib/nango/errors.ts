import { ApiError } from '@/lib/server/api-handler'

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
  const err = error as { response?: { status?: number }; status?: number; statusCode?: number }
  const status = err?.response?.status ?? err?.status ?? err?.statusCode
  if (status === 401 || status === 403) {
    return new ApiError('Nango credentials are invalid or unauthorized.', 502, 'NANGO_UNAUTHORIZED')
  }
  return new ApiError(`Nango request failed: ${message.slice(0, 160)}`, 502, 'NANGO_ERROR')
}
