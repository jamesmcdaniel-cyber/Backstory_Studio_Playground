/**
 * Pure helpers for turning a template's declared integration name into
 * something the UI can render and act on.
 *
 * Templates store integrations as free text that mixes three vocabularies:
 * internal plane keys ("nango:salesforce"), branded product names
 * ("Backstory MCP") and capability names ("HTTP API", "Email"). Every surface
 * that shows a requirement — chips, banners, the connect dialog — needs the
 * same three answers: what do we CALL it, what LOGO does it get, and what does
 * connecting it actually MEAN. This module owns all three so they can't drift.
 *
 * No React here on purpose: the classification is unit-testable and safe to
 * import from server code.
 */

/** Logo slug for a free-text integration name; null falls back to an initial tile. */
export function integrationSlug(name: string): string | null {
  const n = name.toLowerCase()
  if (n.includes('backstory')) return 'backstory'
  if (n.includes('slack')) return 'slack'
  if (n.includes('salesforce')) return 'salesforce'
  if (n.includes('snowflake')) return 'snowflake'
  if (n.includes('intercom')) return 'intercom'
  if (n.includes('hubspot')) return 'hubspot'
  if (n.includes('apollo')) return 'apollo'
  if (n.includes('gmail') || n.includes('email') || n.includes('mail')) return 'gmail'
  if (n.includes('notion')) return 'notion'
  if (n.includes('jira')) return 'jira'
  if (n.includes('linear')) return 'linear'
  if (n.includes('github')) return 'github'
  if (n.includes('asana')) return 'asana'
  if (n.includes('zendesk')) return 'zendesk'
  if (n.includes('airtable')) return 'airtable'
  if (n.includes('monday')) return 'monday'
  if (n.includes('teams')) return 'microsoftteams'
  if (n.includes('zoom')) return 'zoom'
  if (n.includes('calendar')) return 'googlecalendar'
  if (n.includes('sheet')) return 'googlesheets'
  if (n.includes('drive')) return 'googledrive'
  if (n.includes('confluence')) return 'confluence'
  if (n.includes('clickup')) return 'clickup'
  if (n.includes('trello')) return 'trello'
  return null
}

/**
 * Display label for a requirement. Strips internal plane prefixes (nango:,
 * native:, people_ai:) that leak into stored connector keys — users see
 * "Snowflake", not "nango:snowflake". A bare provider slug is title-cased;
 * branded/multi-word names (Backstory MCP, HTTP API, Email) are left untouched.
 */
export function integrationLabel(name: string): string {
  const stripped = name.replace(/^(?:nango|native|people_ai):/i, '')
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(stripped)) return stripped
  return stripped.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** One entry of the Nango catalog, as `/api/nango/integrations` returns it. */
export type CatalogEntry = {
  id: string
  provider: string
  name: string
  logo?: string
}

/**
 * What kind of setup a requirement needs:
 *   oauth   — a Nango account connection (Salesforce, Slack, Snowflake…)
 *   mcp     — a custom MCP server (Backstory MCP and friends)
 *   builtin — nothing to connect (plain HTTP calls, email send, the model)
 */
export type RequirementKind = 'oauth' | 'mcp' | 'builtin'

export type Requirement = {
  /** The raw value stored on the template ("nango:salesforce"). */
  name: string
  /** What we show the user ("Salesforce"). */
  label: string
  kind: RequirementKind
  /** The catalog entry to connect, when this is a known OAuth provider. */
  entry: CatalogEntry | null
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Names that describe a capability the platform already has — nothing to connect. */
const BUILTIN = /^(https?|http api|https api|rest|rest api|api|web|webhook|webhooks|browser|web search|search|llm|model|ai|code|python|javascript)$/

/**
 * Find the catalog entry a requirement refers to. Exact matches on the config
 * key, provider or display name win; otherwise a provider-key prefix match
 * catches environment-suffixed keys ("salesforce" → "salesforce-sandbox"),
 * preferring the shortest (least-qualified) key so a bare name lands on the
 * primary integration rather than a variant.
 */
export function matchCatalogEntry(name: string, catalog: CatalogEntry[]): CatalogEntry | null {
  // The logo slug doubles as an alias table ("Email" → gmail, "Teams" →
  // microsoftteams), so a capability-style name still finds its provider.
  const candidates = [integrationLabel(name), integrationSlug(name) ?? '']
  for (const candidate of candidates) {
    const target = normalize(candidate)
    if (!target) continue

    for (const key of ['id', 'provider', 'name'] as const) {
      const exact = catalog.find((entry) => normalize(entry[key] ?? '') === target)
      if (exact) return exact
    }

    const prefixed = catalog
      .filter((entry) => normalize(entry.id).startsWith(target) || normalize(entry.provider).startsWith(target))
      .sort((a, b) => a.id.length - b.id.length)
    if (prefixed[0]) return prefixed[0]
  }
  return null
}

/**
 * Classify one declared integration. The catalog decides `oauth` — anything the
 * environment can actually connect is connectable, whatever it's called — so an
 * unmatched name only falls back to the naming heuristics.
 */
export function classifyRequirement(name: string, catalog: CatalogEntry[] = []): Requirement {
  const label = integrationLabel(name)
  const entry = matchCatalogEntry(name, catalog)
  if (entry) return { name, label, kind: 'oauth', entry }

  const lower = label.toLowerCase().trim()
  const kind: RequirementKind = /\bmcp\b/.test(lower) || lower.includes('backstory')
    ? 'mcp'
    : BUILTIN.test(lower)
      ? 'builtin'
      : 'oauth'
  return { name, label, kind, entry: null }
}

/** Classify a template's whole requirement list, deduped by display label. */
export function classifyRequirements(names: string[], catalog: CatalogEntry[] = []): Requirement[] {
  const seen = new Set<string>()
  const out: Requirement[] = []
  for (const name of names) {
    const requirement = classifyRequirement(name, catalog)
    const key = requirement.label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(requirement)
  }
  return out
}
