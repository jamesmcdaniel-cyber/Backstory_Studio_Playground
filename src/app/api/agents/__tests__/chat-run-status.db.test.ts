import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * The regression this guards: a chat-started run in queue mode stored
 * `run.status: 'pending'` on the assistant message and nothing ever rewrote
 * it, so the thread's badge read "— running" forever. The thread now reads
 * each run's live status from its execution row, scoped to the workspace.
 */

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let chatRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    chatRoute = await import('../[id]/chat/route')
  })

  const mkAgent = (organizationId: string, userId: string) =>
    prisma.agentTask.create({
      data: {
        type: 'agent',
        agentType: 'CUSTOM',
        priority: 'HIGH',
        description: 'Chat run status',
        objective: 'Do the thing',
        context: {},
        status: 'ACTIVE',
        visibility: 'shared',
        organizationId,
        userId,
        metadata: { title: 'Chat run status' },
      },
    })

  const mkExecution = (organizationId: string, userId: string, agentTaskId: string, status: string) =>
    prisma.agentExecution.create({
      data: { agentType: 'CUSTOM', agentTaskId, status, input: { prompt: 'x' }, trigger: { type: 'manual', source: 'assistant' }, userId, organizationId },
    })

  test('a queued run’s badge follows its execution, not the reply-time snapshot', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const agent = await mkAgent(s.organizationId, s.userId)
      const finished = await mkExecution(s.organizationId, s.userId, agent.id, 'completed')
      const session = await prisma.agentChatSession.create({
        data: { agentTaskId: agent.id, organizationId: s.organizationId, userId: s.userId, title: 'Run it' },
      })
      const message = (executionId: string) =>
        prisma.agentChatMessage.create({
          data: {
            agentTaskId: agent.id,
            organizationId: s.organizationId,
            userId: s.userId,
            sessionId: session.id,
            role: 'assistant',
            content: 'Running the agent.',
            metadata: { run: { task: 'Do the thing', executionId, status: 'pending' } },
          },
        })
      await message(finished.id)
      // An execution id that is not this workspace's must not leak its status.
      const other = await seedTestOrg(prisma)
      const foreignAgent = await mkAgent(other.organizationId, other.userId)
      const foreign = await mkExecution(other.organizationId, other.userId, foreignAgent.id, 'failed')
      await message(foreign.id)

      const response = await chatRoute.GET(
        new NextRequest(new URL(`http://test/api/agents/${agent.id}/chat?sessionId=${session.id}`)),
      )
      const body = await response.json()
      assert.ok(body.success)
      const byExecution = new Map(body.messages.map((m: any) => [m.run?.executionId, m.run]))
      assert.equal((byExecution.get(finished.id) as any).status, 'completed')
      assert.equal((byExecution.get(finished.id) as any).task, 'Do the thing', 'the rest of the run metadata is kept')
      assert.equal((byExecution.get(foreign.id) as any).status, 'pending', 'another workspace’s row is never read')
      await other.cleanup()
    } finally {
      await s.cleanup()
    }
  })
}
