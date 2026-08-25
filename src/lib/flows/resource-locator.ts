import type { ToolField } from '@/lib/flows/tool-schema'

/**
 * Picking a record instead of pasting its id.
 *
 * A People.ai MCP argument reads, verbatim: "The internal People.ai ID of the
 * record to analyze. Use find_account or find_record_by_crm_id to obtain this."
 * The schema is telling the user to go run a different tool by hand, read an
 * integer out of its output, and paste it back — and then the form shows
 * `18234` forever, so nobody reading the flow later can tell which account it
 * is. n8n solves both halves with resourceLocator.
 *
 * ── What is stored ────────────────────────────────────────────────────────
 * The argument value is UNCHANGED: the tool still receives `18234`. n8n stores
 * a `{__rl, mode, value, cachedResultName}` object in the parameter itself,
 * which it can afford because it owns every node definition. Ours are
 * discovered from an MCP server that expects the integer the schema asked for,
 * so the display name rides alongside in `argLabels` instead of inside the
 * value. Nothing about what the tool receives changes, which is what makes this
 * safe to add to graphs that already exist.
 *
 * A missing label is not an error — it renders as the raw value, exactly as
 * today. Labels are a reading aid, never the source of truth.
 */

/** Display names for arguments, keyed by the argument's wire name. */
export type ArgLabels = Record<string, string>

/**
 * Fields worth offering a picker for.
 *
 * An identifier is the case that hurts: it is opaque, it is obtained from
 * somewhere else, and it is meaningless to a later reader. Detected from the
 * shape the schema already gives us rather than from a per-field declaration we
 * have no way to author — our tools are discovered, not defined.
 */
export function isIdentifierField(field: ToolField): boolean {
  if (field.type !== 'string' && field.type !== 'number') return false
  // A closed set already has a picker: its own dropdown.
  if (field.options?.length) return false

  const name = field.name.toLowerCase()
  if (/(^|[_-])id([_-]|$)/.test(name) || /id$/.test(name)) return true
  if (/(^|[_-])(uuid|guid|key|ref|crm)([_-]|$)/.test(name)) return true

  // The description is where an MCP server says "use find_account to obtain
  // this" — an explicit admission that the value comes from another call.
  const description = field.description?.toLowerCase() ?? ''
  return /\bid\b/.test(description) && /\b(obtain|look ?up|use \w+ to|returned by)\b/.test(description)
}

export type LocatorMode = 'list' | 'value' | 'upstream'

/**
 * Which ways of filling this argument to offer, in the order they are useful.
 *
 * `upstream` leads whenever earlier steps exist: in a flow the id nearly always
 * comes from a previous step, and binding it is both less work than picking and
 * correct for every run rather than for this one. Picking from a list is for
 * the case where the value is genuinely fixed — one account this flow is about.
 */
export function locatorModes(params: {
  canList: boolean
  hasUpstreamData: boolean
}): LocatorMode[] {
  const modes: LocatorMode[] = []
  if (params.hasUpstreamData) modes.push('upstream')
  if (params.canList) modes.push('list')
  modes.push('value')
  return modes
}

export const LOCATOR_MODE_LABELS: Record<LocatorMode, string> = {
  upstream: 'From an earlier step',
  list: 'Pick from a list',
  value: 'Enter a value',
}

/**
 * Which mode a stored value is already using, so reopening a step lands on the
 * control that holds its value rather than resetting to the first tab.
 */
export function modeForValue(value: string, available: readonly LocatorMode[]): LocatorMode {
  if (value.includes('{{') && available.includes('upstream')) return 'upstream'
  return available.includes('list') && value.trim() === '' ? available[0] : available.includes('value') ? 'value' : available[0]
}

/**
 * What the field shows once something is chosen.
 *
 * The name when we have one, with the raw value kept visible beside it — the id
 * is what the tool receives and what an error will quote, so hiding it entirely
 * would trade one kind of confusion for another.
 */
export function locatorDisplay(value: string, label?: string): { primary: string; secondary?: string } {
  const trimmed = value.trim()
  if (!trimmed) return { primary: '' }
  const named = label?.trim()
  return named && named !== trimmed ? { primary: named, secondary: trimmed } : { primary: trimmed }
}

/**
 * Set (or clear) one argument's display name.
 *
 * Returns undefined when nothing is left, so a node that has no labels carries
 * no empty object — a graph diff should not show a change that means nothing.
 */
export function setArgLabel(labels: ArgLabels | undefined, name: string, label: string | null): ArgLabels | undefined {
  const next = { ...(labels ?? {}) }
  const trimmed = label?.trim()
  if (trimmed) next[name] = trimmed.slice(0, 120)
  else delete next[name]
  return Object.keys(next).length ? next : undefined
}

/**
 * Drop labels for arguments that no longer exist.
 *
 * Switching a step to a different tool leaves labels for fields the new tool
 * does not have; kept, they would resurface if a field of the same name ever
 * came back, naming something from another system entirely.
 */
export function pruneArgLabels(labels: ArgLabels | undefined, fields: readonly ToolField[]): ArgLabels | undefined {
  if (!labels) return undefined
  const known = new Set(fields.map((field) => field.name))
  const next = Object.fromEntries(Object.entries(labels).filter(([name]) => known.has(name)))
  return Object.keys(next).length ? next : undefined
}

/**
 * A row returned by a read tool, reduced to something pickable.
 *
 * A picker has to guess which column is the id and which is the name, because
 * the row came from someone else's API. Preference order is the conventional
 * one; anything unrecognised falls back to the first string-ish column so a
 * result set is never unusable.
 */
const ID_KEYS = ['id', 'value', 'key', 'uuid', 'record_id', 'recordId', 'crm_id', 'crmId']
const NAME_KEYS = ['name', 'label', 'title', 'display_name', 'displayName', 'account_name', 'accountName', 'text']

export function pickableRow(row: Record<string, unknown>): { value: string; label?: string } | null {
  const scalar = (input: unknown) =>
    input === null || input === undefined || typeof input === 'object' ? null : String(input)

  let value: string | null = null
  for (const key of ID_KEYS) {
    const found = scalar(row[key])
    if (found) { value = found; break }
  }
  if (!value) {
    const first = Object.values(row).map(scalar).find((entry) => entry && entry.length)
    value = first ?? null
  }
  if (!value) return null

  let label: string | undefined
  for (const key of NAME_KEYS) {
    const found = scalar(row[key])
    if (found && found !== value) { label = found; break }
  }
  return { value, ...(label ? { label } : {}) }
}
