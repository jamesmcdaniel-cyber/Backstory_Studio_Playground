import type { Metadata } from 'next'
import { EmbeddedComplete } from '@/components/auth/embedded-complete'

export const metadata: Metadata = {
  title: 'Setup — Backstory Studio',
}

/** Where every embedded POPUP lands once its flow completes — sign-in and
 *  both onboarding connect steps. */
export default function EmbeddedCompletePage() {
  return <EmbeddedComplete />
}
