import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'

/**
 * The public run-resume callback. The run id must NOT be a capability: it is
 * shown to every member who can read the run, lands in logs, and is embedded in
 * URLs handed to third parties. These tests pin that only the minted token
 * opens the endpoint, and that a delivered callback cannot be replayed.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let hashToken: any
  let POST: any
  let seeded: any
  let flowId: string

  const makeWaitingRun = async (token: string | null) => {
    const run = await prisma.flowRun.create({
      data: {
        flowId,
        status: 'waiting',
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        ...(token ? { resumeTokenHash: hashToken(token) } : {}),
      },
    })
    await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: 'wait-1',
        status: 'waiting',
        output: { waiting: { kind: 'webhook' } },
      },
    })
    return run
  }

  const post = (runId: string, query: string) =>
    POST(
      new NextRequest(new URL(`http://test/api/flows/${flowId}/runs/${runId}/resume${query}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }),
    )

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ hashToken } = await import('@/lib/crypto/secrets'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    const flow = await prisma.flow.create({
      data: {
        name: 'Resume fixture',
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        graph: { nodes: [], edges: [] },
      },
    })
    flowId = flow.id
    ;({ POST } = await import('../[id]/runs/[runId]/resume/route'))
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('the run id alone does not resume a run', async () => {
    const token = randomBytes(24).toString('hex')
    const run = await makeWaitingRun(token)

    const response = await post(run.id, '')
    assert.equal(response.status, 404, 'a tokenless callback must be refused')

    const after = await prisma.flowRun.findFirst({
      where: { id: run.id, organizationId: seeded.organizationId },
    })
    assert.equal(after.status, 'waiting', 'the run must still be waiting')
    assert.ok(after.resumeTokenHash, 'the token must not be consumed by a failed attempt')
  })

  test('a wrong token is refused and is indistinguishable from a missing run', async () => {
    const run = await makeWaitingRun(randomBytes(24).toString('hex'))
    const response = await post(run.id, `?token=${randomBytes(24).toString('hex')}`)
    assert.equal(response.status, 404)

    const missing = await post('clnonexistentrunid0000', `?token=${randomBytes(24).toString('hex')}`)
    assert.equal(missing.status, 404, 'same status as a wrong token — no run-id oracle')
  })

  test('a run with no minted token fails closed', async () => {
    // Runs that were already waiting when the token shipped. Grandfathering
    // these would keep the hole open for the ids in circulation longest.
    const run = await makeWaitingRun(null)
    const response = await post(run.id, `?token=${randomBytes(24).toString('hex')}`)
    assert.equal(response.status, 404)
  })

  test('the correct token resumes the run and is then single-use', async () => {
    const token = randomBytes(24).toString('hex')
    const run = await makeWaitingRun(token)

    const first = await post(run.id, `?token=${token}`)
    assert.equal(first.status, 200, await first.text())

    const consumed = await prisma.flowRun.findFirst({
      where: { id: run.id, organizationId: seeded.organizationId },
    })
    assert.equal(consumed.resumeTokenHash, null, 'the token must be consumed on delivery')

    // Replaying the exact same callback must not drive the flow a second time.
    const replay = await post(run.id, `?token=${token}`)
    assert.equal(replay.status, 404)
  })

  test('the token also travels as a header, for systems that strip query strings', async () => {
    const token = randomBytes(24).toString('hex')
    const run = await makeWaitingRun(token)
    const response = await POST(
      new NextRequest(new URL(`http://test/api/flows/${flowId}/runs/${run.id}/resume`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-resume-token': token },
        body: JSON.stringify({ approved: true }),
      }),
    )
    assert.equal(response.status, 200, await response.text())
  })
}
