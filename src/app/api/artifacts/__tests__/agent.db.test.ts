import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let listRoute: any
  let artifactRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    listRoute = await import('../route')
    artifactRoute = await import('../[id]/route')
  })

  const req = (path: string, method = 'GET', body?: unknown) =>
    new NextRequest(new URL(`http://test${path}`), { method, ...(body ? { body: JSON.stringify(body) } : {}) })

  test('every artifact gets an agent: made for an unassigned upload, created or attached later', async () => {
    const s = await seedTestOrg(prisma, { role: 'USER' })
    try {
      installTestAuth(s.auth)
      // An upload with no agent picked gets a background agent made for it.
      const uploaded = await (await listRoute.POST(req('/api/artifacts', 'POST', { content: '<!doctype html><html><head><title>Rep cockpit</title></head><body><script>1</script></body></html>', filename: 'cockpit.html' }))).json()
      assert.ok(uploaded.artifactId, JSON.stringify(uploaded))
      const artifact = await prisma.artifact.findFirst({ where: { id: uploaded.artifactId, organizationId: s.organizationId }, select: { agentTaskId: true } })
      const made = await prisma.agentTask.findFirst({ where: { id: artifact.agentTaskId, organizationId: s.organizationId } })
      assert.equal(made.metadata.templateId, 'builtin:artifact-editor')
      assert.match(made.metadata.title, /^Rep cockpit · editor$/)
      assert.equal(made.metadata.model, 'claude-opus-5-5')

      // An artifact with no agent (a flow's output, say): create one for it, or attach one.
      const bare = await prisma.artifact.create({ data: { organizationId: s.organizationId, userId: s.userId, title: 'Flow report', kind: 'report' } })
      const created = await (await artifactRoute.PATCH(req(`/api/artifacts/${bare.id}`, 'PATCH', { createAgent: true }))).json()
      assert.match(created.agent.title, /Flow report · editor/)
      const attached = await (await artifactRoute.PATCH(req(`/api/artifacts/${bare.id}`, 'PATCH', { agentId: made.id }))).json()
      assert.equal(attached.agent.id, made.id)
      assert.equal((await prisma.artifact.findFirst({ where: { id: bare.id, organizationId: s.organizationId } })).agentTaskId, made.id)
      assert.equal((await artifactRoute.PATCH(req(`/api/artifacts/${bare.id}`, 'PATCH', { agentId: 'not-an-agent' }))).status, 400)
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })
}
