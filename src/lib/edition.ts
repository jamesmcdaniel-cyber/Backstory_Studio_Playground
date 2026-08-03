import { EDITION } from './edition.config'

export type Edition = 'internal' | 'customer'

/**
 * Test-only override. Guarded three ways so it can never relax a real deploy:
 * refused in production, ignored unless it names a known edition, and safe in
 * the browser bundle where `process` may not exist at all.
 */
function envOverride(): Edition | null {
  if (typeof process === 'undefined') return null
  if (process.env.NODE_ENV === 'production') return null
  const value = process.env.APP_EDITION
  return value === 'customer' || value === 'internal' ? value : null
}

/** Resolved per call, not cached, so tests can flip editions in one process. */
export function appEdition(): Edition {
  return envOverride() ?? EDITION
}

export function isCustomerEdition(): boolean {
  return appEdition() === 'customer'
}

export function isInternalEdition(): boolean {
  return appEdition() === 'internal'
}

/**
 * Page prefixes the customer edition refuses outright, checked at the edge.
 *
 * Pages only. The `/api/admin/*` routes behind these pages carry their own
 * `internalOnly` gate on the handler, which answers 404 before auth — two
 * distinct layers, deliberately not collapsed into one prefix match.
 */
const CUSTOMER_BLOCKED_PREFIXES = ['/admin']

/**
 * Whether the current edition must refuse `pathname` before any auth work.
 * Prefix matching is boundary-aware so `/administrate` is not caught by `/admin`.
 */
export function isEditionBlockedPath(pathname: string): boolean {
  if (!isCustomerEdition()) return false
  return CUSTOMER_BLOCKED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}
