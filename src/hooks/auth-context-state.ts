/** What the shell knows about the signed-in caller: who, which workspace, and which affordances render. */
export type AuthContextValue = {
  userId: string
  organizationId: string
  role: string
  permissions?: string[]
  mfaPolicy?: string
}

/**
 * The context the server resolved while rendering the page, tagged with the
 * Supabase user it was resolved for. The root layout passes it down so the
 * first paint already has the caller's permissions — permission-gated nav
 * (Admin, Reviews) no longer appears a beat after the rest of the sidebar.
 */
export type AuthSeed = { authUserId: string; context: AuthContextValue }

/**
 * One decision for useAuth: which context to show now, and whether it still
 * has to be fetched. Pure, so the seed / cache / session rules are testable.
 *
 * - While the browser session is still resolving, keep the seed: it was
 *   resolved from the same cookies on this very request.
 * - Once it resolves, the seed holds only for the user it was rendered for. A
 *   context already fetched for this user is shared by every caller. Anything
 *   else is fetched.
 * - No session means no context.
 */
export function nextAuthContextStep(input: {
  seed: AuthSeed | null
  cached: AuthSeed | null
  sessionLoading: boolean
  sessionUserId: string | null
}): { context: AuthContextValue | null; fetch: boolean } {
  const { seed, cached, sessionLoading, sessionUserId } = input
  if (sessionLoading) return { context: seed?.context ?? cached?.context ?? null, fetch: false }
  if (!sessionUserId) return { context: null, fetch: false }
  if (cached?.authUserId === sessionUserId) return { context: cached.context, fetch: false }
  if (seed?.authUserId === sessionUserId) return { context: seed.context, fetch: false }
  return { context: null, fetch: true }
}
