'use client'

import { createBrowserClient } from '@supabase/ssr'
import { getSupabaseConfig, SUPABASE_COOKIE_OPTIONS } from './config'

export function createClient() {
  const { url, anonKey } = getSupabaseConfig()
  // SUPABASE_COOKIE_OPTIONS is applied here too, not only on the server clients.
  // The browser client WRITES the session cookie after sign-in and on every
  // token refresh, and without these options it wrote them with the library
  // defaults — no `secure`, no `sameSite`. The server's careful cookie flags
  // were being overwritten by an unflagged pair on the very next refresh.
  return createBrowserClient(url, anonKey, { cookieOptions: SUPABASE_COOKIE_OPTIONS })
}
