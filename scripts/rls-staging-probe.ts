/**
 * Probe fixture for src/lib/__tests__/rls-staged-rollout.db.test.ts.
 *
 * Runs as its own PROCESS on purpose. The behaviour under test is decided at
 * module initialisation — `src/lib/prisma.ts` picks which connection backs the
 * guarded client once, from `DATABASE_RLS_ENABLED`, and caches it on globalThis.
 * A same-process test that re-imports with a cache-busting query string gets the
 * module the first import already created, so the connection never changes and
 * the test passes no matter what the code does. (It did exactly that, silently,
 * until this fixture replaced it.)
 *
 * Reads its configuration from the environment, prints one JSON line, exits.
 *
 * Env: RLS_PROBE_ORG — the seeded organization id.
 *      DATABASE_RLS_ENABLED / DATABASE_URL / SYSTEM_DATABASE_URL — the config
 *      under test.
 */

async function main() {
  const org = process.env.RLS_PROBE_ORG
  if (!org) throw new Error('RLS_PROBE_ORG is required')

  const { prisma } = await import('../src/lib/prisma')
  const result: Record<string, unknown> = {}

  // A model named in DATABASE_RLS_ENABLED: routed through the RLS transaction.
  result.stagedOwnTenant = (await prisma.flow.findMany({ where: { organizationId: org } })).length

  // Isolation for that same staged model.
  result.stagedForeignTenant = (
    await prisma.flow.findMany({ where: { organizationId: '00000000-0000-0000-0000-000000000000' } })
  ).length

  // An org-scoped model NOT named in the flag. This is the regression: it must
  // keep working, which means it must NOT be served by the RLS-enforcing role
  // without tenant context.
  result.unstagedOwnTenant = (await prisma.flowRun.findMany({ where: { organizationId: org } })).length

  // Parent-scoped model with no tenant context must throw rather than return [].
  try {
    const rows = await prisma.flowRunStep.findMany({})
    result.parentScopedNoContext = `returned ${rows.length}`
  } catch (error) {
    result.parentScopedNoContext = error instanceof Error && /tenantTransaction/.test(error.message)
      ? 'threw'
      : `threw-other: ${error instanceof Error ? error.message : String(error)}`
  }

  console.log(JSON.stringify(result))
  await prisma.$disconnect()
}

main().catch((error) => {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
})
