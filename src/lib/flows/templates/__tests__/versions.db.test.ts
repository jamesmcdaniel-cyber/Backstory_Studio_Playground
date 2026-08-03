import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// DB-backed: edit-snapshots-restore lifecycle for flow-template versioning.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('edit snapshots the prior payload and bumps the version; restore is itself versioned', async () => {
    const { createFlowTemplate } = await import('@/lib/flows/templates/create')
    const { updateFlowTemplateVersioned, restoreFlowTemplateVersion } = await import('@/lib/flows/templates/versions')

    const graph = { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }], edges: [] }
    const created = await createFlowTemplate({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      name: 'V-test',
      description: 'first',
      category: 'Custom',
      graph: graph as never,
      notes: { objective: 'o', inputs: [], steps: [], setup: [], customize: [] },
      bindings: [],
    })
    assert.equal(created.version, 1)

    // Edit: description changes, v1 payload is preserved, version becomes 2.
    const v2 = await updateFlowTemplateVersioned(created, { description: 'second' }, seeded.userId)
    assert.equal(v2.version, 2)
    assert.equal(v2.description, 'second')
    const history = await prisma.flowTemplateVersion.findMany({ where: { templateId: created.id, organizationId: seeded.organizationId } })
    assert.equal(history.length, 1)
    assert.equal(history[0].version, 1)
    assert.equal((history[0].snapshot as { description: string }).description, 'first')

    // Restore v1: description returns to 'first', version moves FORWARD to 3,
    // and the pre-restore payload ('second') is itself kept as v2.
    const restored = await restoreFlowTemplateVersion(v2, 1, seeded.userId)
    assert.ok(restored)
    assert.equal(restored!.version, 3)
    assert.equal(restored!.description, 'first')
    const v2row = await prisma.flowTemplateVersion.findFirst({ where: { templateId: created.id, organizationId: seeded.organizationId, version: 2 } })
    assert.equal((v2row!.snapshot as { description: string }).description, 'second')

    // Unknown version → null, nothing written.
    assert.equal(await restoreFlowTemplateVersion(restored!, 99, seeded.userId), null)

    await prisma.flowTemplate.delete({ where: { id: created.id, organizationId: seeded.organizationId } })
  })
}
