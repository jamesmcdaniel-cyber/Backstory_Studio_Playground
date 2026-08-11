import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The gap these guard: idempotency keys reached exactly ONE call site (the HTTP
 * step), so every tool write — Slack post, Gmail send, Drive upload, any Nango
 * or MCP delivery tool — had no replay protection at all. A retry, a resumed
 * run, or a re-emitted poll item fired the write a second time.
 */

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let readLedger: any
  let writeLedger: any
  const ids: Record<string, string> = {}

  const write = (scopeKey: string, iterationKey: string, result: unknown, flowRunId: string | null = null) =>
    writeLedger({
      scopeKey,
      iterationKey,
      page: 0,
      organizationId: ids.org,
      provider: 'slack',
      tool: 'slack_post_message',
      result,
      flowRunId,
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ readLedger, writeLedger } = await import('@/lib/flows/side-effect-ledger'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Ledger', slug: `ledger-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `ledger-${stamp}@example.com`,
        name: 'L',
        organizationId: org.id,
      },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Ledger flow', organizationId: org.id, userId: user.id, graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
  })

  test('a recorded side effect is returned on replay instead of re-executing', async () => {
    const scopeKey = `run-replay-${Date.now()}`
    await write(scopeKey, 'send', { ok: true, ts: '1234.5678' })
    const hit = await readLedger({ scopeKey, iterationKey: 'send', page: 0, organizationId: ids.org })
    assert.deepEqual(hit, { result: { ok: true, ts: '1234.5678' } })
  })

  test('a fresh key is a miss, so the first attempt executes normally', async () => {
    const miss = await readLedger({
      scopeKey: `run-fresh-${Date.now()}`,
      iterationKey: 'send',
      page: 0,
      organizationId: ids.org,
    })
    assert.equal(miss, null)
  })

  test('another org cannot read this org ledger row, even with the exact scope', async () => {
    const scopeKey = `run-tenant-${Date.now()}`
    await write(scopeKey, 'send', { ok: true, secret: 'theirs' })
    const other = await prisma.organization.create({
      data: { name: 'Other', slug: `other-${Date.now()}` },
    })
    const leaked = await readLedger({ scopeKey, iterationKey: 'send', page: 0, organizationId: other.id })
    assert.equal(leaked, null, 'a scope collision must never hand one workspace another workspace result')
  })

  test('two concurrent writes on one key both settle and the row survives once', async () => {
    const scopeKey = `run-race-${Date.now()}`
    await Promise.all([write(scopeKey, 'send', { attempt: 1 }), write(scopeKey, 'send', { attempt: 2 })])
    const rows = await prisma.flowSideEffect.findMany({ where: { scopeKey, organizationId: ids.org } })
    assert.equal(rows.length, 1)
  })

  test('per-iteration keys do not collide inside a loop', async () => {
    const scopeKey = `run-loop-${Date.now()}`
    for (const iterationKey of ['send#0', 'send#1', 'send#2']) {
      await write(scopeKey, iterationKey, { iterationKey })
    }
    const rows = await prisma.flowSideEffect.findMany({ where: { scopeKey, organizationId: ids.org } })
    assert.equal(rows.length, 3)
  })

  test('two runs for the same polled item share a scope, so the second replays', async () => {
    const { runScopeKey } = await import('@/lib/flows/side-effect-ledger')
    const dedupeValue = `item-${Date.now()}`
    const a = runScopeKey({ id: 'run-a', flowId: ids.flow, trigger: { type: 'poll', dedupeValue } })
    const b = runScopeKey({ id: 'run-b', flowId: ids.flow, trigger: { type: 'poll', dedupeValue } })
    assert.equal(a, b)

    await write(a, 'send', { ok: true })
    const replayed = await readLedger({ scopeKey: b, iterationKey: 'send', page: 0, organizationId: ids.org })
    assert.deepEqual(replayed, { result: { ok: true } })
  })

  test('a deleted run leaves its poll-scoped ledger row intact', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, trigger: { type: 'poll' } },
    })
    const scopeKey = `${ids.flow}:item-keep-${Date.now()}`
    await write(scopeKey, 'send', { ok: true }, run.id)

    await prisma.flowRun.delete({ where: { id: run.id, organizationId: ids.org } })

    const row = await prisma.flowSideEffect.findFirst({ where: { scopeKey, organizationId: ids.org } })
    assert.ok(row, 'the ledger row must outlive its run or poll dedupe silently breaks')
    assert.equal(row.flowRunId, null)
  })

  test('a ledger read failure degrades to a miss rather than failing the step', async () => {
    // A malformed key cannot match; the helper must return null, not throw.
    await assert.doesNotReject(
      readLedger({ scopeKey: '', iterationKey: '', page: 0, organizationId: ids.org }),
    )
  })
}
