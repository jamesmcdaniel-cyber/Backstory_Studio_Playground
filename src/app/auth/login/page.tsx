import type { Metadata } from 'next'
import { AuthGateway } from '@/components/auth/auth-gateway'

export const metadata: Metadata = {
  title: 'Sign in — Backstory Studio',
  description: 'Secure access to the Backstory intelligence workspace.',
}

export default function LoginPage() {
  return <AuthGateway />
}
