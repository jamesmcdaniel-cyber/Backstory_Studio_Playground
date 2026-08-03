import { notFound, redirect } from 'next/navigation'
import { requireAuthContext } from '@/lib/server/auth'
import { isCustomerEdition } from '@/lib/edition'

/**
 * The admin surface is invisible to customer workspaces: no nav entry, and a
 * direct URL redirects rather than rendering a shell they cannot use.
 *
 * This is presentation only — every route the page calls re-checks
 * catalogue.review server-side, so bypassing the redirect gains nothing.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // The customer edition has no operator console at all — a 404, not a redirect,
  // because the surface should not appear to exist. Middleware refuses this path
  // at the edge too; this is the second layer.
  if (isCustomerEdition()) notFound()
  const auth = await requireAuthContext().catch(() => null)
  if (!auth?.can('catalogue.review')) redirect('/dashboard')
  return <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
}
