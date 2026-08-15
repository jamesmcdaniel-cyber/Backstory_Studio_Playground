'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { clearClientCaches, syncCacheOwner } from '@/lib/client/cache-owner'

const supabase = createClient()

// Pages a signed-out user may see (mirrors the middleware allow-list).
const PUBLIC_PATHS = new Set(['/', '/privacy', '/terms', '/auth-code-error'])

/** The canonical app origin for auth redirects: the configured production URL
 *  when set (so links never point at localhost/preview), else the live origin. */
function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '')
  if (configured) return configured
  return typeof window !== 'undefined' ? window.location.origin : ''
}

type SupabaseContext = {
  user: User | null
  loading: boolean
  /** `captchaToken` comes from useTurnstile(). Supabase — not this app — is what
   *  verifies it; see src/lib/auth/captcha.ts for why it cannot be enforced here. */
  signIn: (email: string, password: string, captchaToken?: string) => ReturnType<typeof supabase.auth.signInWithPassword>
  signUp: (email: string, password: string, options?: { data?: Record<string, unknown>; captchaToken?: string }) => ReturnType<typeof supabase.auth.signUp>
  /** Send a password-recovery email. Carries a captcha token for the same reason. */
  resetPassword: (email: string, captchaToken?: string) => ReturnType<typeof supabase.auth.resetPasswordForEmail>
  /** Start the Google OAuth redirect. `nextPath` (a same-origin path) is carried
   *  through the callback so the user lands where they intended after auth. */
  signInWithGoogle: (nextPath?: string) => ReturnType<typeof supabase.auth.signInWithOAuth>
  signInWithSSO: (domain: string, nextPath?: string) => ReturnType<typeof supabase.auth.signInWithSSO>
  mfa: typeof supabase.auth.mfa
  signOut: () => Promise<void>
}

const Context = createContext<SupabaseContext | null>(null)

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // The client caches (snapshot, SWR responses, flow clipboard) hold workspace
  // data and outlive a session, so every identity transition — first load,
  // sign-in, sign-out, a sign-out in another tab, an account switch — has to
  // reconcile them. syncCacheOwner wipes when the owner changes and is a no-op
  // otherwise, so it is safe to call on every auth event.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      syncCacheOwner(data.user?.id ?? null)
      setUser(data.user)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      syncCacheOwner(session?.user?.id ?? null)
      setUser(session?.user ?? null)
      setLoading(false)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  // Back-forward cache guard. Pressing "Back" after sign-out can restore an
  // authenticated page straight from the bfcache WITHOUT hitting the server, so
  // the middleware redirect never runs. On any bfcache restore — and whenever a
  // backgrounded protected tab is refocused — we hide the page IMMEDIATELY (so
  // no protected content flashes), re-check the session from local storage, and
  // either reveal it or bounce to sign-in. Public pages are exempt.
  useEffect(() => {
    const onProtectedPath = () => {
      const path = window.location.pathname
      return !PUBLIC_PATHS.has(path) && !path.startsWith('/auth/')
    }
    const reveal = () => {
      document.documentElement.style.visibility = ''
    }
    const bounceIfSignedOut = async () => {
      const { data } = await supabase.auth.getSession()
      if (!data.session) {
        window.location.replace(`/auth/login?return_to=${encodeURIComponent(window.location.pathname)}`)
        return false
      }
      return true
    }
    // bfcache restore shows STALE cached content, so hide first to prevent a
    // flash, then verify.
    const guardBfcache = async () => {
      if (!onProtectedPath()) return
      document.documentElement.style.visibility = 'hidden'
      try {
        if (await bounceIfSignedOut()) reveal()
      } catch {
        window.location.reload() // couldn't verify — let the server (middleware) decide
      }
    }
    // A refocused live tab shows CURRENT content, so no hide needed (no flicker);
    // catch a sign-out that happened in another tab.
    const guardBackground = () => {
      if (onProtectedPath()) void bounceIfSignedOut().catch(() => undefined)
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void guardBfcache()
      else reveal()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') guardBackground()
    }
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisibility)
      reveal()
    }
  }, [])

  const value = useMemo<SupabaseContext>(() => ({
    user,
    loading,
    signIn: (email, password, captchaToken) => supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
      options: { captchaToken },
    }),
    signUp: (email, password, options) => supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: options?.data,
        captchaToken: options?.captchaToken,
        // Prefer the configured production URL so confirmation links never point
        // at localhost or a preview origin; fall back to the current origin.
        emailRedirectTo: `${appOrigin()}/auth/callback`,
      },
    }),
    resetPassword: (email, captchaToken) => supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { captchaToken, redirectTo: `${appOrigin()}/auth/update-password` },
    ),
    signInWithGoogle: (nextPath) => {
      // Redirect back through our own callback (which exchanges the code for a
      // session), carrying `next` so invitees resume their deep-linked page.
      const redirect = new URL(`${appOrigin()}/auth/callback`)
      if (nextPath && /^\/(?!\/)/.test(nextPath)) redirect.searchParams.set('next', nextPath)
      return supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirect.toString(),
          // Force Google to re-verify the account on EVERY sign-in instead of
          // silently reusing its remembered session. For the company domains,
          // Google Workspace federates authentication to Okta, so this is what
          // makes Okta verification happen each time someone signs in here
          // rather than only the first time.
          queryParams: { prompt: 'login' },
        },
      })
    },
    signInWithSSO: (domain, nextPath) => {
      const redirect = new URL(`${appOrigin()}/auth/callback`)
      if (nextPath && /^\/(?!\/)/.test(nextPath)) redirect.searchParams.set('next', nextPath)
      return supabase.auth.signInWithSSO({
        domain: domain.trim().toLowerCase(),
        options: { redirectTo: redirect.toString() },
      })
    },
    mfa: supabase.auth.mfa,
    signOut: async () => {
      // Clear BEFORE awaiting the network call, and independently of the
      // onAuthStateChange listener above: sign-out is usually followed by an
      // immediate navigation, which can unmount this provider before the event
      // fires. The wipe must not depend on winning that race.
      clearClientCaches()
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    },
  }), [loading, user])

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useSupabase() {
  const context = useContext(Context)
  if (!context) throw new Error('useSupabase must be used within SupabaseProvider')
  return context
}
