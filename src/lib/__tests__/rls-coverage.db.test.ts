import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ORG_SCOPED_MODELS } from '@/lib/tenant-guard'
import { RLS_PARENT_SCOPED_MODELS } from '@/lib/authz/rls-rollout'

/**
 * RLS policy coverage, checked against the real migrated database.
 *
 * Two defect classes made the first RLS rollout unsafe, and neither was visible
 * from the TypeScript side. Both are pinned here so the next table added after
 * an RLS migration cannot repeat them.
 *
 *   1. An org-scoped model whose table has RLS DISABLED. The tenant guard routes
 *      its queries through the RLS path and sets app.organization_id, PostgreSQL
 *      enforces nothing, and the application believes it is protected.
 *      (`flow_side_effects` shipped this way — created nine days after the RLS
 *      migration enumerated its tables by hand.)
 *
 *   2. A table whose policy reads app.organization_id but which no code path
 *      sets it for. PostgreSQL returns ZERO ROWS with no error, so run history
 *      and step output silently look deleted. These are the parent-scoped models
 *      (no organizationId column of their own); they must be declared in
 *      RLS_PARENT_SCOPED_MODELS so the guard can fail closed instead.
 *
 * Skipped without TEST_DATABASE_URL; CI provides it.
 */

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  /** table name -> { rls, forced, policies } */
  let dbState: Map<string, { rls: boolean; forced: boolean; policies: number }>
  /** Prisma model -> table name */
  let tableOf: Map<string, string>

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))

    const rows: Array<{ relname: string; rls: boolean; forced: boolean; policies: bigint }> =
      await prisma.$queryRaw`
        SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
               count(p.polname) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        GROUP BY 1, 2, 3`

    dbState = new Map(
      rows.map((r) => [r.relname, { rls: r.rls, forced: r.forced, policies: Number(r.policies) }]),
    )

    // Prisma model -> @@map table name, read from the schema rather than guessed
    // from a naming convention (several models do not follow one).
    const schema = readFileSync(
      fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url)),
      'utf8',
    )
    tableOf = new Map()
    let model = ''
    for (const line of schema.split('\n')) {
      const m = /^model\s+(\w+)\s*\{/.exec(line)
      if (m) {
        model = m[1]
        tableOf.set(model, model)
        continue
      }
      const mapped = /@@map\("([^"]+)"\)/.exec(line)
      if (mapped && model) tableOf.set(model, mapped[1])
      if (/^\}/.test(line)) model = ''
    }
  })

  test('every org-scoped model has RLS enabled with a policy', () => {
    const broken: string[] = []
    for (const model of ORG_SCOPED_MODELS) {
      const table = tableOf.get(model) ?? model
      const state = dbState.get(table)
      if (!state) {
        broken.push(`${model} (${table}): table not found`)
        continue
      }
      if (!state.rls) broken.push(`${model} (${table}): RLS disabled`)
      else if (state.policies === 0) broken.push(`${model} (${table}): RLS enabled but NO policy (deny-all)`)
    }
    assert.deepEqual(
      broken,
      [],
      'Org-scoped model(s) without database-level tenant isolation:\n  ' +
        broken.join('\n  ') +
        '\nAdd ENABLE + FORCE ROW LEVEL SECURITY and a tenant_isolation policy in a migration.',
    )
  })

  // A policy that never reads app.organization_id does not depend on tenant
  // context at all — a deliberate deny-all (platform_staff_emails) or a role
  // grant (users, organizations). Those are safe unrouted, so the check below
  // filters on the policy text rather than flagging every unrouted RLS table.
  test('tables whose policy reads app.organization_id are all routed or fail closed', async () => {
    const rows: Array<{ relname: string; expr: string | null }> = await prisma.$queryRaw`
      SELECT c.relname, pg_get_expr(p.polqual, p.polrelid) AS expr
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'`

    const routedTables = new Set([...ORG_SCOPED_MODELS].map((m) => tableOf.get(m) ?? m))
    const parentScopedTables = new Set([...RLS_PARENT_SCOPED_MODELS].map((m) => tableOf.get(m) ?? m))

    const silentlyEmpty = rows
      .filter((r) => r.expr?.includes('app.organization_id'))
      .map((r) => r.relname)
      .filter((table) => !routedTables.has(table) && !parentScopedTables.has(table))
      .filter((table, i, all) => all.indexOf(table) === i)
      .sort()

    assert.deepEqual(
      silentlyEmpty,
      [],
      'Table(s) whose RLS policy reads app.organization_id but which nothing sets it for:\n  ' +
        silentlyEmpty.join('\n  ') +
        '\nPostgreSQL returns ZERO ROWS for these — no error, data just looks deleted.\n' +
        'Either add the model to ORG_SCOPED_MODELS (if it has its own organizationId) ' +
        'or to RLS_PARENT_SCOPED_MODELS so the guard throws instead.',
    )
  })
}
