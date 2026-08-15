/**
 * Credential lifetime policy: how long a credential may live, and when one has
 * gone stale enough to be worth acting on.
 *
 * Expiry was optional at mint for every long-lived credential in the platform.
 * A key minted once with no `expiresAt` stayed valid until someone remembered
 * it existed — and nothing surfaced that it existed, so nobody did. That is the
 * failure mode behind "is rotation supported?": rotation was *possible* the
 * whole time; what was missing was any force making it happen.
 *
 * The policy here is deliberately not "expire everything aggressively". A key
 * that expires mid-run breaks a customer's automation, and the fix people reach
 * for is a longer expiry, or none. So:
 *
 *   - Bearer tokens we mint (API keys, SCIM tokens) get a REQUIRED, capped
 *     lifetime. We control both ends, and an unbounded bearer token is the
 *     worst of the categories — it authenticates as its minter forever.
 *   - Stored third-party secrets (HTTP credentials, integration keys) get an
 *     OPTIONAL expiry plus staleness tracking. We cannot rotate someone else's
 *     Stripe key on their behalf, so forcing an expiry would just break the
 *     integration on a date nobody chose. Surfacing "this has not been rotated
 *     in 14 months" puts the decision where it can actually be made.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Longest life a token we mint may be given. One year: long enough that annual
 * rotation is a calendar task rather than a recurring interruption, short
 * enough that a leaked token does not outlive the person who leaked it.
 */
export const MAX_TOKEN_LIFETIME_DAYS = 365

/** Applied when a caller does not choose — the same as the cap, not unbounded. */
export const DEFAULT_TOKEN_LIFETIME_DAYS = 90

/** A stored third-party secret unrotated this long is flagged for review. */
export const STALE_SECRET_DAYS = 365

/** …and this long is flagged more loudly. */
export const VERY_STALE_SECRET_DAYS = 730

export class CredentialLifetimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialLifetimeError'
  }
}

/**
 * Resolve the expiry for a token being minted.
 *
 * Returns a concrete Date in every case — the whole point is that "no expiry"
 * stops being reachable. A caller that omits the field gets the default rather
 * than an unbounded token, and one that asks for longer than the cap is
 * refused rather than silently clamped: silently shortening a lifetime someone
 * explicitly chose produces a token that dies earlier than its owner planned
 * around, which is its own outage.
 */
export function resolveTokenExpiry(
  requested: Date | null | undefined,
  now: Date = new Date(),
): Date {
  if (!requested) return new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_DAYS * DAY_MS)

  const maxAllowed = new Date(now.getTime() + MAX_TOKEN_LIFETIME_DAYS * DAY_MS)
  if (requested.getTime() > maxAllowed.getTime()) {
    throw new CredentialLifetimeError(
      `A token may live at most ${MAX_TOKEN_LIFETIME_DAYS} days. ` +
        `Choose an expiry on or before ${maxAllowed.toISOString().slice(0, 10)}.`,
    )
  }
  if (requested.getTime() <= now.getTime()) {
    throw new CredentialLifetimeError('The expiry date must be in the future.')
  }
  return requested
}

// ── Staleness ──────────────────────────────────────────────────────────────

export type StalenessLevel = 'fresh' | 'aging' | 'stale' | 'expired'

export interface Staleness {
  level: StalenessLevel
  /** Whole days since the secret was last replaced. */
  ageDays: number
  /** Days until expiry; null when the credential has none. */
  expiresInDays: number | null
  /** One line, written for the person deciding whether to act. */
  summary: string
}

/**
 * Classify a stored secret by how long it has gone unrotated.
 *
 * Age is measured from the last ROTATION, not from creation — a credential
 * rotated last week is fresh however old the row is. Using createdAt would
 * report every well-maintained credential as ancient and train people to
 * ignore the warning.
 */
export function assessStaleness(params: {
  lastRotatedAt: Date | null
  createdAt: Date
  expiresAt?: Date | null
  now?: Date
}): Staleness {
  const now = params.now ?? new Date()
  const since = params.lastRotatedAt ?? params.createdAt
  const ageDays = Math.floor((now.getTime() - since.getTime()) / DAY_MS)
  const expiresInDays = params.expiresAt
    ? Math.floor((params.expiresAt.getTime() - now.getTime()) / DAY_MS)
    : null

  if (expiresInDays !== null && expiresInDays < 0) {
    return {
      level: 'expired',
      ageDays,
      expiresInDays,
      summary: `Expired ${Math.abs(expiresInDays)} days ago — anything using it is already failing.`,
    }
  }

  if (ageDays >= VERY_STALE_SECRET_DAYS) {
    return {
      level: 'stale',
      ageDays,
      expiresInDays,
      summary: `Not rotated in over ${Math.floor(ageDays / 365)} years. Rotate it.`,
    }
  }

  if (ageDays >= STALE_SECRET_DAYS) {
    return {
      level: 'stale',
      ageDays,
      expiresInDays,
      summary: `Not rotated in ${ageDays} days. Rotate it.`,
    }
  }

  // Warn before expiry, not at it: a credential that expires tomorrow is a
  // scheduled outage, and the useful moment to say so is while there is still
  // time to rotate it.
  if (expiresInDays !== null && expiresInDays <= 14) {
    return {
      level: 'aging',
      ageDays,
      expiresInDays,
      summary: `Expires in ${expiresInDays} days — rotate it before anything using it breaks.`,
    }
  }

  if (ageDays >= STALE_SECRET_DAYS / 2) {
    return {
      level: 'aging',
      ageDays,
      expiresInDays,
      summary: `Last rotated ${ageDays} days ago.`,
    }
  }

  return {
    level: 'fresh',
    ageDays,
    expiresInDays,
    summary: ageDays <= 1 ? 'Rotated today.' : `Last rotated ${ageDays} days ago.`,
  }
}
