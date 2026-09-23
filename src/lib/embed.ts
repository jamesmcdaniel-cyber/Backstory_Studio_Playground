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

/**
 * Posted when a CONNECT flow run in the popup has finished, whether it worked
 * or not. It is a "go look again" nudge, never a verdict: the frame re-reads
 * /api/setup/status and believes that.
 */
export const EMBED_CONNECT_DONE_MESSAGE = 'backstory:embed-connect-done'

/** Where every popup-run flow lands: the one page that can notify the frame
 *  and close itself. */
export const EMBED_COMPLETE_PATH = '/auth/embedded-complete'

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
  return `/auth/login?return_to=${encodeURIComponent(EMBED_COMPLETE_PATH)}`
}

/**
 * Open a flow the frame cannot run itself in a popup, where it is top-level.
 *
 * This is the ONLY way an OAuth connect can work from inside the frame, for
 * two independent reasons: the identity provider refuses to render framed at
 * all, and the flow's SameSite=Lax state cookie is never stored in a
 * third-party frame — so the callback finds no state and bounces the frame
 * back to the start of onboarding. A popup is a first-party, top-level
 * context, where both hold.
 */
export function openEmbeddedPopup(url: string, name: string): Window | null {
  return window.open(url, name, 'popup,width=560,height=760')
}

export function openEmbeddedSignIn(): Window | null {
  return openEmbeddedPopup(embeddedSignInUrl(), 'backstory-signin')
}

export type EmbedCompletion = {
  outcome: 'signed-in' | 'connected' | 'failed'
  message: typeof EMBED_SIGNIN_MESSAGE | typeof EMBED_CONNECT_DONE_MESSAGE
}

/**
 * What the popup's landing page just witnessed, read off its own query string.
 *
 * Sign-in lands here bare; every connect callback appends its outcome
 * (`connected=1` / `peopleai=<status>` / `error=<code>`), so the presence of an
 * outcome parameter is what separates the two flows. A failure still posts the
 * connect-done message — the frame must stop waiting and show what happened,
 * not sit on a spinner until the user gives up.
 */
export function resolveEmbedCompletion(search: string): EmbedCompletion {
  const params = new URLSearchParams(search)
  const peopleai = params.get('peopleai')
  if (params.get('error') || (peopleai && peopleai !== 'connected')) {
    return { outcome: 'failed', message: EMBED_CONNECT_DONE_MESSAGE }
  }
  if (params.get('connected') === '1' || peopleai === 'connected') {
    return { outcome: 'connected', message: EMBED_CONNECT_DONE_MESSAGE }
  }
  return { outcome: 'signed-in', message: EMBED_SIGNIN_MESSAGE }
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
