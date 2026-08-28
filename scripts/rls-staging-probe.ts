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
 *      RLS_PROBE_FOREIGN_ORG — a second seeded org, also carrying a flow. The
 *        isolation check needs a foreign row that actually EXISTS; querying an
 *        id nothing was ever written under returns zero whether PostgreSQL is
 *        enforcing or not.
 *      DATABASE_RLS_ENABLED / DATABASE_URL / SYSTEM_DATABASE_URL — the config
 *      under test.
 */

async function main() {
  const org = process.env.RLS_PROBE_ORG
  if (!org) throw new Error('RLS_PROBE_ORG is required')

  const foreign = process.env.RLS_PROBE_FOREIGN_ORG
  if (!foreign) throw new Error('RLS_PROBE_FOREIGN_ORG is required')

  const { prisma, tenantTransaction } = await import('../src/lib/prisma')
  const result: Record<string, unknown> = {}

  // A model named in DATABASE_RLS_ENABLED: routed through the RLS transaction.
  result.stagedOwnTenant = (await prisma.flow.findMany({ where: { organizationId: org } })).length

  // A tenant with nothing of its own sees nothing.
  result.stagedForeignTenant = (
    await prisma.flow.findMany({ where: { organizationId: '00000000-0000-0000-0000-000000000000' } })
  ).length

  // What RLS does NOT defend against, pinned so nobody mistakes it for cover.
  //
  // Outside a tenant transaction the guard takes the tenant from the query's
  // OWN where clause and sets app.organization_id to match, so a query naming
  // another workspace reads that workspace and PostgreSQL agrees — it was told
  // to be that tenant. What keeps this safe is upstream: withAuthenticatedApi
  // sources the organizationId from the session, never from the request. RLS is
  // the second lock on a door the application still chooses.
  result.foreignTenantNamedDirectly = (
    await prisma.flow.findMany({ where: { organizationId: foreign } })
  ).length

  // Inside an ESTABLISHED tenant, though, naming another workspace is refused
  // outright — one transaction carries one app.organization_id, so there is no
  // configuration in which it could serve both.
  //
  // The callback is deliberately the NON-async form. Prisma methods return a
  // lazy promise, so this shape used to hand `tenantTransaction` an unstarted
  // query that ran after the tenant scope had already closed — and the
  // cross-workspace read was served rather than refused. `tenantTransaction`
  // now awaits inside its own scope; writing the callback the risky way here is
  // what keeps that fixed.
  try {
    await tenantTransaction(org, () => prisma.flow.findMany({ where: { organizationId: foreign } }))
    result.crossTenantInsideTransaction = 'allowed'
  } catch (error) {
    result.crossTenantInsideTransaction = /cross-workspace/.test(
      error instanceof Error ? error.message : String(error),
    )
      ? 'threw'
      : `threw-other: ${error instanceof Error ? error.message : String(error)}`
  }

  // The load-bearing one: is POSTGRESQL the boundary, or only the app?
  //
  // Every check above routes through the tenant guard, which refuses an
  // unscoped query before the database ever sees it — so they pass identically
  // whether or not RLS is switched on, and cannot tell the two apart. This
  // opens a tenant transaction for org A (SET LOCAL app.organization_id) and
  // then asks the database a question with NO tenant predicate at all. Under a
  // working policy it sees A's flow and not B's; with policies absent,
  // disabled, not FORCEd, or the connection on a BYPASSRLS role, it sees both.
  //
  // Raw SQL on purpose: the point is to bypass every application-side filter
  // and leave PostgreSQL as the only thing that could exclude the row.
  result.unscopedInsideTenant = await tenantTransaction(org, async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ organizationId: string }[]>(
      'SELECT DISTINCT "organizationId" FROM flows',
    )
    return {
      sawOwn: rows.some((r) => r.organizationId === org),
      sawForeign: rows.some((r) => r.organizationId === foreign),
    }
  })

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
