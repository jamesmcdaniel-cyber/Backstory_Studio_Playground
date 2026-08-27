import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Data Tables' }

export default function DataTablesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
