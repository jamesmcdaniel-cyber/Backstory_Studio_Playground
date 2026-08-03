import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let recordLlmCall: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ recordLlmCall } = await import('@/lib/usage/ledger'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Ledger', slug: `ledger-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `ledger-${stamp}@example.com`, name: 'L', organizationId: org.id },
    })
    ids.user = user.id
    const execution = await prisma.agentExecution.create({
      data: { agentType: 'CUSTOM', status: 'succeeded', input: {}, trigger: {}, userId: user.id, organizationId: org.id },
    })
    ids.execution = execution.id
  })

  test('a call writes a detail row with split buckets and a positive cost', async () => {
    await recordLlmCall({
      organizationId: ids.org,
      agentExecutionId: ids.execution,
      surface: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 1000, cacheWriteTokens: 200, cacheReadTokens: 5000, outputTokens: 300 },
    })

    const rows = await prisma.llmCall.findMany({ where: { organizationId: ids.org, agentExecutionId: ids.execution } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].inputTokens, 1000)
    assert.equal(rows[0].cacheWriteTokens, 200)
    assert.equal(rows[0].cacheReadTokens, 5000)
    assert.equal(rows[0].outputTokens, 300)
    assert.equal(rows[0].surface, 'agent_turn')
    assert.ok(Number(rows[0].costUsd) > 0)
  })

  test('the execution rollup equals the sum of its detail rows', async () => {
    await recordLlmCall({
      organizationId: ids.org,
      agentExecutionId: ids.execution,
      surface: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 100 },
    })

    const execution = await prisma.agentExecution.findFirst({ where: { id: ids.execution, organizationId: ids.org } })
    const rows = await prisma.llmCall.findMany({ where: { organizationId: ids.org, agentExecutionId: ids.execution } })
    const detailSum = rows.reduce((total: number, row: any) => total + Number(row.costUsd), 0)
    assert.equal(rows.length, 2)
    assert.ok(Math.abs(Number(execution.costUsd) - detailSum) < 1e-6, 'rollup must equal the sum of detail rows')
  })

  test('an unattached call (no execution or run) still records', async () => {
    await recordLlmCall({
      organizationId: ids.org,
      surface: 'headline',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 20 },
    })

    const rows = await prisma.llmCall.findMany({ where: { organizationId: ids.org, surface: 'headline' } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].agentExecutionId, null)
  })

  test('an unknown model records a zero-cost row without moving the rollup', async () => {
    const before = await prisma.agentExecution.findFirst({ where: { id: ids.execution, organizationId: ids.org } })
    await recordLlmCall({
      organizationId: ids.org,
      agentExecutionId: ids.execution,
      surface: 'structured',
      provider: 'anthropic',
      model: 'claude-model-from-the-future',
      usage: { inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 },
    })

    const row = await prisma.llmCall.findFirst({
      where: { organizationId: ids.org, agentExecutionId: ids.execution, model: 'claude-model-from-the-future' },
    })
    assert.ok(row, 'the detail row must still be written so the gap is visible')
    assert.equal(row.priceVersion, 'unknown')
    assert.equal(Number(row.costUsd), 0)

    const after = await prisma.agentExecution.findFirst({ where: { id: ids.execution, organizationId: ids.org } })
    assert.equal(Number(after.costUsd), Number(before.costUsd))
  })

  test('a ledger failure never throws into the caller', async () => {
    // A non-existent org violates the FK-free column but the contract is that
    // recordLlmCall cannot throw regardless of what the write does.
    await recordLlmCall({
      organizationId: '00000000-0000-0000-0000-000000000000',
      agentExecutionId: 'does-not-exist',
      surface: 'structured',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 },
    })
    assert.ok(true, 'recordLlmCall resolved without throwing')
  })
}
