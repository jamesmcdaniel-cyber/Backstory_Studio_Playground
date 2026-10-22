'use client'

import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSupabase } from '@/components/providers/supabase-provider'
import { nextAuthContextStep, type AuthContextValue, type AuthSeed } from './auth-context-state'

const AuthSeedContext = createContext<AuthSeed | null>(null)

/** Hands the server-resolved context (root layout) to every useAuth below it. */
export function AuthSeedProvider({ seed, children }: { seed: AuthSeed | null; children: ReactNode }) {
  return createElement(AuthSeedContext.Provider, { value: seed }, children)
}

// Browser-only: shared by every useAuth caller, so the sidebar, settings and
// the rest make ONE /api/auth/context request per user instead of one each.
// (Effects never run on the server, so this is never written during SSR.)
let cached: AuthSeed | null = null
let inflight: { authUserId: string; promise: Promise<AuthSeed | null> } | null = null
// Page load counts as fresh: the seed or the first fetch just resolved it.
let lastRevalidated = Date.now()

function fetchContext(authUserId: string): Promise<AuthSeed | null> {
  if (inflight?.authUserId === authUserId) return inflight.promise
  const promise = fetch('/api/auth/context', { cache: 'no-store' })
    .then((response) => response.json())
    .then((data) => {
      cached = data.success ? { authUserId, context: data.context as AuthContextValue } : null
      return cached
    })
    .catch(() => null)
    .finally(() => { if (inflight?.promise === promise) inflight = null })
  inflight = { authUserId, promise }
  return promise
}

export function useAuth() {
  const { user, loading, signOut } = useSupabase()
  const seed = useContext(AuthSeedContext)
  const sessionUserId = user?.id ?? null
  const [context, setContext] = useState<AuthContextValue | null>(
    () => nextAuthContextStep({ seed, cached, sessionLoading: true, sessionUserId: null }).context,
  )
  const [contextLoading, setContextLoading] = useState(false)

  useEffect(() => {
    const step = nextAuthContextStep({ seed, cached, sessionLoading: loading, sessionUserId })
    setContext(step.context)
    if (!step.fetch || !sessionUserId) return
    let current = true
    setContextLoading(true)
    void fetchContext(sessionUserId).then((resolved) => {
      if (!current) return
      setContext(resolved?.context ?? null)
      setContextLoading(false)
    })
    return () => { current = false }
  }, [seed, loading, sessionUserId])

  // A role or permission change made elsewhere shows up when the tab is next
  // focused, quietly (no loading state, so nothing flashes) and at most once
  // a minute across every caller.
  useEffect(() => {
    if (!sessionUserId) return
    const revalidate = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastRevalidated < 60_000) return
      lastRevalidated = Date.now()
      void fetchContext(sessionUserId).then((resolved) => { if (resolved?.authUserId === sessionUserId) setContext(resolved.context) })
    }
    window.addEventListener('focus', revalidate)
    return () => window.removeEventListener('focus', revalidate)
  }, [sessionUserId])

  return useMemo(() => ({
    isLoaded: !loading && !contextLoading,
    isSignedIn: Boolean(user),
    userId: user?.id || null,
    user: user ? {
      id: user.id,
      firstName: user.user_metadata?.first_name || user.user_metadata?.full_name?.split(' ')[0] || 'User',
      lastName: user.user_metadata?.last_name || '',
      emailAddress: user.email || '',
    } : null,
    loading: loading || contextLoading,
    signIn: () => { window.location.href = '/auth/login' },
    signUp: () => { window.location.href = '/auth/signup' },
    signOut: async () => {
      cached = null
      await signOut()
      // replace() drops the (now signed-out) page from history so Back can't
      // return to it; the bfcache guard covers any earlier protected pages.
      window.location.replace('/auth/login')
    },
    isAdmin: context?.role === 'ADMIN' || context?.role === 'OWNER',
    role: context?.role || null,
    permissions: context?.permissions ?? [],
    // Which affordances render. Cosmetic only — every gated call is re-checked
    // server-side, so a tampered client gains nothing by lying here.
    can: (permission: string) => Boolean(context?.permissions?.includes(permission)),
    organizationId: context?.organizationId || null,
    needsOrganizationSetup: Boolean(user && !context && !contextLoading),
  }), [context, contextLoading, loading, signOut, user])
}
