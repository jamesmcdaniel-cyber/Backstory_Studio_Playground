/**
 * Render a failed upstream call so a run log says what actually went wrong.
 *
 * Nango's SDK is axios-based, and an axios error's `message` is only the
 * status line — "Request failed with status code 400". The provider's own
 * explanation ("Invalid value at 'message.raw'", "Unknown provider config
 * key") lives in `response.data` and was being dropped at every layer, so a
 * failed Gmail send reached the run panel as a bare 400 with nothing to act
 * on. The status code alone cannot distinguish a malformed payload from a
 * misrouted connection; the body can.
 *
 * Whatever this returns is persisted to a run log a person will read, so an
 * upstream body is redacted and bounded before it goes anywhere.
 */

const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|api[-_]?key|private[-_]?key|refresh[-_]?token)/i
const MAX_DETAIL = 500

/** Credential shapes that appear in provider error bodies as free text. */
function scrubText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]'
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 10).map((entry) => scrub(entry, depth + 1))
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 25)
      .map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : scrub(entry, depth + 1)]),
  )
}

/**
 * The most human-readable string an error body offers. Providers nest their
 * message differently — Google under `error.message`, Nango under `message`,
 * some return a bare string — so prefer a real sentence and fall back to JSON
 * only when there is no message to find.
 */
export function upstreamDetail(error: unknown): string | null {
  const data = (error as { response?: { data?: unknown } })?.response?.data
  if (data === undefined || data === null || data === '') return null
  if (typeof data === 'string') return scrubText(data).trim().slice(0, MAX_DETAIL) || null

  if (typeof data === 'object') {
    const record = data as Record<string, unknown>
    const nested = record.error
    const candidates = [
      typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>).message : undefined,
      typeof nested === 'string' ? nested : undefined,
      record.message,
      record.error_description,
      record.detail,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return scrubText(candidate).trim().slice(0, MAX_DETAIL)
      }
    }
    try {
      return JSON.stringify(scrub(data)).slice(0, MAX_DETAIL)
    } catch {
      return null
    }
  }
  return null
}

/**
 * The message to persist for a failed call: the error's own text, plus what
 * the provider said when it said anything.
 */
export function describeUpstreamFailure(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error)
  const detail = upstreamDetail(error)
  if (!detail || base.includes(detail)) return base
  return `${base} — upstream said: ${detail}`
}
