'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { TURNSTILE_ORIGIN, turnstileSiteKey } from '@/lib/auth/captcha'

/**
 * Cloudflare Turnstile widget for the auth forms.
 *
 * Renders nothing when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset, so local
 * development and any deployment that has not configured bot protection behave
 * exactly as before. See src/lib/auth/captcha.ts for why the token matters
 * (Supabase, not this app, is what verifies it).
 *
 * The token is single-use and expires: Turnstile invalidates it once Supabase
 * redeems it, and a failed sign-in must not retry with a spent token. `useTurnstile`
 * therefore exposes `reset()`, which every caller runs after an attempt
 * completes — otherwise the second sign-in attempt fails with a captcha error
 * that looks like a wrong password.
 */

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string
  reset: (id?: string) => void
  remove: (id?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_ID = 'cf-turnstile-script'

/** Load the Turnstile script once per document, shared by every widget. */
function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.turnstile) return Promise.resolve()

  const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null
  if (existing) {
    return new Promise((resolve) => existing.addEventListener('load', () => resolve(), { once: true }))
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load bot protection.'))
    document.head.appendChild(script)
  })
}

export interface TurnstileState {
  /** The current token, or undefined when unconfigured / not yet solved. */
  token: string | undefined
  /** True when a widget is showing and has not produced a token yet. */
  pending: boolean
  /** Discard the spent token and re-challenge. Run after EVERY auth attempt. */
  reset: () => void
  /** Render into the auth form; null when bot protection is not configured. */
  widget: React.ReactNode
}

export function useTurnstile(): TurnstileState {
  const siteKey = turnstileSiteKey()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [token, setToken] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false

    loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return
        if (widgetIdRef.current) return
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (value: string) => setToken(value),
          'error-callback': () => setError('Bot protection failed to load. Reload the page.'),
          // A solved token is only valid for a few minutes. Clearing it on
          // expiry means the form blocks on a fresh challenge rather than
          // submitting a token Supabase will reject.
          'expired-callback': () => setToken(undefined),
          'timeout-callback': () => setToken(undefined),
          appearance: 'interaction-only',
          theme: 'auto',
        })
      })
      .catch(() => {
        if (!cancelled) setError('Bot protection failed to load. Reload the page.')
      })

    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }
    }
  }, [siteKey])

  const reset = useCallback(() => {
    setToken(undefined)
    if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current)
  }, [])

  const id = useId()

  return {
    token,
    // Unconfigured means "never pending" — the form must not block on a widget
    // that will never appear.
    pending: Boolean(siteKey) && !token,
    reset,
    widget: siteKey ? (
      <div className="flex flex-col gap-1" key={id}>
        <div ref={containerRef} />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    ) : null,
  }
}
