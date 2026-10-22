import type { AuthSeed, AuthContextValue } from '@/hooks/auth-context-state'
import { requireAuthContext, type AuthContext } from './auth'

/** The client-facing view of a caller: what /api/auth/context returns and the layout seeds. */
export function clientAuthContext(auth: AuthContext): AuthContextValue {
  return {
    userId: auth.dbUser.id,
    organizationId: auth.organizationId,
    role: auth.dbUser.role,
    // Drives which affordances render. Cosmetic only: the server re-checks
    // every gated call, so a tampered client gains nothing.
    permissions: [...auth.permissions],
    mfaPolicy: auth.dbUser.organization?.mfaPolicy ?? 'optional',
  }
}

/**
 * The caller's context for the root layout to hand the client, so permission-
 * gated nav renders on the first paint. Null for anyone it cannot resolve (a
 * public page, no session, no workspace yet): the client then asks
 * /api/auth/context exactly as before. Gated the same way as that route.
 */
export async function loadAuthSeed(): Promise<AuthSeed | null> {
  try {
    const auth = await requireAuthContext({ skipMfaGate: true, skipSsoGate: true })
    return { authUserId: auth.userId, context: clientAuthContext(auth) }
  } catch {
    return null
  }
}
