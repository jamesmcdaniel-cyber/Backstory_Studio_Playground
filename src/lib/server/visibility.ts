/**
 * Tenant + owner visibility scopes, shared by every route so a "private" agent
 * is enforced consistently: only its owner may see the agent, its runs, its
 * messages, its search hits, or its trigger secret. Shared agents remain
 * visible to the whole organization.
 *
 * Combine with other conditions via Prisma `AND` when the target `where`
 * already carries an `OR` (two `OR` keys collide in one object).
 */

/** Agent rows: private agents are visible only to their owner. */
export function agentVisibilityScope(userId: string) {
  return { OR: [{ visibility: { not: 'private' } }, { userId }] }
}

/** Internal template copilots are operated only through their artifact. */
export function configurableAgentScope(userId: string) {
  return { artifactTemplateCopyId: null, ...agentVisibilityScope(userId) }
}

/**
 * Agents a person sees listed. A personal copy's copilot is one of them — it is
 * that artifact's agent, and its runs link here — while a guest copy's copilot
 * (an anonymous visitor's, run as the sender) is nobody's to see. Listing is
 * not operating: every route that runs or changes an agent keeps
 * configurableAgentScope.
 */
export function listableAgentScope(userId: string) {
  return { type: { not: 'guest_copilot' }, ...agentVisibilityScope(userId) }
}

/**
 * Execution rows: runs belonging to a private agent are visible only to that
 * agent's owner. Runs with no linked agent (e.g. template runs) are never
 * private, so they stay org-visible.
 */
export function executionVisibilityScope(userId: string) {
  return {
    OR: [
      { agentTaskId: null },
      { agentTask: { is: { visibility: { not: 'private' } } } },
      { agentTask: { is: { userId } } },
    ],
  }
}
