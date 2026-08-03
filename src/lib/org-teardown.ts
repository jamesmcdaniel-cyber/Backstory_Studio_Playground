/**
 * Complete organization teardown: external resources first (fail closed),
 * then the graph, then the org row — whose FK cascades (completed in WS-R4
 * Task 1) delete every owned row. Each external leg is isolated so a provider
 * outage blocks the database delete so we never report erasure while a copy
 * remains at a processor. The request is safe to retry.
 */

import { systemPrisma } from '@/lib/prisma'
import { captureError } from '@/lib/observability/sentry'
import { graphRagPersistent, getGraphRagStore } from '@/lib/rag/get-store'
import { deleteStoredFile } from '@/lib/files/storage'

export async function teardownOrganization(organizationId: string): Promise<{ nango: number; graphCleared: boolean; filesDeleted: number }> {
  let nango = 0
  let graphCleared = false
  let filesDeleted = 0
  const externalFailures: Error[] = []

  // systemPrisma: org teardown enumerates the org's own rows by org id — the
  // guard's org-scope requirement is satisfied semantically but these run
  // outside any authenticated request context.
  try {
    if (process.env.NANGO_SECRET_KEY) {
      const { getNangoClient } = await import('@/lib/nango/client')
      const client = getNangoClient()
      const connections = await systemPrisma.nangoConnection.findMany({ where: { organizationId } })
      for (const connection of connections) {
        try {
          await client.deleteConnection(connection.providerConfigKey, connection.connectionId)
          nango += 1
        } catch (error) {
          captureError(error, { source: 'orgTeardown.nango', organizationId, connectionId: connection.connectionId })
          externalFailures.push(error instanceof Error ? error : new Error(String(error)))
        }
      }
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.nangoLeg', organizationId })
    externalFailures.push(error instanceof Error ? error : new Error(String(error)))
  }

  try {
    if (graphRagPersistent()) {
      await getGraphRagStore().clear?.(organizationId)
      graphCleared = true
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.graph', organizationId })
    externalFailures.push(error instanceof Error ? error : new Error(String(error)))
  }

  if (externalFailures.length) {
    throw new AggregateError(externalFailures, 'External customer-data deletion did not complete; workspace deletion was not committed.')
  }

  // Object-store blobs are outside Postgres cascades. Remove each before its
  // metadata row disappears; failures are reported and block deletion so a
  // workspace cannot be declared erased while customer bytes remain behind.
  const files = await systemPrisma.storedFile.findMany({ where: { organizationId }, select: { id: true } })
  for (const file of files) {
    if (await deleteStoredFile(file.id, organizationId)) filesDeleted += 1
  }

  await systemPrisma.organization.delete({ where: { id: organizationId } })
  return { nango, graphCleared, filesDeleted }
}
