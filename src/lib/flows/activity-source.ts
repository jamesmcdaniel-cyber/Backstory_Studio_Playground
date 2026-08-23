/**
 * Client-safe mapping between an activity trigger's stored `source` string and
 * the app it names to a human. Shared by the trigger editor's source picker
 * (option labels) and node-presentation.ts's canvas subtitle so the two
 * surfaces can never render the same stored value two different ways — and,
 * critically, so the subtitle never interpolates a raw scheme string like
 * `nango:github` straight into copy (the no-raw-token mandate covers this the
 * same way it covers {{tokens}} and cron strings).
 *
 * No `node:crypto` or other server-only import here on purpose — this module
 * is imported directly by client components (trigger-editor.tsx) as well as
 * node-presentation.ts, which itself is imported by client canvas code. See
 * trigger.ts's `ACTIVITY_KIND_LABELS` doc comment for the same constraint
 * applied to the kind vocabulary.
 */

/**
 * Build the `source` value the activity trigger stores from a connected
 * tool's registry key (src/lib/connectors/registry.ts's `ConnectorDescriptor.
 * key` / `fromNangoProviderKey`'s derived key). Mirrors
 * `normalizeNangoForward`'s own source derivation (src/lib/activity/
 * normalize.ts) for the two keys this function special-cases: 'slack' and
 * 'salesforce' are literal matches in BOTH places, and — specifically for
 * slack — that identity holds regardless of which plane a message arrives
 * through (native Slack Events API vs. a Nango-forwarded Slack message both
 * normalize to `source: 'slack'`; see `normalizeNangoSlack`). Everything
 * else this function sees falls to `nango:<provider>`, matching
 * `normalizeNangoForward`'s own fallback for an unmapped provider — EXCEPT
 * 'github', which `normalizeNangoForward` maps to a literal `'github'` but
 * which this function does not special-case (a pre-existing gap, not
 * introduced or fixed here: a GitHub trigger's stored `source` should read
 * 'github', not 'nango:github', for its match columns to actually line up).
 * Kept in this shared module (not duplicated in trigger-editor.tsx) per
 * code review — one definition, so the picker's stored `source` value and
 * normalize.ts's real output can't quietly drift apart.
 */
export function activitySourceForToolKey(key: string): string {
  const k = key.toLowerCase()
  if (k === 'slack' || k === 'salesforce') return k
  return `nango:${k}`
}

/** Sources with a canonical brand display name, keyed lowercase. */
const KNOWN_SOURCE_LABELS: Record<string, string> = {
  slack: 'Slack',
  salesforce: 'Salesforce',
  github: 'GitHub',
  gmail: 'Gmail',
  jira: 'Jira',
  google_drive: 'Google Drive',
  google_sheets: 'Google Sheets',
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Humanize a stored activity `source` value for display — NEVER the raw
 * string. Known brands (slack/salesforce/github/…) get their canonical name;
 * an unrecognized `nango:<provider>` strips the scheme and title-cases the
 * provider (`nango:acme-crm` → "Acme Crm"); anything else falls back to a
 * title-cased rendering of the value itself so a malformed/legacy source
 * still reads as words, not a raw code.
 */
export function activitySourceDisplayName(source: string | null | undefined): string {
  const trimmed = (source ?? '').trim()
  if (!trimmed) return 'a connected app'
  const direct = KNOWN_SOURCE_LABELS[trimmed.toLowerCase()]
  if (direct) return direct
  const provider = trimmed.toLowerCase().startsWith('nango:') ? trimmed.slice('nango:'.length) : trimmed
  const known = KNOWN_SOURCE_LABELS[provider.toLowerCase()]
  if (known) return known
  return titleCase(provider) || 'a connected app'
}
