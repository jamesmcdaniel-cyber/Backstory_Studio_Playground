import { redirect } from 'next/navigation'

// Domain access moved to Settings → Platform, beside the other permissions
// administration. This URL stays so existing links and bookmarks still land on
// it — a redirect rather than a second copy of the panel, because two surfaces
// for one decision is how they drift. /admin/layout.tsx still gates the path.
export default function DomainsPage() {
  redirect('/settings?tab=platform')
}
