/**
 * Origin check for state-changing requests — the CSRF stand-in that SameSite
 * cookies used to be.
 *
 * Embedding the app (Salesforce, and whatever comes after) forced the session
 * cookies from Lax to None: a Lax cookie is never sent inside a third-party
 * iframe at all, so an embedded app would be permanently signed out. But None
 * also means a hostile page can make the browser attach the session to a
 * cross-site fetch — the attack Lax existed to stop. This guard restores that
 * property at the request layer.
 *
 * The rule is deliberately narrow: only WRITES, and only when the browser
 * declared a cross-site (or opaque) Origin. Requests with no Origin header —
 * servers, webhooks, CLI and API-key clients — pass untouched; browsers
 * always attach Origin to cross-site writes, which is the case being policed.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function rejectsCrossOriginWrite(
  method: string,
  originHeader: string | null | undefined,
  requestOrigin: string,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false
  if (originHeader === null || originHeader === undefined || originHeader === '') return false
  // 'null' is the opaque origin — a sandboxed document or a chain of
  // cross-site redirects. Not a caller the session should vouch for.
  return originHeader !== requestOrigin
}
