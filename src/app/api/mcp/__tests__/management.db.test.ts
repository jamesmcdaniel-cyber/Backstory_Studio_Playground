import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let apiKey: string
  let POST: (request: Request) => Promise<Response>

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const [{ seedTestOrg }, { hashToken }, route] = await Promise.all([
      import('@/lib/server/__tests__/test-auth'),
      import('@/lib/crypto/secrets'),
      import('../route'),
    ])
    POST = route.POST
    seeded = await seedTestOrg(prisma)
    apiKey = `bsk_${randomBytes(32).toString('hex')}`
    await prisma.apiKey.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        name: 'MCP management test',
        keyHash: hashToken(apiKey),
        prefix: apiKey.slice(0, 12),
        scopes: ['flows:read', 'flows:write', 'flows:run'],
      },
    })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  async function call(name: string, args: Record<string, unknown>) {
    const response = await POST(new Request('http://test/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }))
    assert.equal(response.status, 200)
    const rpc = await response.json() as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean }
      error?: unknown
    }
    assert.equal(rpc.error, undefined)
    const text = rpc.result?.content?.[0]?.text ?? ''
    let value: unknown = text
    try { value = JSON.parse(text) } catch { /* plain-text tool errors are valid */ }
    return { value, isError: rpc.result?.isError === true }
  }

  test('MCP folder management matches the canonical shared-agent semantics', async () => {
    const created = await call('create_folder', { name: 'Revenue Ops' })
    assert.equal(created.isError, false)
    const folderId = (created.value as { id: string }).id

    const [shared, privateAgent] = await Promise.all([
      prisma.agentTask.create({
        data: {
          organizationId: seeded.organizationId,
          userId: seeded.userId,
          description: 'Shared agent',
          objective: 'Test folder rename',
          folder: 'Revenue Ops',
          visibility: 'shared',
        },
      }),
      prisma.agentTask.create({
        data: {
          organizationId: seeded.organizationId,
          userId: seeded.userId,
          description: 'Private agent',
          objective: 'Keep private assignment',
          folder: 'Revenue Ops',
          visibility: 'private',
        },
      }),
    ])

    const renamed = await call('rename_folder', { folderId, name: 'Revenue Systems' })
    assert.equal(renamed.isError, false)
    const afterRename = await prisma.agentTask.findMany({
      where: { organizationId: seeded.organizationId, id: { in: [shared.id, privateAgent.id] } },
      orderBy: { description: 'asc' },
      select: { id: true, folder: true },
    })
    assert.equal(afterRename.find((row: { id: string }) => row.id === shared.id)?.folder, 'Revenue Systems')
    assert.equal(afterRename.find((row: { id: string }) => row.id === privateAgent.id)?.folder, 'Revenue Ops')

    const deleted = await call('delete_folder', { folderId })
    assert.deepEqual(deleted.value, { deleted: true, moved: 1 })
    const afterDelete = await prisma.agentTask.findMany({
      where: { organizationId: seeded.organizationId, id: { in: [shared.id, privateAgent.id] } },
      select: { id: true, folder: true },
    })
    assert.equal(afterDelete.find((row: { id: string }) => row.id === shared.id)?.folder, null)
    assert.equal(afterDelete.find((row: { id: string }) => row.id === privateAgent.id)?.folder, 'Revenue Ops')
  })

  test('MCP can create, version-update, and confirmation-delete a data table', async () => {
    const created = await call('create_data_table', {
      name: 'Accounts',
      columns: [{ name: 'name', type: 'string', required: true }],
    })
    assert.equal(created.isError, false)
    const tableId = (created.value as { id: string }).id

    const updated = await call('update_data_table', {
      tableId,
      name: 'Accounts v2',
      expectedVersion: 1,
      columns: [
        { name: 'name', type: 'string', required: true },
        { name: 'tier', type: 'number', required: false },
      ],
    })
    assert.equal(updated.isError, false)
    assert.equal((updated.value as { name: string }).name, 'Accounts v2')
    assert.equal((updated.value as { version: number }).version, 2)

    const refused = await call('delete_data_table', { tableId, confirmation: 'Accounts' })
    assert.equal(refused.isError, true)
    assert.ok(await prisma.dataTable.findFirst({ where: { id: tableId, organizationId: seeded.organizationId } }))

    const deleted = await call('delete_data_table', { tableId, confirmation: 'Accounts v2' })
    assert.deepEqual(deleted.value, { deleted: true, tableId })
    assert.equal(await prisma.dataTable.findFirst({ where: { id: tableId, organizationId: seeded.organizationId } }), null)
  })
}
