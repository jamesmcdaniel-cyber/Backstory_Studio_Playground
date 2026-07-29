import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { entitlementGateEnabled } from '@/lib/server/auth'
import { resolveEntitlement } from '@/lib/entitlement'
import { prisma } from '@/lib/prisma'
import {
  BACKSTORY_PROVIDER,
  backstoryMcpReady,
  backstoryServerUrl,
  ensureBackstoryConnection,
} from '@/lib/mcp/backstory-connection'

export const runtime = 'nodejs'

// GET /api/setup/status — the onboarding gate's single source of truth for the
// client. Exempt from the gate itself so /connect and the SetupGate can load.
export const GET = withAuthenticatedApi(
  async (_request, auth) => {
    await ensureBackstoryConnection(auth.organizationId, auth.dbUser.id)
    const [entitlement, backstoryConnected, row] = await Promise.all([
      entitlementGateEnabled() ? resolveEntitlement(auth.organizationId) : Promise.resolve({ entitled: true }),
      backstoryMcpReady(auth.organizationId, auth.dbUser.id),
      prisma.mcpConnection.findFirst({
        where: { organizationId: auth.organizationId, userId: auth.dbUser.id, provider: BACKSTORY_PROVIDER },
        select: { id: true },
      }),
    ])
    return {
      success: true,
      entitled: Boolean(entitlement.entitled),
      backstoryConnected,
      backstoryConnectionId: row?.id ?? null,
      backstoryServerUrl: backstoryServerUrl(),
    }
  },
  { skipBackstoryGate: true, skipEntitlementGate: true, permission: null },
)
