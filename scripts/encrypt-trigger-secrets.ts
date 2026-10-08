/**
 * Convert every legacy PLAINTEXT agent trigger secret into the hashed form the
 * trigger route verifies against.
 *
 *   npx tsx scripts/encrypt-trigger-secrets.ts --dry-run
 *   npx tsx scripts/encrypt-trigger-secrets.ts
 *
 * Why a hash and not encryptSecret(): the trigger route never needs the
 * plaintext back — it only has to decide whether a presented value matches —
 * so `AgentTask.metadata.triggerSecretHash` (SHA-256, the scheme the
 * trigger-secret route has minted since hashing was introduced) is the
 * existing protected form. Encrypting the plaintext would keep a decryptable
 * credential in the row for no reader that needs it. Hashing in place keeps
 * every existing caller's secret working unchanged: the value they already
 * send still verifies, and the plaintext column is dropped from the row.
 *
 * Safety properties, like scripts/rotate-encryption-key.ts:
 *   * Idempotent — rows already carrying triggerSecretHash are skipped.
 *   * Per-row — one bad row is reported and skipped, never aborts the sweep.
 *   * Dry run first: reports what would change and writes nothing.
 *
 * Cross-tenant by definition (systemPrisma), like every maintenance sweep.
 */

import type { Prisma } from '@prisma/client'
import { systemPrisma } from '../src/lib/prisma'
import { hashToken } from '../src/lib/crypto/secrets'
import { hasLegacyPlaintextTriggerSecret } from '../src/lib/agents/trigger-secret'

const DRY_RUN = process.argv.includes('--dry-run')
const PAGE = 500

async function main() {
  let cursor: string | undefined
  let scanned = 0
  let migrated = 0
  let failed = 0
  for (;;) {
    const rows: Array<{ id: string; metadata: unknown }> = await systemPrisma.agentTask.findMany({
      where: { status: { not: 'DELETED' } },
      select: { id: true, metadata: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id
    for (const row of rows) {
      scanned += 1
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? { ...(row.metadata as Record<string, unknown>) }
        : null
      if (!metadata || !hasLegacyPlaintextTriggerSecret(metadata)) continue
      const next: Record<string, unknown> = { ...metadata, triggerSecretHash: hashToken(metadata.triggerSecret as string) }
      delete next.triggerSecret
      if (DRY_RUN) {
        console.log(`[dry-run] would hash trigger secret for agent ${row.id}`)
        migrated += 1
        continue
      }
      try {
        // Guarded by id only: metadata is a JSON blob, so a concurrent write to
        // another key loses nothing more than this row's other fields as read
        // moments ago — the same read-modify-write the trigger-secret route does.
        await systemPrisma.agentTask.update({ where: { id: row.id }, data: { metadata: next as Prisma.InputJsonValue } })
        migrated += 1
        console.log(`hashed trigger secret for agent ${row.id}`)
      } catch (error) {
        failed += 1
        console.error(`FAILED agent ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}scanned ${scanned} agents, ${DRY_RUN ? 'would migrate' : 'migrated'} ${migrated}, failed ${failed}`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => systemPrisma.$disconnect())
