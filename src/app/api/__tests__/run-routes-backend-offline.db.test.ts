import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Queue mode with a dead worker fleet: every path that starts an agent run
 * refuses it up front instead of enqueueing blindly.
 *
 * Flow dispatch and agent chat already did (assertQueueConsumerAlive). The
 * manual execute route, the external trigger route and dispatchAgentExecution
 * (ROI, artifact assistant, schedules, Slack) did not — the job sat in Redis
 * with nobody consuming it and the run `pending` until the 30-minute reaper
 * failed it, while the person was told it had started.
 *
 * Runs against real Postgres AND real Redis, with a heartbeat that is
 * genuinely stale, so the gate under test is the production one rather than a
 * stub of it. The Redis side uses its own logical database so a heartbeat key
 * written here can never be read by anything else sharing the server.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
const TEST_REDIS = process.env.TEST_REDIS_URL
const OFFLINE_DB_INDEX = '13'
if (TEST_DB && TEST_REDIS) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'
  // Before ANY route import: both are read into module constants at load.
  process.env.EXECUTION_MODE = 'queue'
  delete process.env.BULLMQ_DISABLE
  // Set in before(), AFTER the rate limiter and cache have resolved their
  // backends: with REDIS_URL present each opens a TCP client nothing closes,
  // and the file would pass and then hang on the handle.
  delete process.env.REDIS_URL
}
const offlineRedisUrl = () => {
  const redis = new URL(TEST_REDIS!)
  redis.pathname = `/${OFFLINE_DB_INDEX}`
  return redis.toString()
}

let skip: string | false = !TEST_DB ? 'requires TEST_DATABASE_URL' : !TEST_REDIS ? 'requires TEST_REDIS_URL' : false

let prisma: any
let helpers: any
let installTestAuth: (auth: any) => void
let fixture: any
let agentId = ''
const TRIGGER_SECRET = `trigger-${process.pid}-${Date.now()}`
const writtenKeys: string[] = []

before(async () => {
  if (skip) return
  // The rate limiter and the cache each pick their backend once, on first use;
  // resolved now, they stay in memory instead of holding open TCP clients.
  const { rateLimit } = await import('@/lib/ratelimit')
  await rateLimit(`offline-test-prime:${process.pid}`, { limit: 1_000, windowMs: 1_000 })
  ;(await import('@/lib/cache')).getCache()
  process.env.REDIS_URL = offlineRedisUrl()
  const config = await import('@/lib/queue/config')
  const heartbeat = await import('@/lib/queue/heartbeat')
  const redis = config.getRedisConnection()

  // A worker really consuming this Redis would make the gate answer "alive",
  // and rightly. Say so instead of failing on a dev machine running one.
  const { Queue } = await import('bullmq')
  const probe = new Queue(config.QUEUE_NAMES.AGENT_EXECUTION, { connection: redis })
  const workers = await probe.getWorkers()
  await probe.close()
  if (workers.length > 0) {
    skip = `a live BullMQ worker is consuming ${config.QUEUE_NAMES.AGENT_EXECUTION} on this Redis`
    return
  }

  // Stale, not merely absent: the outage shape is a fleet that stopped
  // writing, leaving its last heartbeat behind.
  const stale = String(Date.now() - heartbeat.WORKER_HEARTBEAT_STALE_MS * 4)
  for (const key of [heartbeat.WORKER_HEARTBEAT_KEY, heartbeat.workerQueueHeartbeatKey(config.QUEUE_NAMES.AGENT_EXECUTION)]) {
    await redis.set(key, stale, 'PX', 60_000)
    writtenKeys.push(key)
  }

  helpers = await import('./helpers/stub-execution')
  ;({ prisma } = await import('@/lib/prisma'))
  const testAuth = await import('@/lib/server/__tests__/test-auth')
  installTestAuth = testAuth.installTestAuth
  fixture = await testAuth.seedTestOrg(prisma)
  const { hashToken } = await import('@/lib/crypto/secrets')
  agentId = (
    await prisma.agentTask.create({
      data: {
        description: 'offline agent',
        objective: 'say hello',
        status: 'ACTIVE',
        visibility: 'shared',
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        metadata: { triggerSecretHash: hashToken(TRIGGER_SECRET) },
      },
    })
  ).id
})

after(async () => {
  if (!TEST_DB || !TEST_REDIS) return
  await fixture?.cleanup?.()
  const config = await import('@/lib/queue/config')
  const redis = config.getRedisConnection()
  if (writtenKeys.length) await redis.del(...writtenKeys).catch(() => undefined)
  // config.ts holds one ioredis client for the process; left open, the file
  // passes and then hangs on the handle.
  await redis.quit().catch(() => undefined)
})

const countRuns = () => prisma.agentExecution.count({ where: { organizationId: fixture.organizationId } })

test('POST /api/agents/[id]/execute answers a stale heartbeat with 503 and leaves no run behind', async (t) => {
  if (skip) return t.skip(skip)
  installTestAuth(fixture.auth)
  const before = await countRuns()
  const { POST } = await import('../agents/[id]/execute/route')
  const response = await POST(helpers.jsonRequest(NextRequest, `/api/agents/${agentId}/execute`, 'POST', { input: 'hello' }))
  const body = await helpers.readJson(response)
  const { EXECUTION_BACKEND_OFFLINE_CODE, EXECUTION_BACKEND_OFFLINE_MESSAGE } = await import('@/lib/queue/backend-offline')
  assert.equal(response.status, 503, JSON.stringify(body))
  assert.equal(body.code, EXECUTION_BACKEND_OFFLINE_CODE)
  assert.equal(body.error, EXECUTION_BACKEND_OFFLINE_MESSAGE)
  assert.equal(await countRuns(), before, 'the refused run must not leave a row — above all not a pending one')
})

test('POST /api/agents/[id]/trigger answers a stale heartbeat with the same 503 and creates no run', async (t) => {
  if (skip) return t.skip(skip)
  const before = await countRuns()
  const { POST } = await import('../agents/[id]/trigger/route')
  const request = new NextRequest(new URL(`http://test/api/agents/${agentId}/trigger`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trigger-secret': TRIGGER_SECRET },
    body: JSON.stringify({ input: 'hello' }),
  } as never)
  const response = await POST(request)
  const body = await helpers.readJson(response)
  assert.equal(response.status, 503, JSON.stringify(body))
  assert.equal(body.code, 'EXECUTION_BACKEND_OFFLINE')
  assert.equal(await countRuns(), before)
})

test('dispatchAgentExecution refuses to enqueue with no live consumer', async (t) => {
  if (skip) return t.skip(skip)
  const { dispatchAgentExecution } = await import('@/features/agents/dispatch')
  const { isExecutionBackendOffline } = await import('@/lib/queue/backend-offline')
  const config = await import('@/lib/queue/config')
  const executionId = `offline-${process.pid}-${Date.now()}`
  await assert.rejects(
    dispatchAgentExecution({ executionId, agentId, organizationId: fixture.organizationId, userId: fixture.userId, input: 'hello' }),
    (error: unknown) => isExecutionBackendOffline(error),
  )
  // Its callers terminalize their row on this throw; what must not exist is a
  // job nobody will ever take.
  const queue = config.createQueue(config.QUEUE_NAMES.AGENT_EXECUTION)
  try {
    assert.equal(await queue.getJob(executionId), undefined)
  } finally {
    await queue.close()
  }
})
