/**
 * Embedded-context helpers (the app inside a Salesforce iframe).
 *
 * Sign-in cannot happen INSIDE the frame: Google (and every serious IdP)
 * refuses to render OAuth in an iframe. So an embedded gateway opens the real
 * login page in a POPUP, where the full flow runs top-level, and the frame
 * finds out it worked in two ways:
 *
 *  - fast path: the popup's landing page posts EMBED_SIGNIN_MESSAGE. This can
 *    be severed — Google's pages carry COOP, which can cut window.opener mid
 *    flow — so it is an accelerator, never the mechanism.
 *  - always-works path: the frame polls its own origin and reloads when the
 *    session cookie starts answering. A same-origin fetch from the frame
 *    carries the (SameSite=None) session cookie exactly when the embedded app
 *    itself would, so the poll cannot report a session the frame can't use.
 */

export const EMBED_SIGNIN_MESSAGE = 'backstory:embed-signed-in'

export function isEmbedded(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch {
    // A cross-origin top throws on access — which is itself the answer.
    return true
  }
}

/** The popup runs the FULL login flow top-level, then lands on the
 *  embedded-complete page, which notifies and closes. */
export function embeddedSignInUrl(): string {
  return '/auth/login?return_to=%2Fauth%2Fembedded-complete'
}

export function openEmbeddedSignIn(): Window | null {
  return window.open(embeddedSignInUrl(), 'backstory-signin', 'popup,width=560,height=760')
}

/**
 * Whether this frame now holds a working session: probe our own origin and
 * see if the auth middleware still bounces to login. `redirect: 'manual'`
 * keeps the probe honest — a redirect IS the "not signed in" answer.
 */
export async function probeSession(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl('/agents', { method: 'HEAD', redirect: 'manual', cache: 'no-store' })
    return response.status === 200
  } catch {
    return false
  }
}
