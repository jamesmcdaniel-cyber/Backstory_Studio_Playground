import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { requireAuthContext } from '@/lib/server/auth'
import { isCustomerEdition } from '@/lib/edition'

export const metadata: Metadata = { title: 'Admin' }

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
  // The shell admits both operator tiers because /admin holds two different
  // surfaces: Reviews is catalogue moderation, which a PARTNER-org reviewer
  // legitimately does, while Costs/Domains/Users are the operator console and
  // require platform.administer. Gating the shell on the stricter permission
  // would lock partners out of the only page they are here for, so the split is
  // enforced per page (requirePlatformAdmin) and, authoritatively, per route.
  const auth = await requireAuthContext().catch(() => null)
  if (!auth?.can('catalogue.review') && !auth?.can('platform.administer')) redirect('/dashboard')
  // No container here: /admin is in AppShell's APP_PREFIXES, so the shell
  // already applies PAGE_CONTAINER around these pages like every other route.
  return <>{children}</>
}
