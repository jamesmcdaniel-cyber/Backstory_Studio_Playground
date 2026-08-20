/**
 * Complete organization teardown: external resources first (fail closed),
 * then the graph, then the org row — whose FK cascades (completed in WS-R4
 * Task 1) delete every owned row. Each external leg is isolated so a provider
 * outage blocks the database delete so we never report erasure while a copy
 * remains at a processor. The request is safe to retry.
 */

import { systemPrisma } from '@/lib/prisma'
import { PLATFORM_OWNER_EMAILS } from '@/lib/authz/platform-owner'
import { captureError } from '@/lib/observability/sentry'
import { graphRagPersistent, getGraphRagStore } from '@/lib/rag/get-store'
import { deleteStoredFile } from '@/lib/files/storage'

export async function teardownOrganization(organizationId: string): Promise<{ nango: number; graphCleared: boolean; filesDeleted: number }> {
  let nango = 0
  let graphCleared = false
  let filesDeleted = 0
  const externalFailures: Error[] = []

  // Demo copies go first: a demo org is an anonymised clone of this workspace
  // (kind 'demo', pointing back via demoOfOrganizationId), and an orphaned
  // clone outliving its source would be an unowned tenant nobody can exit.
  // Depth-1 by construction — a demo org never has demo copies — and the kind
  // check makes that assumption fail loud rather than recurse.
  const demoCopies = await systemPrisma.organization.findMany({
    where: { demoOfOrganizationId: organizationId },
    select: { id: true, kind: true },
  })
  for (const copy of demoCopies) {
    if (copy.kind !== 'demo') throw new Error(`Organization ${copy.id} points at ${organizationId} via demoOfOrganizationId but is kind '${copy.kind}' — refusing to cascade`)
    await teardownOrganization(copy.id)
  }

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

  // The platform owner account survives workspace deletion: the org delete
  // cascades to users, and the users-table trigger refuses to delete an owner
  // row (aborting the whole teardown). Detach the owner first — membership is
  // a nullable FK — and sign-in re-provisions them a fresh workspace.
  await systemPrisma.user.updateMany({
    where: { organizationId, email: { in: [...PLATFORM_OWNER_EMAILS], mode: 'insensitive' } },
    data: { organizationId: null },
  })
  await systemPrisma.organization.delete({ where: { id: organizationId } })
  return { nango, graphCleared, filesDeleted }
}
