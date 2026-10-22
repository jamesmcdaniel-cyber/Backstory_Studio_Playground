'use client'

import { ArrowRight, Loader2 } from 'lucide-react'
import { useEmbeddedOAuth } from '@/hooks/use-embedded-oauth'

type Props = {
  href: string
  label: string
  popupName: string
  embedded: boolean
  disabled?: boolean
  /** Re-read the server's setup status; true once THIS step is done. */
  check: () => Promise<boolean>
}

const BUTTON_CLASS =
  'mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-1 transition-all duration-fast ease-out-quart hover:bg-gray-800 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] aria-disabled:pointer-events-none aria-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50'

/**
 * One onboarding OAuth hand-off, rendered the only way its context allows.
 *
 * Top-level, it is a plain link — the browser follows the redirect chain and
 * comes back to /connect. Inside the Salesforce frame that exact link is a dead
 * end: the identity provider refuses to render framed, and the flow's
 * SameSite=Lax state cookie is never stored in a third-party context, so the
 * callback finds no state and redirects the frame back to step 1 — which is
 * what new users were hitting. Embedded, the same URL is opened in a popup,
 * where the flow is top-level and first-party, and the frame waits for the
 * server to agree the step is done: postMessage as the fast path, polling as
 * the one that always works (an IdP's COOP can sever the opener mid-flow).
 */
export function ConnectAction({ href, label, popupName, embedded, disabled, check }: Props) {
  // The popup + server-confirmed wait is shared with every other OAuth
  // surface; see useEmbeddedOAuth.
  const oauth = useEmbeddedOAuth()
  const waiting = oauth.waitingFor !== null

  if (!embedded) {
    return (
      <a href={href} aria-disabled={disabled} className={BUTTON_CLASS}>
        {label} <ArrowRight className="h-4 w-4" />
      </a>
    )
  }

  // `href` already returns to the embedded landing page (connectReturnPath).
  const start = () => oauth.open({ popupHref: href, popupName, check })

  return (
    <div>
      <button type="button" onClick={start} disabled={disabled || waiting} className={BUTTON_CLASS}>
        {waiting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for the connection…
          </>
        ) : (
          <>
            {label} <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
      {waiting && (
        <button
          type="button"
          onClick={oauth.checkNow}
          className="mt-2 text-xs text-fg-muted underline underline-offset-2"
        >
          I finished in the other window — check now
        </button>
      )}
      {oauth.timedOut && !waiting && (
        <p className="mt-2 text-xs text-fg-muted">
          We stopped waiting. If you finished in the other window, try again — it will pick up where it left off.
        </p>
      )}
      {oauth.blocked && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          The connection window was blocked. Allow pop-ups for this page and try again.
        </p>
      )}
    </div>
  )
}
