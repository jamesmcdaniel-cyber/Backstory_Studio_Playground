import { prisma } from '@/lib/prisma'
import { getNangoClient, NANGO_ORG_TAG } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

// Disconnects every org-scoped Nango connection for the given integration
// (provider config key), then removes the local mirror rows.
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

  const matching = (response.connections ?? []).filter(
    (connection) => connection.provider_config_key === integrationId,
  )
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
}, { permission: 'integration.manage' })
