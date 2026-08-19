/**
 * Recommendations, read as a hiring desk.
 *
 * The roster presents agents as coworkers, so the surface that suggests new
 * ones reads best as candidates applying to join. But the same surface also
 * carries improvements to things ALREADY running, and calling a broken step an
 * "applicant" would be nonsense — so the two are given different personas:
 *
 *   applicant — a new agent or flow asking for a place on the team.
 *   staff     — an existing teammate flagging a problem with their own work.
 *
 * The distinction is what keeps the metaphor from becoming a costume: an
 * improvement even wears the face of the teammate it is about, because
 * `configuration.targetId` names the real agent or flow.
 */

export type PersonaKind = 'applicant' | 'staff'

export type ProposalPersona = {
  kind: PersonaKind
  /** Avatar seed: the real teammate for staff, the proposal itself for a candidate. */
  seed: string
  /** Short status chip shown beside the title. */
  chip: string
  /** Primary button label. */
  action: string
}

/** Pull the improvement's target id out of the proposal's configuration blob. */
function targetId(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return null
  const value = (configuration as { targetId?: unknown }).targetId
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function proposalPersona(proposal: {
  id: string
  kind: string
  configuration?: unknown
}): ProposalPersona {
  if (proposal.kind === 'process_improvement') {
    return {
      kind: 'staff',
      // The teammate's own id, so the face here matches the face on the roster.
      // Falls back to the proposal when the target is missing.
      seed: targetId(proposal.configuration) ?? proposal.id,
      chip: 'On the team',
      action: 'Review',
    }
  }
  return {
    kind: 'applicant',
    seed: proposal.id,
    chip: proposal.kind === 'flow_template' ? 'Applying · flow' : 'Applying · agent',
    action: 'Hire',
  }
}

/**
 * What to call the bar, given what is actually in it. Adapts rather than
 * picking one label and lying about half the rows.
 */
export function inboxTitle(personas: PersonaKind[]): string {
  const hasApplicant = personas.includes('applicant')
  const hasStaff = personas.includes('staff')
  if (hasApplicant && hasStaff) return 'Candidates & team flags'
  if (hasStaff) return 'Team flags'
  return 'Candidates'
}

/** The one-line pitch under the title. Plural-aware, and honest about the mix. */
export function inboxSubtitle(personas: PersonaKind[]): string {
  const applicants = personas.filter((persona) => persona === 'applicant').length
  const flags = personas.length - applicants
  if (applicants && flags) {
    return `${applicants} ${applicants === 1 ? 'wants' : 'want'} to join · ${flags} ${flags === 1 ? 'needs' : 'need'} a look`
  }
  if (flags) return `${flags} ${flags === 1 ? 'teammate needs' : 'teammates need'} a look`
  return applicants === 1 ? '1 wants to join your team' : `${applicants} want to join your team`
}
