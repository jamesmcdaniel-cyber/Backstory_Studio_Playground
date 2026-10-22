import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The regression this guards: the agent reaper failed every `running` run whose
 * startedAt was 30 minutes back, alive or not. One model turn may take 28
 * minutes and an artifact render longer, so healthy runs were failed mid-turn
 * with "Run exceeded time limit" — and then flipped back to `completed` when
 * they finished. Reaping is now keyed on the liveness clock the executor
 * stamps while the run's process is alive.
 */

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let reap: typeof import('../reap')
  const ids: Record<string, string> = {}
  const minutes = (n: number) => new Date(Date.now() - n * 60_000)

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    reap = await import('../reap')
    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Reap', slug: `agent-reap-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `agent-reap-${stamp}@example.com`, name: 'Reap', organizationId: org.id },
    })
    ids.user = user.id
  })

  const execution = (data: Record<string, unknown>) =>
    prisma.agentExecution.create({
      data: { agentType: 'research', input: { prompt: 'test' }, trigger: { type: 'manual' }, userId: ids.user, organizationId: ids.org, ...data },
    })
  const read = (id: string) => prisma.agentExecution.findFirst({ where: { id, organizationId: ids.org } })

  test('a long run that is still beating is left alone', async () => {
    const run = await execution({ status: 'running', startedAt: minutes(45), lastActiveAt: minutes(1) })
    await reap.reapStuckAgentExecutions()
    assert.equal((await read(run.id)).status, 'running')
  })

  test('a run that stopped beating is failed, without claiming a time limit', async () => {
    const run = await execution({ status: 'running', startedAt: minutes(20), lastActiveAt: minutes(15) })
    await reap.reapStuckAgentExecutions()
    const after = await read(run.id)
    assert.equal(after.status, 'failed')
    assert.equal(after.error, reap.AGENT_STALE_RUN_ERROR)
    assert.doesNotMatch(after.error, /time limit/)
  })

  test('a just-resumed run carrying its pre-pause beat is spared until its new beats land', async () => {
    const run = await execution({ status: 'running', startedAt: minutes(1), lastActiveAt: minutes(60 * 24) })
    await reap.reapStuckAgentExecutions()
    assert.equal((await read(run.id)).status, 'running')
  })

  test('a run that never beat falls back to the 30-minute startedAt rule', async () => {
    const young = await execution({ status: 'running', startedAt: minutes(20) })
    const old = await execution({ status: 'running', startedAt: minutes(40) })
    const queued = await execution({ status: 'pending', startedAt: minutes(40) })
    await reap.reapStuckAgentExecutions()
    assert.equal((await read(young.id)).status, 'running')
    assert.equal((await read(old.id)).error, reap.AGENT_LEGACY_TIMEOUT_ERROR)
    assert.equal((await read(queued.id)).status, 'failed')
  })

  test('the hard ceiling fails even a beating run', async () => {
    const run = await execution({ status: 'running', startedAt: minutes(130), lastActiveAt: minutes(1) })
    await reap.reapStuckAgentExecutions()
    const after = await read(run.id)
    assert.equal(after.status, 'failed')
    assert.equal(after.error, reap.AGENT_CEILING_RUN_ERROR)
  })

  test('a stranded cancel resolves to cancelled once it stops beating — not before', async () => {
    const live = await execution({ status: 'cancelling', startedAt: minutes(40), lastActiveAt: minutes(1) })
    const dead = await execution({ status: 'cancelling', startedAt: minutes(40), lastActiveAt: minutes(15) })
    await reap.reapStuckAgentExecutions()
    assert.equal((await read(live.id)).status, 'cancelling')
    assert.equal((await read(dead.id)).status, 'cancelled')
  })

  test('terminal and paused runs are never touched', async () => {
    const done = await execution({ status: 'completed', startedAt: minutes(300), lastActiveAt: minutes(290) })
    const paused = await execution({ status: 'waiting_for_input', startedAt: minutes(300), lastActiveAt: minutes(290) })
    await reap.reapStuckAgentExecutions()
    assert.equal((await read(done.id)).status, 'completed')
    assert.equal((await read(paused.id)).status, 'waiting_for_input')
  })

  test('the heartbeat stamps a running row and never revives a reaped one', async () => {
    const { startExecutionHeartbeat } = await import('../liveness')
    const run = await execution({ status: 'running', startedAt: minutes(5) })
    const heartbeat = startExecutionHeartbeat(ids.org)
    heartbeat.track(run.id)
    heartbeat.stop()
    // The first beat is fire-and-forget; give it a moment to land.
    for (let i = 0; i < 50 && !(await read(run.id)).lastActiveAt; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok((await read(run.id)).lastActiveAt instanceof Date)

    const reaped = await execution({ status: 'failed', startedAt: minutes(5) })
    const late = startExecutionHeartbeat(ids.org)
    late.track(reaped.id)
    late.stop()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = await read(reaped.id)
    assert.equal(after.status, 'failed')
    assert.equal(after.lastActiveAt, null)
  })
}
