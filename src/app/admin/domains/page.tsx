'use client'

import { DomainsPanel } from '@/components/admin/domains-panel'

// Kept as its own URL so existing links and bookmarks still resolve; the same
// panel is the Access tab of the Reviews console, which is how it is reached
// in the UI. /admin/layout.tsx is the gate for both.
export default function DomainsPage() {
  return <DomainsPanel />
}
