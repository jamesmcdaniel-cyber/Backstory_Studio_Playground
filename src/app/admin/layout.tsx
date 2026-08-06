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
  // No container here: /admin is in AppShell's APP_PREFIXES, so the shell
  // already applies PAGE_CONTAINER around these pages like every other route.
  return <>{children}</>
}
