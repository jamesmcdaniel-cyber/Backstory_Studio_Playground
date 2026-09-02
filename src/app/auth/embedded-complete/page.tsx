import type { Metadata } from 'next'
import { EmbeddedComplete } from '@/components/auth/embedded-complete'

export const metadata: Metadata = {
  title: 'Signed in — Backstory Studio',
}

/** Where the sign-in POPUP lands once the embedded flow's OAuth completes. */
export default function EmbeddedCompletePage() {
  return <EmbeddedComplete />
}
