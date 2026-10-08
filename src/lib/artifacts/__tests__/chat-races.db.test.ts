import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The conversation column under concurrent writers, against a real database:
 * the compare-and-swap on updatedAt (Postgres keeps the millisecond Prisma
 * wrote, so a snapshot's Date compares exactly), a send that lands while
 * another send is between its read and its write, and what a send leaves
 * behind when the dispatcher refuses the run.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('artifact chat races (requires TEST_DATABASE_URL)', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
  let service: typeof import('../service')
  let chatWrites: typeof import('../chat-writes')
  let restoreExecution: () => void
  let agentTaskId: string
  const content = '<html><body><h1>Chat races</h1></body></html>'

  const pendingChat = (executionId: string) => [
    { role: 'user', mode: 'auto', content: 'first', createdAt: new Date().toISOString() },
    { role: 'agent', mode: 'auto', content: '', executionId, status: 'pending', createdAt: new Date().toISOString() },
  ]

  before(async () => {
    const helpers = await import('@/app/api/__tests__/helpers/stub-execution')
    // Runs stop at the queue dispatcher (which refuses them here), never at a model.
    restoreExecution = helpers.stubBackgroundExecution()
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    service = await import('../service')
    chatWrites = await import('../chat-writes')
    agentTaskId = (await prisma.agentTask.create({ data: { organizationId: seeded.organizationId, userId: seeded.userId, description: 'Artifact assistant', objective: 'Answer about the artifact', status: 'ACTIVE' } })).id
  })

  after(async () => {
    restoreExecution?.()
    if (seeded) await seeded.cleanup()
  })

  async function freshArtifact(title: string) {
    const { artifact } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'report', title, content, agentTaskId })
    return artifact
  }

  test('a chat write lands only on the row it was computed from — a poll cannot put an old conversation back', async () => {
    const artifact = await freshArtifact('CAS')
    const snapshot = await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId } })
    // Nothing moved: the snapshot's Date matches the stored timestamp exactly.
    assert.equal(await chatWrites.casChatWrite(prisma, snapshot, [{ role: 'user', content: 'noted', createdAt: 'a' }]), true)
    // A send landed after this poll read the row: the poll's write must miss.
    const polled = await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId } })
    await prisma.artifact.update({ where: { id: artifact.id, organizationId: seeded.organizationId }, data: { chat: pendingChat('run-landed') } })
    assert.equal(await chatWrites.casChatWrite(prisma, polled, [{ role: 'user', content: 'stale reconcile', createdAt: 'b' }]), false)
    const after = await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId } })
    assert.equal(after.chat[1].executionId, 'run-landed', 'the sent message survived the stale write')
    // rewriteChat recomputes from the fresh row and lands.
    const row = await chatWrites.rewriteChat(prisma, seeded.organizationId, artifact.id, (chat) => chat.map((m: any) => (m.executionId === 'run-landed' ? { ...m, status: 'completed', content: 'done' } : m)), polled)
    assert.deepEqual((row!.chat as any[]).map((m) => [m.role, m.status ?? null, m.content]), [['user', null, 'first'], ['agent', 'completed', 'done']])
  })

  test('two sends racing: the one that writes second sees the pending message and refuses, and starts no run', async () => {
    const artifact = await freshArtifact('Double send')
    const runsBefore = await prisma.agentExecution.count({ where: { organizationId: seeded.organizationId, agentTaskId } })
    // The first send has read an empty conversation and is inside its
    // transaction, before recording its run, when the other lands.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const first = service.askArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, id: artifact.id, message: 'first question', mode: 'auto', admit: async () => { entered(); await held } })
    await inside
    const other = await prisma.agentExecution.create({ data: { organizationId: seeded.organizationId, userId: seeded.userId, agentTaskId, agentType: 'CUSTOM', status: 'running', input: {}, trigger: { type: 'artifact', artifactId: artifact.id } } })
    await prisma.artifact.update({ where: { id: artifact.id, organizationId: seeded.organizationId }, data: { chat: pendingChat(other.id) } })
    release()
    await assert.rejects(first, /Wait for the current answer before sending another/)
    assert.equal(await prisma.agentExecution.count({ where: { organizationId: seeded.organizationId, agentTaskId } }), runsBefore + 1, 'only the send that landed has a run; the refused one rolled its own back')
    const row = await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId } })
    assert.deepEqual(row.chat.map((m: any) => m.executionId ?? m.content), ['first', other.id])
  })

  test('a send the dispatcher refuses leaves a failed run and no half-written conversation, so the next send is not blocked', async () => {
    const artifact = await freshArtifact('Refused dispatch')
    await assert.rejects(service.askArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, id: artifact.id, message: 'hello', mode: 'ask' }), /worker is disabled/)
    const run = await prisma.agentExecution.findFirstOrThrow({ where: { organizationId: seeded.organizationId, agentTaskId, trigger: { path: ['artifactId'], equals: artifact.id } } })
    assert.equal(run.status, 'failed')
    assert.equal((run.trigger as any).artifactMode, 'ask')
    const row = await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId } })
    assert.deepEqual(row.chat, [], 'the exchange that never started is not in the conversation')
    await assert.rejects(service.askArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, id: artifact.id, message: 'again', mode: 'ask' }), /worker is disabled/, 'refused by the dispatcher again, not by a stale pending message')
  })

  test('a conversation claimed for a flow run that never started is settled by the poll after the grace period', async () => {
    const artifact = await freshArtifact('Stale claim')
    const stale = new Date(Date.now() - 10 * 60_000).toISOString()
    const fresh = new Date().toISOString()
    await prisma.artifact.update({ where: { id: artifact.id, organizationId: seeded.organizationId }, data: { chat: [
      { role: 'user', mode: 'change', content: 'Re-run the flow.', createdAt: stale },
      { role: 'agent', mode: 'change', content: '', claimId: 'claim-old', status: 'pending', createdAt: stale },
    ] } })
    await service.artifactStatus(seeded.organizationId, artifact.id)
    let row = await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId } })
    assert.equal(row.chat[1].status, 'failed')
    assert.equal(row.chat[1].claimId, undefined)
    await prisma.artifact.update({ where: { id: artifact.id, organizationId: seeded.organizationId }, data: { chat: [
      { role: 'user', mode: 'change', content: 'Re-run the flow.', createdAt: fresh },
      { role: 'agent', mode: 'change', content: '', claimId: 'claim-new', status: 'pending', createdAt: fresh },
    ] } })
    await service.artifactStatus(seeded.organizationId, artifact.id)
    row = await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId } })
    assert.equal(row.chat[1].status, 'pending', 'a claim being filled in right now is left alone')
    await assert.rejects(service.askArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, id: artifact.id, message: 'x', mode: 'ask' }), /Wait for the current answer/)
  })
}
