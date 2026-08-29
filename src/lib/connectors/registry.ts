/**
 * Connector registry — the single source of truth for the tool "planes" an
 * agent can attach.
 *
 * Before this, plane gating was scattered as fuzzy regexes over the agent's
 * `integrations` JSON (`/slack/i`, `/granola/i`, `new RegExp(capability)`) in
 * loadTools, DUPLICATED again in /api/integrations/available (fromNango /
 * fromNango), with write-vs-read classification hard-coded per call site. A
 * drifting key in one place silently disabled an integration in another.
 *
 * Now every built-in plane is one typed descriptor: its canonical key, how a
 * stored selection activates it (`matches`), whether it is an outbound-write
 * plane, its env availability, and its UI presentation. loadTools, the
 * available-integrations endpoint, and the approval/audit write classification
 * all derive from here.
 *
 * Per-org MCP connections are discovered from DB rows rather than declared here.
 */

export type ConnectorKind = 'backstory' | 'builtin' | 'nango'

export type ConnectorDescriptor = {
  /** Canonical key persisted on the agent + shown in the UI. */
  key: string
  label: string
  /** Simple Icons slug for the UI chip. */
  slug: string
  kind: ConnectorKind
  /** True for outbound/delivery planes (writes) — reserved cap budget + approval. */
  isWrite: boolean
  /** The runtime `binding.provider` this plane produces (e.g. 'nango:slack'). */
  providerId: string
  /** Does a user-selected integration string activate this connector? */
  matches: (selected: string) => boolean
  /** Env availability. Granola is per-org (async), handled at its call site. */
  available: () => boolean
}

/** Case-insensitive substring match — behavior-preserving vs the old regexes. */
const has = (needle: string) => (selected: string) => selected.toLowerCase().includes(needle)

export const BUILTIN_CONNECTORS: ConnectorDescriptor[] = [
  {
    key: 'backstory',
    label: 'Backstory',
    slug: 'backstory',
    kind: 'backstory',
    isWrite: false,
    providerId: 'backstory',
    matches: has('backstory'),
    available: () => true,
  },
  {
    key: 'Granola',
    label: 'Granola',
    slug: 'granola',
    kind: 'builtin',
    isWrite: false,
    providerId: 'granola',
    matches: has('granola'),
    available: () => true, // gated per-org by an API key at the call site
  },
  {
    key: 'Slack',
    label: 'Slack',
    slug: 'slack',
    kind: 'builtin',
    isWrite: true,
    providerId: 'slack',
    matches: has('slack'),
    // Same shape as Granola: availability is per-workspace (its own bot token,
    // or the env fallback if this org kind may use it), so it cannot be decided
    // by a synchronous, org-less predicate. Resolved at the call site.
    available: () => true,
  },
  {
    key: 'Email',
    label: 'Email',
    slug: 'resend',
    kind: 'builtin',
    isWrite: true,
    providerId: 'email',
    matches: has('email'),
    available: () => true, // per-workspace Resend key; gated at the call site

  },
  {
    key: 'HTTP API',
    label: 'HTTP API',
    slug: 'http',
    kind: 'builtin',
    isWrite: true, // can POST to external systems
    providerId: 'http',
    matches: has('http'),
    available: () => true, // no credentials required; SSRF-guarded at call time
  },
  {
    key: 'Web Research',
    label: 'Web Research',
    slug: 'brave',
    kind: 'builtin',
    // A read plane. Searching and reading public pages changes nothing
    // outward, so it carries no approval gate — but see the note in
    // research.ts: what it RETURNS is attacker-authorable, which is why the
    // taint scan matters more on a run that uses it.
    isWrite: false,
    providerId: 'research',
    matches: (selected) => {
      const value = selected.toLowerCase()
      return value.includes('research') || value.includes('web search')
    },
    available: () => true, // per-workspace search key; gated at the call site
  },
  {
    key: 'Data Tables',
    label: 'Data Tables',
    slug: 'postgresql',
    kind: 'builtin',
    // The plane contains reads and writes; conservative at attachment time,
    // while execution classifies each selected tool precisely.
    isWrite: true,
    providerId: 'data_tables',
    matches: has('data table'),
    available: () => true,
  },
  // Nango delivery planes (outbound as the acting user). One per capability.
  {
    key: 'slack',
    label: 'Slack (send)',
    slug: 'slack',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:slack',
    matches: has('slack'),
    available: () => true, // gated by a resolvable Nango connection at the call site
  },
  {
    key: 'gmail',
    label: 'Gmail',
    slug: 'gmail',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:gmail',
    matches: has('gmail'),
    available: () => true,
  },
  {
    key: 'salesforce',
    label: 'Salesforce',
    slug: 'salesforce',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:salesforce',
    matches: has('salesforce'),
    available: () => true,
  },
]

/** Nango delivery capability → its registry descriptor (by capability name). */
export function nangoConnector(capability: string): ConnectorDescriptor | undefined {
  return BUILTIN_CONNECTORS.find((c) => c.kind === 'nango' && c.key === capability)
}

/** True if any selected integration string activates this connector. */
export function isSelected(descriptor: ConnectorDescriptor, selected: string[]): boolean {
  return selected.some((s) => descriptor.matches(s))
}

/**
 * Whether a runtime provider id is an outbound-WRITE plane (reserved cap budget,
 * audit `tool.write`, approval gate). Derived from the registry for built-ins;
 * any `nango:*` provider is a write plane by construction.
 */
export function isWriteProvider(providerId: string): boolean {
  if (providerId.startsWith('nango:')) return true
  return BUILTIN_CONNECTORS.some((c) => c.providerId === providerId && c.isWrite)
}

// ── UI key derivation (shared with /api/integrations/available) ───────────────
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** Nango providerConfigKey → a runtime-matchable key + display + icon slug. */
export function fromNangoProviderKey(providerConfigKey: string): { key: string; label: string; slug: string } {
  const k = providerConfigKey.toLowerCase()
  if (k.includes('slack')) return { key: 'slack', label: 'Slack', slug: 'slack' }
  // Google's mail provider only. A bare 'mail' substring used to match here,
  // which labelled every other mail provider (outlook-mail, fastmail…) as Gmail
  // — a wrong chip, and a wrong connection once runtime resolution started
  // matching on this canonical key.
  if (k.includes('gmail') || k.includes('google-mail') || k.includes('google_mail')) {
    return { key: 'gmail', label: 'Gmail', slug: 'gmail' }
  }
  if (k.includes('salesforce')) return { key: 'salesforce', label: 'Salesforce', slug: 'salesforce' }
  if (k === 'atlassian') return { key: 'jira', label: 'Jira', slug: 'jira' }
  if (k === 'google-drive' || k === 'google_drive') return { key: 'google_drive', label: 'Google Drive', slug: 'googledrive' }
  if (k === 'google-sheet' || k === 'google-sheets' || k === 'google_sheets') {
    return { key: 'google_sheets', label: 'Google Sheets', slug: 'googlesheets' }
  }
  if (k === 'google-calendar' || k === 'google_calendar') {
    return { key: 'google_calendar', label: 'Google Calendar', slug: 'googlecalendar' }
  }
  const key = k.replace(/-/g, '_')
  return { key, label: titleCase(key), slug: key === 'monday' ? 'mondaydotcom' : key }
}
