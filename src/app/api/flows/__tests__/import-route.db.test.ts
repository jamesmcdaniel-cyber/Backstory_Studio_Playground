import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode).
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let route: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    route = await import('../import/route')
  })

  const post = (body: unknown) =>
    route.POST(new NextRequest(new URL('http://test/api/flows/import'), { method: 'POST', body: JSON.stringify(body) }))

  test('an n8n workflow JSON imports as a DRAFT flow with a converted graph and warnings', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const res = await post({
        name: 'From n8n',
        nodes: [
          { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: {} },
          { id: 'b', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 1, position: [200, 0], parameters: { channel: '#x' } },
        ],
        connections: { Webhook: { main: [[{ node: 'Notify', type: 'main', index: 0 }]] } },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.flow?.id)
      assert.ok(Array.isArray(body.warnings) && body.warnings.length > 0, 'the unconverted Slack step must be warned about')

      const flow = await prisma.flow.findFirst({ where: { id: body.flow.id, organizationId: s.organizationId } })
      assert.equal(flow.status, 'DRAFT')
      const graph = flow.graph as { nodes: { id: string; type: string }[] }
      assert.ok(graph.nodes.some((n) => n.type === 'trigger' && n.id === 'trigger'))
      assert.ok(
        graph.nodes.some(
          (n) => n.type === 'tool' && (n as { data?: { connectionId?: string } }).data?.connectionId === 'nango:slack',
        ),
        'the slack node binds to the platform Slack integration',
      )
      // The import report persists — the toast is a headline, not the only copy.
      const notes = flow.importNotes as {
        notes: { code: string; severity: string; message: string; nodeId?: string }[]
        blocking: number
      }
      assert.ok(notes && Array.isArray(notes.notes) && notes.notes.length > 0, 'import notes persist on the flow')
      assert.equal(typeof notes.blocking, 'number')
      // Typed, node-anchored notes survive the route — not flattened to IMPORT_NOTE.
      const toolNode = graph.nodes.find((n) => n.type === 'tool')!
      assert.ok(
        notes.notes.some((n) => n.nodeId === toolNode.id),
        `expected a note anchored to the imported tool step, got ${JSON.stringify(notes.notes)}`,
      )
      assert.equal(typeof body.blocking, 'number', 'the response carries the blocking count')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('warehouse nodes import onto their planes and agent HTTP tools become endpoints bound by host', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const { encryptSecret } = await import('@/lib/crypto/secrets')
      for (const [name, host] of [['Snowflake prod', 'acme-prod.snowflakecomputing.com'], ['CRM', 'crm.example.com']]) {
        await prisma.httpCredential.create({
          data: { organizationId: s.organizationId, userId: s.auth.dbUser.id, name, authType: 'bearer', allowedHost: host, secretConfig: encryptSecret(JSON.stringify({ token: 't' })), status: 'verified' },
        })
      }
      const res = await post({
        name: 'Warehouse',
        nodes: [
          { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
          { id: 'q', name: 'Accounts', type: 'n8n-nodes-base.snowflake', typeVersion: 1, position: [200, 0], parameters: { operation: 'executeQuery', query: 'SELECT 1' }, credentials: { snowflake: { id: '1', name: 'SF' } } },
          { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1, position: [400, 0], parameters: {} },
          { id: 'h', name: 'CRM lookup', type: '@n8n/n8n-nodes-langchain.toolHttpRequest', typeVersion: 1, position: [400, 200], parameters: { url: 'https://crm.example.com/accounts/{id}' } },
        ],
        connections: {
          Start: { main: [[{ node: 'Accounts', type: 'main', index: 0 }]] },
          Accounts: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
          'CRM lookup': { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
        },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      const flow = await prisma.flow.findFirst({ where: { id: body.flow.id, organizationId: s.organizationId } })
      const graph = flow.graph as { nodes: Array<{ type: string; data: Record<string, unknown> }> }
      assert.ok(graph.nodes.some((n) => n.type === 'tool' && n.data.connectionId === 'native:snowflake' && n.data.toolName === 'snowflake_sql_query'))
      const notes = (flow.importNotes as { notes: Array<{ code: string; message: string }> }).notes
      assert.ok(!notes.some((n) => n.code === 'WAREHOUSE_CREDENTIAL'), 'the saved Snowflake credential retires the save-a-credential note')
      assert.ok(notes.some((n) => /Snowflake steps run on your saved credential for acme-prod\.snowflakecomputing\.com/.test(n.message)))

      const agentId = (graph.nodes.find((n) => n.type === 'agent')!.data as { agentId: string }).agentId
      const agent = await prisma.agentTask.findFirst({ where: { id: agentId, organizationId: s.organizationId } })
      const metadata = agent.metadata as { integrations: string[]; httpEndpoints: Array<{ url: string; credentialId?: string }> }
      assert.ok(metadata.integrations.includes('HTTP API'))
      assert.equal(metadata.httpEndpoints[0].url, 'https://crm.example.com/accounts/{{id}}')
      const crm = await prisma.httpCredential.findFirst({ where: { organizationId: s.organizationId, allowedHost: 'crm.example.com' } })
      assert.equal(metadata.httpEndpoints[0].credentialId, crm.id)
    } finally {
      await prisma.agentTask.deleteMany({ where: { organizationId: s.organizationId } }).catch(() => {})
      await prisma.httpCredential.deleteMany({ where: { organizationId: s.organizationId } }).catch(() => {})
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('a native Backstory package still imports unchanged', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const res = await post({
        format: 'backstory.flow.v1',
        flow: {
          name: 'Native',
          graph: {
            nodes: [
              { id: 'trigger', type: 'trigger', data: {} },
              { id: 's1', type: 'transform', data: { fields: [{ name: 'a', value: 'b' }] } },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 's1' }],
          },
        },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.flow?.id)
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })
}
