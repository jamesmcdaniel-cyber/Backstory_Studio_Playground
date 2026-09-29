import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { isCustomerEdition } from '@/lib/edition'

export const metadata: Metadata = { title: 'ROI analysis' }

/**
 * /roi builds a customer's ROI story from People.ai warehouse extracts. It is
 * an operator surface: the customer edition 404s it at the edge (middleware)
 * and again here, and every API it calls is internalOnly.
 */
export default function RoiLayout({ children }: { children: React.ReactNode }) {
  if (isCustomerEdition()) notFound()
  return <>{children}</>
}
