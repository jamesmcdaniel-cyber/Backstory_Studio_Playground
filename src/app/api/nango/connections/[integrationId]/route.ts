import { prisma } from '@/lib/prisma'
import { getNangoClient, NANGO_ORG_TAG } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

// Disconnects the org-scoped Nango connections for the given integration
// (provider config key), then removes the local mirror rows. Integration
// admins remove every account; anyone else removes only their own.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const integrationId = decodeURIComponent(request.nextUrl.pathname.split('/').at(-1) ?? '')
  if (!integrationId) throw new ApiError('Integration id is required')

  const client = getNangoClient()
  let response
  try {
    response = await client.listConnections({
      integrationId,
      tags: { [NANGO_ORG_TAG]: auth.organizationId },
    })
  } catch (error) {
    throw nangoApiError(error)
  }

  let matching = (response.connections ?? []).filter(
    (connection) => connection.provider_config_key === integrationId,
  )
  // A member may disconnect only the accounts THEY connected; removing every
  // workspace connection for an integration stays an integration-admin action.
  // Ownership comes from the local mirror (userId = the Nango end user), not
  // from anything the request says.
  if (!auth.can('integration.manage')) {
    const own = await prisma.nangoConnection.findMany({
      where: {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        connectionId: { in: matching.map((connection) => connection.connection_id) },
      },
      select: { connectionId: true },
    })
    const ownIds = new Set(own.map((row) => row.connectionId))
    matching = matching.filter((connection) => ownIds.has(connection.connection_id))
  }
  if (!matching.length) throw new ApiError('Connected account not found', 404, 'NOT_FOUND')

  try {
    await Promise.all(
      matching.map((connection) => client.deleteConnection(integrationId, connection.connection_id)),
    )
  } catch (error) {
    throw nangoApiError(error)
  }

  await prisma.nangoConnection.deleteMany({
    where: {
      organizationId: auth.organizationId,
      connectionId: { in: matching.map((connection) => connection.connection_id) },
    },
  })

  return { success: true }
}, { permission: 'flow.run' })
