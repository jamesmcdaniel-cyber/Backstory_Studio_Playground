/**
 * Re-encrypt every stored secret onto the ACTIVE encryption key.
 *
 * Step 2 of the dual-read / single-write rotation described in
 * src/lib/crypto/secrets.ts. Run it with BOTH keys configured:
 *
 *   ENCRYPTION_KEY=<new> ENCRYPTION_KEY_PREVIOUS=<old> npm run secrets:rotate -- --dry-run
 *   ENCRYPTION_KEY=<new> ENCRYPTION_KEY_PREVIOUS=<old> npm run secrets:rotate
 *
 * The dry run reads and re-encrypts in memory but writes nothing, so it proves
 * every payload is decryptable BEFORE anything is modified. Only when it reports
 * zero failures is the real run safe.
 *
 * Safety properties:
 *   * Idempotent — payloads already on the active key are skipped, so an
 *     interrupted run is resumed by simply running it again.
 *   * Per-row, not per-table — one undecryptable row is reported and skipped
 *     rather than aborting the sweep and leaving the database half-rotated.
 *   * Read-modify-write per row inside its own update, so a concurrent write
 *     from the running app loses at most that row (which the next run fixes).
 *
 * Cross-tenant by definition: uses systemPrisma, like every other maintenance
 * sweep. There is no per-workspace rotation.
 */

import { Prisma } from '@prisma/client'
import { systemPrisma } from '../src/lib/prisma'
import { activeKeyId, decryptSecret, encryptSecret, isCurrentKeyPayload } from '../src/lib/crypto/secrets'

const DRY_RUN = process.argv.includes('--dry-run')

/** JSON blob keys that hold an encrypted payload. Everything else is plain. */
const ENCRYPTED_CONFIG_KEYS = ['apiKey', 'clientSecret', 'accessToken', 'refreshToken']

interface Tally {
  scanned: number
  rotated: number
  skipped: number
  failed: number
}

const failures: string[] = []

function newTally(): Tally {
  return { scanned: 0, rotated: 0, skipped: 0, failed: 0 }
}

/** Re-encrypt one payload, or return null when it is already current. */
function reencrypt(payload: string): string | null {
  if (isCurrentKeyPayload(payload)) return null
  return encryptSecret(decryptSecret(payload))
}

/** Rotate the encrypted string columns of a table. */
async function rotateStringColumns(
  label: string,
  rows: Array<{ id: string } & Record<string, unknown>>,
  columns: string[],
  update: (id: string, data: Record<string, string>) => Promise<unknown>,
): Promise<Tally> {
  const tally = newTally()

  for (const row of rows) {
    tally.scanned += 1
    const data: Record<string, string> = {}
    try {
      for (const column of columns) {
        const value = row[column]
        if (typeof value !== 'string' || !value) continue
        const next = reencrypt(value)
        if (next) data[column] = next
      }
    } catch (error) {
      tally.failed += 1
      failures.push(`${label} ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    if (!Object.keys(data).length) {
      tally.skipped += 1
      continue
    }
    if (!DRY_RUN) await update(row.id, data)
    tally.rotated += 1
  }

  return tally
}

/** Rotate the encrypted members of a JSON config blob. */
async function rotateJsonConfig(
  label: string,
  rows: Array<{ id: string; authConfig: unknown }>,
  update: (id: string, authConfig: Record<string, unknown>) => Promise<unknown>,
): Promise<Tally> {
  const tally = newTally()

  for (const row of rows) {
    tally.scanned += 1
    const config =
      row.authConfig && typeof row.authConfig === 'object' && !Array.isArray(row.authConfig)
        ? { ...(row.authConfig as Record<string, unknown>) }
        : null
    if (!config) {
      tally.skipped += 1
      continue
    }

    let changed = false
    try {
      for (const key of ENCRYPTED_CONFIG_KEYS) {
        const value = config[key]
        if (typeof value !== 'string' || !value) continue
        const next = reencrypt(value)
        if (next) {
          config[key] = next
          changed = true
        }
      }
    } catch (error) {
      tally.failed += 1
      failures.push(`${label} ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    if (!changed) {
      tally.skipped += 1
      continue
    }
    if (!DRY_RUN) await update(row.id, config)
    tally.rotated += 1
  }

  return tally
}

async function main() {
  const keyId = activeKeyId()
  if (!keyId) {
    console.error('ENCRYPTION_KEY is not set — nothing to rotate onto.')
    process.exit(1)
  }

  console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}rotating secrets onto key ${keyId}\n`)

  const results: Array<[string, Tally]> = []

  results.push([
    'mcp_connections.authConfig',
    await rotateJsonConfig(
      'mcp_connections',
      await systemPrisma.mcpConnection.findMany({ select: { id: true, authConfig: true } }),
      // Cast: the blob is plain JSON by construction, but Prisma's InputJsonValue
      // does not accept an open Record<string, unknown>.
      (id, authConfig) => systemPrisma.mcpConnection.update({ where: { id }, data: { authConfig: authConfig as Prisma.InputJsonValue } }),
    ),
  ])

  results.push([
    'integration_secrets.authConfig',
    await rotateJsonConfig(
      'integration_secrets',
      await systemPrisma.integrationSecret.findMany({ select: { id: true, authConfig: true } }),
      (id, authConfig) => systemPrisma.integrationSecret.update({ where: { id }, data: { authConfig: authConfig as Prisma.InputJsonValue } }),
    ),
  ])

  results.push([
    'http_credentials.secretConfig',
    await rotateStringColumns(
      'http_credentials',
      await systemPrisma.httpCredential.findMany({ select: { id: true, secretConfig: true } }),
      ['secretConfig'],
      (id, data) => systemPrisma.httpCredential.update({ where: { id }, data }),
    ),
  ])

  results.push([
    'external_secret_providers.authConfig',
    await rotateStringColumns(
      'external_secret_providers',
      await systemPrisma.externalSecretProvider.findMany({
        where: { authConfig: { not: null } },
        select: { id: true, authConfig: true },
      }),
      ['authConfig'],
      (id, data) => systemPrisma.externalSecretProvider.update({ where: { id }, data }),
    ),
  ])

  results.push([
    'audit_stream_destinations.secret',
    await rotateStringColumns(
      'audit_stream_destinations',
      await systemPrisma.auditStreamDestination.findMany({
        where: { secret: { not: null } },
        select: { id: true, secret: true },
      }),
      ['secret'],
      (id, data) => systemPrisma.auditStreamDestination.update({ where: { id }, data }),
    ),
  ])

  results.push([
    'organizations.peopleAiWebhookSecret',
    await rotateStringColumns(
      'organizations',
      await systemPrisma.organization.findMany({
        where: { peopleAiWebhookSecret: { not: null } },
        select: { id: true, peopleAiWebhookSecret: true },
      }),
      ['peopleAiWebhookSecret'],
      (id, data) => systemPrisma.organization.update({ where: { id }, data }),
    ),
  ])

  results.push([
    'peopleai_connections tokens',
    await rotateStringColumns(
      'peopleai_connections',
      await systemPrisma.peopleAiConnection.findMany({
        select: { id: true, accessToken: true, refreshToken: true },
      }),
      ['accessToken', 'refreshToken'],
      (id, data) => systemPrisma.peopleAiConnection.update({ where: { id }, data }),
    ),
  ])

  const total = results.reduce<Tally>(
    (sum, [, t]) => ({
      scanned: sum.scanned + t.scanned,
      rotated: sum.rotated + t.rotated,
      skipped: sum.skipped + t.skipped,
      failed: sum.failed + t.failed,
    }),
    newTally(),
  )

  for (const [label, t] of results) {
    console.log(`  ${label.padEnd(38)} scanned ${t.scanned}  rotated ${t.rotated}  current ${t.skipped}  failed ${t.failed}`)
  }
  console.log(
    `\n${DRY_RUN ? 'would rotate' : 'rotated'} ${total.rotated} of ${total.scanned} payloads ` +
      `(${total.skipped} already current, ${total.failed} failed)`,
  )

  if (failures.length) {
    console.error('\nFailures — these rows still hold a payload no configured key can read:')
    for (const failure of failures) console.error(`  ${failure}`)
    console.error(
      '\nAdd the missing key to ENCRYPTION_KEY_PREVIOUS and re-run. Do NOT unset it ' +
        'until this reports zero failures and zero remaining.',
    )
    process.exit(1)
  }

  if (!DRY_RUN && total.rotated > 0) {
    console.log('\nRe-run to confirm 0 remaining, then unset ENCRYPTION_KEY_PREVIOUS.')
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => systemPrisma.$disconnect())
