/**
 * PII egress: knowing what personal data crossed to a model provider.
 *
 * Tenant data reaches model providers through the LLM runner with no record of
 * what categories of personal information it carried. That is the open item
 * from the credential-governance program's "AI egress controls", scoped here
 * to its recording half.
 *
 * ── Record, deliberately do not transform ──────────────────────────────────
 *
 * Masking names and emails in outbound prompts sounds safer and would break
 * the product: this is sales automation, and "email {{contact}} about the
 * renewal" NEEDS the contact. A masking layer either destroys that work or
 * grows an allowlist until it masks nothing — while its presence claims a
 * protection it no longer provides. What compliance actually requires first is
 * an ANSWER: which categories of PII went to which processor, for which
 * workspace, when. That answer is what a DPA audit and a deletion-request
 * investigation both start from, and it is what this records.
 *
 * A per-workspace policy switch (`blocked`) exists for customers whose DPA
 * forbids model processing outright — that is enforceable without lying about
 * transformation, because it refuses the call instead of editing it.
 *
 * ── Detection is category-level, not value-level ───────────────────────────
 *
 * The audit row records THAT email addresses crossed, never WHICH — recording
 * the values would build a second copy of the PII in the audit log, creating
 * the exact problem it documents.
 */

export type PiiCategory =
  | 'email'
  | 'phone'
  | 'credit_card'
  | 'national_id'
  | 'ip_address'
  | 'street_address'

interface Detector {
  category: PiiCategory
  pattern: RegExp
  /** Confirm a candidate match — cuts pattern false positives. */
  confirm?: (match: string) => boolean
}

/** Luhn check so "4111111111111111" counts and random 16-digit ids do not. */
function luhnValid(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, '')
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

const DETECTORS: readonly Detector[] = [
  { category: 'email', pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  // Requires separators or +country so run ids and timestamps do not match.
  { category: 'phone', pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]\d{3,4}[\s.-]?\d{0,4}\b/ },
  { category: 'credit_card', pattern: /\b(?:\d[ -]?){13,19}\b/, confirm: luhnValid },
  // US SSN shape with separators — bare 9-digit runs are usually ids.
  { category: 'national_id', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { category: 'ip_address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { category: 'street_address', pattern: /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way)\b/ },
]

/**
 * Which PII categories appear in a piece of model-bound text.
 *
 * Category presence only, by design — see the module comment. Bounded scan so
 * a pathological prompt cannot stall the hot path this runs on.
 */
export function detectPiiCategories(text: string): PiiCategory[] {
  const sample = text.length > 100_000 ? text.slice(0, 100_000) : text
  const found: PiiCategory[] = []

  for (const detector of DETECTORS) {
    const match = sample.match(detector.pattern)
    if (!match) continue
    if (detector.confirm && !detector.confirm(match[0])) {
      // First candidate failed confirmation; scan the rest before giving up on
      // the category, but bounded — one pass, not per-candidate backtracking.
      const all = sample.match(new RegExp(detector.pattern.source, `${detector.pattern.flags}g`)) ?? []
      if (!all.some((candidate) => detector.confirm!(candidate))) continue
    }
    found.push(detector.category)
  }

  return found
}

// ── Policy ─────────────────────────────────────────────────────────────────

export type AiEgressPolicy = 'allowed' | 'blocked'

export function normalizeAiEgressPolicy(value: string | null | undefined): AiEgressPolicy {
  // Only the exact opt-out blocks. Same reasoning as SSO enforcement: an
  // unrecognised value silently disabling every agent in a workspace is a
  // worse failure than the one it guards against.
  return value === 'blocked' ? 'blocked' : 'allowed'
}

/**
 * The one refusal sentence. Shared so the thrown error, the API response and the
 * failed flow step all read identically — a person who hits this on an agent run
 * and again in the copilot must not have to work out that it is the same switch.
 */
export const AI_EGRESS_BLOCKED_MESSAGE =
  'This workspace has AI processing disabled by policy. An administrator can turn it back on in Settings → Enterprise security.'

export class AiEgressBlockedError extends Error {
  constructor() {
    super(AI_EGRESS_BLOCKED_MESSAGE)
    this.name = 'AiEgressBlockedError'
  }
}
