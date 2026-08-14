import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Credentials' }

export default function CredentialsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
