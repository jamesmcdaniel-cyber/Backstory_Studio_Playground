/**
 * Provider key → Nango connection config key(s) to resolve a connection from.
 * The first entry is the canonical Nango dashboard integration id (`unique_key`);
 * alternates cover naming variants Nango may assign by default.
 *
 * This is THE string that joins two catalogs: the integrations enabled in the
 * Nango dashboard, and the agent tools authored in `provider-tools.ts`. A
 * dashboard `unique_key` that matches nothing here is connectable but yields
 * zero agent tools.
 *
 * It lives in its own dependency-free module (no prisma, no logger, no `@/`
 * imports) so standalone tooling — `scripts/nango-doctor.ts` — can import the
 * REAL map instead of keeping a hand-copied duplicate. That duplicate had
 * already drifted: it was missing `google_calendar` and `granola`, so the
 * doctor reported two correctly-configured integrations as having no agent
 * tools, inviting someone to "fix" a dashboard slug that was already right.
 */
export const PROVIDER_CONFIG_KEYS: Record<string, readonly string[]> = {
  github: ['github'],
  linear: ['linear'],
  jira: ['jira', 'atlassian'],
  asana: ['asana'],
  notion: ['notion'],
  hubspot: ['hubspot'],
  confluence: ['confluence'],
  zendesk: ['zendesk'],
  monday: ['monday'],
  google_drive: ['google-drive', 'google_drive'],
  google_sheets: ['google-sheet', 'google-sheets', 'google_sheets'],
  google_calendar: ['google-calendar', 'google_calendar'],
  slack: ['slack'],
  gmail: ['google-mail', 'gmail'],
  salesforce: ['salesforce', 'salesforce-sandbox'],
  airtable: ['airtable'],
  figma: ['figma'],
  granola: ['granola'],
}

/** Provider keys offered to agent drafting and template generation. */
export const NANGO_PROVIDERS = Object.keys(PROVIDER_CONFIG_KEYS)
