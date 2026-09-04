/**
 * Tailoring a template: the adjustments a person makes to a catalogue template
 * before it becomes their agent.
 *
 * A template arrives as someone else's guess at two things — what the agent
 * should do, and which tools it does it with. One half is usually right and the
 * other usually isn't: the instructions describe the job well but name Salesforce
 * in a HubSpot shop, or the tool list is exactly this workspace's stack while the
 * instructions were written for a different team. Tailoring lets either half be
 * corrected without waiting for the template to change.
 *
 * Edits are held as DELTAS from what the template ships, not as a full copy of
 * it. Two reasons. A template that is later corrected upstream still reaches a
 * user who only re-worded the instructions, because their tool selection is not
 * a frozen snapshot of the old list. And "has this been changed?" stays
 * answerable, which is what lets the page offer to reset, and what keeps it
 * honest that the template itself is untouched.
 */

/** The part of a template a person may tailor. */
export type TailorableTemplate = {
  instructions: string
  integrations: string[]
}

/** Only what the person actually changed. An absent key means "as shipped". */
export type TemplateEdits = {
  instructions?: string
  integrations?: string[]
}

/**
 * Tool keys compare as an UNORDERED, case-insensitive set.
 *
 * Order carries no meaning — the picker appends each newly selected chip, so
 * turning a tool off and on again reorders the list without changing anything.
 * Case carries none either: the workspace's available-tools list is deduped by
 * lowercased key (see lib/integrations/connected), so "Slack" and "slack" name
 * one connector. Comparing literally would report both as edits and offer to
 * reset a template nobody touched.
 */
export function sameTools(a: readonly string[], b: readonly string[]): boolean {
  const normalize = (list: readonly string[]) => new Set(list.map((tool) => tool.trim().toLowerCase()).filter(Boolean))
  const left = normalize(a)
  const right = normalize(b)
  if (left.size !== right.size) return false
  for (const tool of left) if (!right.has(tool)) return false
  return true
}

/**
 * What changed between the template as shipped and the draft on screen.
 *
 * Instructions compare trimmed, so a stray trailing newline from the textarea
 * is not an edit — but the draft is recorded exactly as typed, because interior
 * whitespace in a prompt is the author's business.
 */
export function diffTemplate(template: TailorableTemplate, draft: TailorableTemplate): TemplateEdits {
  const edits: TemplateEdits = {}
  if (template.instructions.trim() !== draft.instructions.trim()) edits.instructions = draft.instructions
  if (!sameTools(template.integrations, draft.integrations)) edits.integrations = [...draft.integrations]
  return edits
}

export function hasEdits(edits: TemplateEdits): boolean {
  return edits.instructions !== undefined || edits.integrations !== undefined
}

/** The template as the user tailored it — what gets installed, copied, or saved. */
export function applyEdits<T extends TailorableTemplate>(template: T, edits: TemplateEdits): T {
  return {
    ...template,
    ...(edits.instructions !== undefined ? { instructions: edits.instructions } : {}),
    ...(edits.integrations !== undefined ? { integrations: edits.integrations } : {}),
  }
}

/**
 * Why this draft cannot be used yet, or null when it can.
 *
 * Instructions are the one field with no sensible empty state: an agent whose
 * objective is blank runs and does nothing. Tools may legitimately be empty —
 * plenty of useful agents only reason over what they are given.
 */
export function tailorProblem(draft: TailorableTemplate): string | null {
  if (!draft.instructions.trim()) return 'Instructions cannot be empty — describe what this agent should do.'
  return null
}
