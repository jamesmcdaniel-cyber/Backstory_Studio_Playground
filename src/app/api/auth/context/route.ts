import { withAuthenticatedApi } from '@/lib/server/api-handler'

// permission: null — the client learns what it may do FROM this route, so
// gating it on a permission would be circular.
export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  context: {
    userId: auth.dbUser.id,
    organizationId: auth.organizationId,
    role: auth.dbUser.role,
    // Drives which affordances render. Cosmetic only: the server re-checks
    // every gated call, so a tampered client gains nothing.
    permissions: [...auth.permissions],
  },
}), { permission: null })
