'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSupabase } from '@/components/providers/supabase-provider'

type AuthContext = {
  userId: string
  organizationId: string
  role: string
  permissions?: string[]
}

export function useAuth() {
  const { user, loading, signOut } = useSupabase()
  const [context, setContext] = useState<AuthContext | null>(null)
  const [contextLoading, setContextLoading] = useState(false)

  useEffect(() => {
    if (!user) {
      setContext(null)
      return
    }
    // Optimistic paint from JWT metadata so the shell doesn't flash, but it
    // carries no permissions — those are resolved server-side per request, so
    // the fetch below always runs and overwrites this.
    const metadataOrganization = user.user_metadata?.organization_id
    if (metadataOrganization) {
      setContext({
        userId: user.id,
        organizationId: metadataOrganization,
        role: user.user_metadata?.role || 'USER',
      })
    }

    setContextLoading(true)
    fetch('/api/auth/context', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setContext(data.success ? data.context : null))
      .finally(() => setContextLoading(false))
  }, [user])

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
      await signOut()
      // replace() drops the (now signed-out) page from history so Back can't
      // return to it; the bfcache guard covers any earlier protected pages.
      window.location.replace('/auth/login')
    },
    isAdmin: context?.role === 'ADMIN',
    role: context?.role || null,
    permissions: context?.permissions ?? [],
    // Which affordances render. Cosmetic only — every gated call is re-checked
    // server-side, so a tampered client gains nothing by lying here.
    can: (permission: string) => Boolean(context?.permissions?.includes(permission)),
    organizationId: context?.organizationId || null,
    needsOrganizationSetup: Boolean(user && !context && !contextLoading),
  }), [context, contextLoading, loading, signOut, user])
}
