/**
 * Where a provider's brand logo can come from, in the order we try them.
 *
 * The catalogue is whatever the Nango environment has enabled, so the provider
 * keys are not ours to curate: they arrive auth-method-qualified
 * ("gong-oauth", "github-user-oauth", "apollo-api-key") and hyphenated
 * ("google-calendar"). Both shapes miss a naive Simple Icons lookup, which is
 * why cards used to fall through to a grey initial tile.
 *
 * So we resolve a provider through four sources, best-known first:
 *   1. a bundled asset in public/logos (brands we host ourselves)
 *   2. the logo URL the catalogue handed us (Nango's own CDN)
 *   3. Simple Icons, by de-qualified slug — covers most developer brands
 *   4. the brand's favicon, by domain — covers everything else (Gong, Clari,
 *      Outreach, BambooHR…), and 404s cleanly for a domain that isn't real
 *
 * No React here on purpose: the resolution order is unit-testable.
 */

/**
 * Auth-method qualifiers Nango appends to a provider key. Stripped repeatedly,
 * so "github-user-oauth" and "apollo-oauth2" both reduce to the brand.
 */
const AUTH_QUALIFIER = /-(?:user-)?(?:oauth2?|api-?key|basic|bearer|pat|token|jwt|app|sandbox)$/

/** The brand behind a config key: "gong-oauth" → "gong". */
export function brandSlug(slug: string): string {
  let base = slug.toLowerCase().trim()
  for (let previous = ''; base !== previous; ) {
    previous = base
    base = base.replace(AUTH_QUALIFIER, '')
  }
  return base
}

const compact = (slug: string) => slug.replace(/[^a-z0-9]/g, '')

// Brand → Simple Icons slug, only where compacting the key isn't enough
// ("google-calendar" → "googlecalendar" needs no entry).
const SIMPLE_ICON_SLUGS: Record<string, string> = {
  monday: 'mondaydotcom',
  'google-mail': 'gmail',
  googlemail: 'gmail',
  'google-drive': 'googledrive',
  'launch-darkly': 'launchdarkly',
  teams: 'microsoftteams',
  'microsoft-teams': 'microsoftteams',
  outlook: 'microsoftoutlook',
  'microsoft-outlook': 'microsoftoutlook',
  excel: 'microsoftexcel',
  onedrive: 'microsoftonedrive',
  sharepoint: 'microsoftsharepoint',
  'aws-iam': 'amazonwebservices',
  'google-ads': 'googleads',
}

// Brand → the domain whose favicon is the logo. Only needed where the brand
// isn't <slug>.com; a .com brand needs no entry.
const BRAND_DOMAINS: Record<string, string> = {
  gong: 'gong.io',
  clari: 'clari.com',
  'clari-copilot': 'clari.com',
  apollo: 'apollo.io',
  outreach: 'outreach.io',
  chorus: 'chorus.ai',
  granola: 'granola.ai',
  greenhouse: 'greenhouse.io',
  lever: 'lever.co',
  attio: 'attio.com',
  bamboo: 'bamboohr.com',
  people: 'people.ai',
  'people-ai': 'people.ai',
  peopleai: 'people.ai',
  drift: 'drift.com',
  'sixsense': '6sense.com',
  '6sense': '6sense.com',
  gainsight: 'gainsight.com',
  seismic: 'seismic.com',
  highspot: 'highspot.com',
  mixmax: 'mixmax.com',
  // Google's product keys ("google-calendar", "google-mail") share one domain.
  google: 'google.com',
  microsoft: 'microsoft.com',
}

/** The domain to pull a favicon from: mapped brand, else <brand>.com. */
export function brandDomain(brand: string): string {
  const mapped = BRAND_DOMAINS[brand]
  if (mapped) return mapped
  // Product keys under a parent brand ("google-calendar") fall back to the
  // parent's domain rather than a nonexistent "google-calendar.com".
  const parent = brand.includes('-') ? BRAND_DOMAINS[brand.split('-')[0]] : undefined
  return parent ?? `${brand}.com`
}

// Bundled brand assets (public/logos), preferred over every remote source —
// used wherever a provider's logo renders (run logs, cards, the catalogue).
// Keyed by COMPACTED brand, so "google_drive", "google-drive" and
// "googledrive" all resolve to one asset.
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
  apollo: '/logos/apollo.png',
  apolloio: '/logos/apollo.png',
}

function localLogo(brand: string): string | undefined {
  const key = compact(brand)
  // Custom Backstory MCP connections slugify to backstory_mcp / backstorymcp /
  // "backstory mcp" etc.; any variant containing "backstory" gets the mark.
  if (key.includes('backstory')) return LOCAL_LOGOS.backstory
  return LOCAL_LOGOS[key]
}

/**
 * Ordered logo URLs to try for a provider. The consumer renders the first and
 * advances on load error, so a dead source never leaves a broken image — and
 * only a provider that fails every source shows an initial tile.
 */
export function logoSources({ src, slug }: { src?: string | null; slug?: string | null }): string[] {
  const key = (slug || '').toLowerCase().trim()
  const brand = key ? brandSlug(key) : ''
  const sources: string[] = []

  const local = brand ? localLogo(brand) : undefined
  if (local) sources.push(local)
  if (src) sources.push(src)

  if (brand) {
    const icon = SIMPLE_ICON_SLUGS[key] ?? SIMPLE_ICON_SLUGS[brand] ?? compact(brand)
    // Brand-colored SVG, no API key.
    if (icon) sources.push(`https://cdn.simpleicons.org/${icon}`)
    // Favicon of the brand's own site — 404s (and so falls through) when the
    // guessed domain doesn't exist.
    sources.push(`https://icons.duckduckgo.com/ip3/${brandDomain(brand)}.ico`)
  }

  return sources.filter((url, index) => sources.indexOf(url) === index)
}
