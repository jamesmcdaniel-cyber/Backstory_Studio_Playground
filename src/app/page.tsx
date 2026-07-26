import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthGateway } from '@/components/auth/auth-gateway'
import { createClient } from '@/lib/supabase/server'

// Auth is checked per request so a signed-in user never flashes the gateway.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign in — Backstory Studio',
  description: 'Secure access to the Backstory intelligence workspace.',
}

export default async function Home() {
  let user = null
  try {
    const supabase = await createClient()
    user = (await supabase.auth.getUser()).data.user
  } catch {
    // The access screen remains useful in local environments before Supabase
    // has been configured.
  }

  if (user) redirect('/dashboard')
  return <AuthGateway />
}
