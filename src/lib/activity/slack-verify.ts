import { createHmac } from 'node:crypto'
import { timingSafeEqualHex } from '@/lib/crypto/secrets'

/**
 * Slack Events API request signing (https://api.slack.com/authentication/verifying-requests-from-slack).
 *
 * Slack signs the RAW request body with the app's signing secret:
 *
 *   base_string   = "v0:{timestamp}:{raw_body}"
 *   computed_sig  = "v0=" + hex(HMAC-SHA256(signing_secret, base_string))
 *
 * and sends `computed_sig` in the `X-Slack-Signature` header alongside the
 * `timestamp` in `X-Slack-Request-Timestamp`. Verification MUST run against
 * the untouched raw bytes — this module takes `rawBody` as a plain string
 * read straight off the request stream (see `request.text()` in the route),
 * never a value that has been through `JSON.parse`+`JSON.stringify`, which is
 * not guaranteed to reproduce the exact byte sequence Slack signed (key
 * order, whitespace, unicode escaping can all differ).
 *
 * The 5-minute window guards against replaying a captured request
 * indefinitely; `now` is a required parameter (not `Date.now()`) so tests can
 * exercise the boundary deterministically — same discipline as
 * `src/lib/activity/normalize.ts`'s required `receivedAt`.
 */

export const SLACK_SIGNATURE_VERSION = 'v0'
export const SLACK_SIGNATURE_MAX_SKEW_MS = 5 * 60_000

export interface SlackSignatureInput {
  /** The workspace's (or app's) signing secret — never logged. */
  signingSecret: string
  /** Raw `X-Slack-Request-Timestamp` header value (decimal unix seconds, as a string). */
  timestampHeader: string | null | undefined
  /** Raw `X-Slack-Signature` header value, e.g. `v0=abcdef...`. */
  signatureHeader: string | null | undefined
  /** The exact bytes Slack signed, as read off the request (no re-serialization). */
  rawBody: string
  /** Caller-supplied clock, for the skew check. */
  now: Date
}

/**
 * Verify one Slack Events API request. Returns `false` (never throws) for any
 * malformed, missing, stale, or mismatched input — a caller on an
 * unauthenticated route should never have to distinguish "couldn't verify"
 * failure modes to decide what to do (reject).
 */
export function verifySlackSignature(input: SlackSignatureInput): boolean {
  const { signingSecret, timestampHeader, signatureHeader, rawBody, now } = input
  if (!signingSecret || !timestampHeader || !signatureHeader) return false

  const timestampSeconds = Number(timestampHeader)
  if (!Number.isFinite(timestampSeconds)) return false
  const skewMs = Math.abs(now.getTime() - timestampSeconds * 1000)
  if (skewMs > SLACK_SIGNATURE_MAX_SKEW_MS) return false

  const prefix = `${SLACK_SIGNATURE_VERSION}=`
  if (!signatureHeader.startsWith(prefix)) return false
  const providedHex = signatureHeader.slice(prefix.length)
  // Hex, fixed length for sha256 (64 chars) — timingSafeEqualHex already
  // returns false (not a throw) on any length mismatch, including a
  // malformed/truncated header.
  if (!/^[0-9a-f]+$/i.test(providedHex)) return false

  const baseString = `${SLACK_SIGNATURE_VERSION}:${timestampHeader}:${rawBody}`
  const computedHex = createHmac('sha256', signingSecret).update(baseString, 'utf8').digest('hex')

  return timingSafeEqualHex(computedHex, providedHex)
}
