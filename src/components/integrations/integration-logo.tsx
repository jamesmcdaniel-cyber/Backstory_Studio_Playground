'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Brand logo for an integration/MCP provider.
 *
 * Source order: an explicit `src` (e.g. Nango's brand-logo CDN, returned by the
 * integrations API) → Simple Icons CDN by provider slug → a monochrome initial
 * tile. Any load error falls through to the next source, so a missing logo
 * never leaves a broken image.
 */

// Nango provider key → Simple Icons slug (https://simpleicons.org).
// Only entries that differ from the raw provider key, or need pinning, matter;
// unmapped providers try the key itself, then fall back to an initial tile.
const SIMPLE_ICON_SLUGS: Record<string, string> = {
  github: 'github',
  slack: 'slack',
  linear: 'linear',
  jira: 'jira',
  asana: 'asana',
  notion: 'notion',
  zendesk: 'zendesk',
  hubspot: 'hubspot',
  monday: 'mondaydotcom',
  gmail: 'gmail',
  'google-mail': 'gmail',
  googlemail: 'gmail',
  salesforce: 'salesforce',
  'salesforce-sandbox': 'salesforce',
  snowflake: 'snowflake',
  airtable: 'airtable',
  confluence: 'confluence',
  trello: 'trello',
  clickup: 'clickup',
  'google-drive': 'googledrive',
  googledrive: 'googledrive',
  launchdarkly: 'launchdarkly',
  'launch-darkly': 'launchdarkly',
}

function simpleIconUrl(slug: string): string {
  // Brand-colored SVG, no API key. Falls back gracefully via onError.
  return `https://cdn.simpleicons.org/${slug}`
}

// Bundled brand assets (public/logos), preferred over any passed src or the
// Simple Icons CDN — used wherever a provider's logo renders (run logs, cards,
// integrations catalogue). Keyed by NORMALIZED slug (separators stripped) so
// "google_drive", "google-drive" and "googledrive" all resolve to one asset.
const LOCAL_LOGOS: Record<string, string> = {
  slack: '/logos/slack.png',
  granola: '/logos/granola.jpg',
  // Salesforce was removed from the Simple Icons CDN (trademark), so bundle it.
  salesforce: '/logos/salesforce.svg',
  backstory: '/backstory-symbol-black.png',
  googledrive: '/logos/googledrive.svg',
  googlesheets: '/logos/googlesheets.webp',
  monday: '/logos/monday.jpg',
  mondaydotcom: '/logos/monday.jpg',
  qwen: '/logos/qwen.webp',
  // Apollo has no Simple Icons entry, and Nango keys it several ways.
  apollo: '/logos/apollo.png',
  apolloio: '/logos/apollo.png',
  apollooauth: '/logos/apollo.png',
}

function localLogo(slug: string): string | undefined {
  const key = slug.replace(/[-_\s]/g, '')
  // Custom Backstory MCP connections slugify to backstory_mcp / backstorymcp /
  // "backstory mcp" etc.; any variant containing "backstory" gets the mark.
  if (key.includes('backstory')) return LOCAL_LOGOS.backstory
  return LOCAL_LOGOS[key]
}

export function IntegrationLogo({
  src,
  slug,
  name,
  className,
}: {
  src?: string | null
  slug?: string | null
  name: string
  className?: string
}) {
  const key = (slug || '').toLowerCase()
  // A bundled asset for this provider wins over any passed src or the CDN.
  const effectiveSrc = localLogo(key) ?? src
  const iconSlug = SIMPLE_ICON_SLUGS[key] ?? (key || null)
  // 0 = explicit/local src, 1 = simple-icons, 2 = initial fallback.
  const initialStage = effectiveSrc ? 0 : slug ? 1 : 2
  const [stage, setStage] = useState(initialStage)

  const box = cn('flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded', className)

  if (stage === 0 && effectiveSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={effectiveSrc}
        alt=""
        className={box}
        onError={() => setStage(iconSlug ? 1 : 2)}
      />
    )
  }

  if (stage === 1 && iconSlug) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={simpleIconUrl(iconSlug)}
        alt=""
        className={box}
        onError={() => setStage(2)}
      />
    )
  }

  return (
    <span
      className={cn(box, 'bg-gray-100 text-[11px] font-semibold uppercase text-gray-600')}
      aria-hidden
    >
      {name.trim().charAt(0) || '?'}
    </span>
  )
}
