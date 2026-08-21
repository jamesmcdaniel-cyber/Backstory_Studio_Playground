import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * GET /api/snapshot used to source its usage numerator from agentExecution
 * alone (the agent plane only) and its denominator from nothing at all — the
 * sidebar's percentage divided by a hardcoded CREDIT_TOKENS constant unrelated
 * to the enforced budget. This pins the fix at the route boundary: the
 * response now carries {usedTokens, budgetTokens} sourced from the same
 * LlmCall aggregate + enforced ceiling that gates runs, so the number on
 * screen and the number that stops a run are the same number.
 *
 * DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  const ENV = 'AGENT_MONTHLY_TOKEN_LIMIT'
  process.env[ENV] = '1000000000'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let recordLlmCall: any
  let GET: any

  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    ;({ recordLlmCall } = await import('@/lib/usage/ledger'))
    ;({ GET } = await import('../route'))

    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)

    // A flow-plane row: no agentExecutionId, exactly what the old
    // agentExecution-only aggregate would have missed entirely.
    await recordLlmCall({
      organizationId: seeded.organizationId,
      surface: 'flow_ai',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 700, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 300 },
    })
  })

  after(async () => {
    if (seeded) {
      await prisma.llmCall.deleteMany({ where: { organizationId: seeded.organizationId } })
      await seeded.cleanup()
    }
  })

  test('the snapshot reports {usedTokens, budgetTokens} sourced from LlmCall + the enforced ceiling', async () => {
    const response = await GET(new NextRequest(new URL('http://test/api/snapshot')))
    const body = await response.json()
    assert.equal(body.usage.usedTokens, 1000, 'the flow-plane row must be counted, not just agentExecution rows')
    assert.equal(body.usage.budgetTokens, 1_000_000_000)
    assert.equal(body.usage.exempt, false)
  })
}
