import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The staged RLS rollout, exercised against a real non-owner role.
 *
 * This exists because the per-model flag shipped broken in exactly the way it
 * was meant to prevent. `prisma` was built on the non-owner client, so staging a
 * SINGLE model switched every query onto the RLS-enforcing role while only the
 * staged model had `app.organization_id` set. Every other org-scoped table
 * matched its policy against an unset setting and returned zero rows — no error,
 * data simply gone. Staging one table emptied all the others, making the staged
 * path strictly more dangerous than the boolean it replaced.
 *
 * Each case runs in its own PROCESS (scripts/rls-staging-probe.ts). The choice
 * of connection is made once at module initialisation and cached on globalThis,
 * so a same-process test that re-imports with a cache-busting query string gets
 * the module the first import already built — and passes regardless of the code.
 * The first version of this file did that and reported three green tests against
 * the known-broken implementation.
 *
 * Skipped without TEST_DATABASE_URL; CI provides it.
 */

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  const APP_ROLE = 'rls_probe_app'
  const APP_PASSWORD = 'rls_probe_password'
  const PROBE = fileURLToPath(new URL('../../../scripts/rls-staging-probe.ts', import.meta.url))
  const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

  function asAppRole(url: string): string {
    const parsed = new URL(url)
    parsed.username = APP_ROLE
    parsed.password = APP_PASSWORD
    return parsed.toString()
  }

  let owner: any
  const ids: Record<string, string> = {}
  let skipReason: string | null = null

  before(async () => {
    process.env.DATABASE_URL = TEST_DB
    process.env.DIRECT_URL = TEST_DB
    ;({ systemPrisma: owner } = await import('@/lib/prisma'))

    try {
      await owner.$executeRawUnsafe(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
             CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}';
           END IF;
         END $$;`,
      )
      // NOBYPASSRLS is the whole point — a role that bypasses RLS would make
      // every assertion below pass without enforcing anything.
      await owner.$executeRawUnsafe(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOBYPASSRLS`)
      await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`)
      await owner.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
      )
    } catch (error) {
      // A managed database may forbid CREATE ROLE. Skip rather than fail.
      skipReason = `cannot create a non-owner role here: ${error instanceof Error ? error.message : String(error)}`
      return
    }

    const org = await owner.organization.create({
      data: { name: 'rls staged', slug: `rls-staged-${crypto.randomUUID()}` },
    })
    ids.org = org.id
    const user = await owner.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true },
    })
    const flow = await owner.flow.create({
      data: { name: 'staged probe', organizationId: org.id, userId: user.id },
    })
    await owner.flowRun.create({
      data: { flowId: flow.id, organizationId: org.id, status: 'completed' },
    })
  })

  after(async () => {
    if (ids.org) await owner.organization.delete({ where: { id: ids.org } }).catch(() => undefined)
  })

  /** Run the probe in a fresh process under the given staging configuration. */
  function probe(staged: string): Record<string, unknown> {
    const stdout = execFileSync('npx', ['tsx', PROBE], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        RLS_PROBE_ORG: ids.org,
        DATABASE_RLS_ENABLED: staged,
        DATABASE_URL: asAppRole(TEST_DB!),
        SYSTEM_DATABASE_URL: TEST_DB!,
        TSX_TSCONFIG_PATH: 'tsconfig.test.json',
      },
    })
    const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()
    assert.ok(line, `probe produced no JSON output:\n${stdout}`)
    return JSON.parse(line!)
  }

  test('staging one model does not empty the models that are not staged', (t) => {
    if (skipReason) return t.skip(skipReason)
    const result = probe('Flow')

    assert.equal(result.stagedOwnTenant, 1, 'the staged model should still return its own tenant rows')
    assert.equal(
      result.unstagedOwnTenant,
      1,
      'an UNSTAGED org-scoped model returned no rows — staging one model has emptied the others, ' +
        'which is the outage this mechanism exists to prevent',
    )
  })

  test('a staged model still enforces tenant isolation at the database', (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.equal(probe('Flow').stagedForeignTenant, 0, 'a foreign tenant must see nothing')
  })

  test('parent-scoped models throw without tenant context instead of returning empty', (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.equal(
      probe('true').parentScopedNoContext,
      'threw',
      'PostgreSQL returns zero rows here rather than an error, so the guard must throw',
    )
  })
}
