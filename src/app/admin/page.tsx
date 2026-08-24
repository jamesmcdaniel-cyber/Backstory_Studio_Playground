import { redirect } from 'next/navigation'
import { requireAuthContext } from '@/lib/server/auth'

/**
 * `/admin` held a layout and four child routes but no page of its own, so the
 * bare path 404'd — which is how the queue-plane alert (it linked here) sent
 * every operator who clicked a dead-letter notification to not-found.
 *
 * A redirect rather than a hub page: the sidebar already lands the two
 * operator tiers on their own consoles, and this keeps the URL alive for
 * bookmarks and older notification rows without adding a second surface that
 * has to be kept in step with them. Same reasoning as /admin/domains.
 *
 * Tier-aware because /admin/layout.tsx admits both: a PARTNER-org reviewer
 * holds catalogue.review only and would bounce off /admin/users.
 */
export default async function AdminIndexPage() {
  const auth = await requireAuthContext().catch(() => null)
  redirect(auth?.can('platform.administer') ? '/admin/users' : '/admin/catalogue')
}
