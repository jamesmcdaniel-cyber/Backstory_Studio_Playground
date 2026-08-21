import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * checkMonthlyTokenBudget's DB fallback used to sum agentExecution only, which
 * is the AGENT plane alone — a flow run's tokens live in LlmCall (and briefly
 * in Redis) and were invisible to it. After a Redis reset/outage, a workspace
 * that only ran flows would report used=0 no matter how much it had spent.
 *
 * These pin: (1) the DB fallback now sums LlmCall's four token buckets
 * org-wide since month start, so a flow-plane-only org still counts when
 * Redis returns null; (2) estimated and provider-reported usage live in
 * sibling Redis keys and both count toward enforcement; (3) the enforced
 * ceiling is exposed via monthlyTokenBudgetFor for surfaces to display.
 *
 * DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // An explicit, deterministic ceiling for these tests, independent of
  // whatever tier defaults happen to be tuned to.
  const ENV = 'AGENT_MONTHLY_TOKEN_LIMIT'
  const prevEnv = process.env[ENV]

  let prisma: any
  let checkMonthlyTokenBudget: any
  let monthlyTokenBudgetFor: any
  let recordTokenUsage: any
  let resetMonthlyTokenUsage: any
  let recordLlmCall: any

  const ids: Record<string, string> = {}

  before(async () => {
    process.env[ENV] = '1000000000' // 1B — high enough that no fixture tips it over
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ checkMonthlyTokenBudget, monthlyTokenBudgetFor, recordTokenUsage, resetMonthlyTokenUsage } = await import('../budget'))
    ;({ recordLlmCall } = await import('../ledger'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Budget truth', slug: `budget-truth-${stamp}` } })
    ids.org = org.id
    // No Redis configured in this test run (no REDIS_URL/UPSTASH_* env), so the
    // cache backend is the bounded in-memory fallback — a fresh, empty counter
    // for this org is exactly the "Redis returns null" scenario under test.
    await resetMonthlyTokenUsage(ids.org)
  })

  after(async () => {
    if (ids.org) {
      await prisma.llmCall.deleteMany({ where: { organizationId: ids.org } })
      await prisma.organization.delete({ where: { id: ids.org } })
    }
    if (prevEnv === undefined) delete process.env[ENV]
    else process.env[ENV] = prevEnv
  })

  test('monthlyTokenBudgetFor exposes the enforced ceiling', async () => {
    assert.equal(await monthlyTokenBudgetFor(ids.org), 1_000_000_000)
  })

  test('a flow-plane-only org (LlmCall rows, no AgentExecution, no live counter) still counts', async () => {
    // The flow AI-step surface, with no agentExecutionId — the row shape a
    // pure-flow org produces. (No flowRunId either: recordLlmCall's rollup
    // increment would try to update a real FlowRun row, which this fixture
    // has no need to create just to prove the aggregate sees the row.)
    await recordLlmCall({
      organizationId: ids.org,
      surface: 'flow_ai',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 1000, cacheWriteTokens: 200, cacheReadTokens: 300, outputTokens: 500 },
    })

    const result = await checkMonthlyTokenBudget(ids.org)
    // 1000 + 200 + 300 + 500 = 2000 — the same four-bucket sum the ledger writes.
    assert.equal(result.used, 2000)
    assert.equal(result.over, false)
    assert.equal(result.limit, 1_000_000_000)

    // Clean up so later tests exercise the live-counter path in isolation,
    // rather than racing this fixture's DB total forever.
    await prisma.llmCall.deleteMany({ where: { organizationId: ids.org } })
  })

  test('estimated and provider-reported usage are sibling keys that both count toward enforcement', async () => {
    await resetMonthlyTokenUsage(ids.org)
    await recordTokenUsage(ids.org, 400) // reported
    await recordTokenUsage(ids.org, 150, { estimated: true }) // estimated

    const result = await checkMonthlyTokenBudget(ids.org)
    // The live counters (400 + 150 = 550) exceed the DB total (0, no LlmCall
    // rows recorded in this window) so the live sum wins.
    assert.equal(result.used, 550)
  })

  test('resetting the monthly counter clears both the reported and estimated keys', async () => {
    await recordTokenUsage(ids.org, 400)
    await recordTokenUsage(ids.org, 150, { estimated: true })
    await resetMonthlyTokenUsage(ids.org)

    const result = await checkMonthlyTokenBudget(ids.org)
    assert.equal(result.used, 0, 'both live keys must be cleared, or a reset silently leaves the estimated half standing')
  })
}
