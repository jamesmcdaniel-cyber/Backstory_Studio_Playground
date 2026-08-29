import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let ensureDataTable: typeof import('../service').ensureDataTable
  let DataTableToolClient: typeof import('../tools').DataTableToolClient

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const authHelpers = await import('@/lib/server/__tests__/test-auth')
    seeded = await authHelpers.seedTestOrg(prisma)
    authHelpers.installTestAuth(seeded.auth)
    ;({ ensureDataTable } = await import('../service'))
    ;({ DataTableToolClient } = await import('../tools'))
  })

  after(async () => {
    await prisma.dataTable.deleteMany({ where: { organizationId: seeded.organizationId } })
  })

  const columns = [
    { name: 'email', label: 'Email', type: 'string', required: true },
    { name: 'active', label: 'Active', type: 'boolean' },
  ]

  test('the second run of a scheduled agent reuses the roster the first one made', async () => {
    const first = await ensureDataTable({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      name: 'Digest Subscribers',
      description: 'People who receive the daily digest.',
      columns,
    })
    assert.equal(first.created, true)

    const second = await ensureDataTable({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      name: 'Digest Subscribers',
      columns,
    })
    // The whole point: day two must not throw P2002 and must not fork a
    // second roster the humans never see.
    assert.equal(second.created, false)
    assert.equal(second.table.id, first.table.id)
    assert.equal(await prisma.dataTable.count({ where: { organizationId: seeded.organizationId } }), 1)
  })

  test('a case-variant name resolves to the same table reads would find', async () => {
    const lower = await ensureDataTable({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      name: 'digest subscribers',
    })
    // The unique index is case-sensitive but every read resolves by name
    // case-insensitively, so creating the variant would leave two tables that
    // a read by name picks between arbitrarily.
    assert.equal(lower.created, false)
    assert.equal(await prisma.dataTable.count({ where: { organizationId: seeded.organizationId } }), 1)
  })

  test('an existing table keeps its schema — a drifting run cannot rewrite it', async () => {
    const before_ = await prisma.dataTable.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, name: 'Digest Subscribers' },
    })
    await ensureDataTable({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      name: 'Digest Subscribers',
      description: 'Rewritten by a later run.',
      columns: [{ name: 'totally_different', type: 'number' }],
    })
    const after_ = await prisma.dataTable.findFirstOrThrow({
      where: { id: before_.id, organizationId: seeded.organizationId },
    })
    assert.deepEqual(after_.columns, before_.columns)
    assert.equal(after_.description, before_.description)
  })

  test('the agent tool provisions a table and then reads and writes it end to end', async () => {
    const client = new DataTableToolClient(seeded.organizationId, seeded.userId)
    const created = (await client.executeTool('', 'data_table_create_table', {
      name: 'Watch List',
      description: 'Accounts to monitor.',
      columns: [{ name: 'account', type: 'string', required: true }],
    })) as { created: boolean; table: { id: string; name: string } }
    assert.equal(created.created, true)
    assert.equal(created.table.name, 'Watch List')

    await client.executeTool('', 'data_table_insert_row', {
      tableName: 'Watch List',
      data: { account: 'Acme' },
    })
    const rows = (await client.executeTool('', 'data_table_get_rows', { tableName: 'Watch List' })) as {
      rows: Array<{ data: Record<string, unknown> }>
    }
    assert.deepEqual(rows.rows.map((row) => row.data.account), ['Acme'])
  })

  test('the per-workspace table cap stops a looping run from filling the workspace', async () => {
    const { MAX_DATA_TABLES_PER_ORG } = await import('../service')
    await prisma.dataTable.createMany({
      data: Array.from({ length: MAX_DATA_TABLES_PER_ORG }, (_, index) => ({
        organizationId: seeded.organizationId,
        name: `Filler ${index}`,
      })),
      skipDuplicates: true,
    })
    await assert.rejects(
      () => ensureDataTable({ organizationId: seeded.organizationId, userId: seeded.userId, name: 'One Too Many' }),
      /maximum of \d+ data tables/,
    )
    // An EXISTING table still resolves past the cap: the cap bounds creation,
    // and refusing to hand back a roster that is already there would break
    // every scheduled run the moment the workspace filled up.
    const existing = await ensureDataTable({ organizationId: seeded.organizationId, name: 'Watch List' })
    assert.equal(existing.created, false)
  })
}
