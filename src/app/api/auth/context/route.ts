import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { clientAuthContext } from '@/lib/server/auth-seed'

// permission: null — the client learns what it may do FROM this route, so
// gating it on a permission would be circular. The root layout seeds the same
// shape (loadAuthSeed), so this only runs when that seed is missing.
export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  context: clientAuthContext(auth),
}), { permission: null, skipMfaGate: true, skipSsoGate: true })
