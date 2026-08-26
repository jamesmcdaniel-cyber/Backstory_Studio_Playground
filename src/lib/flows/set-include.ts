/**
 * Which of the incoming fields a Set step carries through — n8n's "Include in
 * Output".
 *
 * We shipped the boolean half of this ("Include Other Input Fields") and not
 * the half that says WHICH. All-or-nothing forces a choice between dragging an
 * entire upstream record into every downstream step, or re-mapping every field
 * you wanted to keep. n8n's three-way — all, selected, all-except — is the
 * reason its Set node does not need either compromise.
 *
 * Pure, so the rule is readable without running a flow.
 */

export type SetIncludeMode = 'all' | 'selected' | 'except'

export function carriedFields(
  input: unknown,
  options: { includeOtherFields?: boolean; includeMode?: SetIncludeMode; includeFields?: readonly string[] },
): Record<string, unknown> {
  if (options.includeOtherFields !== true) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}

  const record = input as Record<string, unknown>
  const mode = options.includeMode ?? 'all'
  if (mode === 'all') return { ...record }

  // Trimmed and de-blanked: a trailing comma in a field list should not create
  // a rule about a field named "".
  const named = new Set((options.includeFields ?? []).map((field) => field.trim()).filter(Boolean))

  // An empty list is not a filter anyone meant. `selected` with nothing selected
  // carries nothing (which is what it says); `except` with nothing excluded
  // carries everything (likewise).
  if (mode === 'selected') {
    return Object.fromEntries(Object.entries(record).filter(([key]) => named.has(key)))
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => !named.has(key)))
}
