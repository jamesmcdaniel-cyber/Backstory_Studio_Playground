import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Content Repository' }

export default function DataTablesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
