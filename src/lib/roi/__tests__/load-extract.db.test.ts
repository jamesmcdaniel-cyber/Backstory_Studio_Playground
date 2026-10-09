import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Ingestion end to end against a real database: a flow step on the ROI plane
 * loads an extract, the Repository holds it tagged for the account, the ROI
 * page lists the account with that extract, and a run resolves it as its data.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('roi_load_extract on the ROI plane lands a tagged dataset the ROI page lists and a run resolves', async () => {
    const { RoiToolClient } = await import('../tools')
    const { listRoiSources, resolveRoiDatasetIds } = await import('../sources')
    const { loadRoiPageSetup } = await import('../page-setup')
    const { fetchRoiData } = await import('../data-source')
    const { DEFAULT_RUN_CONFIG } = await import('../config')
    const csv = readFileSync(path.join(process.cwd(), 'docs', 'roi-sample-extracts', 'activity.csv'), 'utf8')
    const client = new RoiToolClient(seeded.organizationId, seeded.userId)

    const loaded = await client.executeTool('', 'roi_load_extract', { account: 'QA Sample', kind: 'activity', csv }) as { documentId: string; rows: number; missingColumns: string[] }
    assert.ok(loaded.documentId)
    assert.equal(loaded.rows, 12 * 24)
    assert.deepEqual(loaded.missingColumns, [])

    const doc = await prisma.knowledgeDocument.findFirst({ where: { id: loaded.documentId, organizationId: seeded.organizationId } })
    assert.equal(doc.assetType, 'dataset')
    assert.equal(doc.status, 'ready')
    assert.equal(doc.sourceMetadata.roi.account, 'QA Sample')
    assert.equal(doc.sourceMetadata.roi.kind, 'activity')

    const sources = await listRoiSources(seeded.organizationId)
    const mine = sources.find((source) => source.account === 'QA Sample')
    assert.ok(mine, 'the account is listed from its tag')
    assert.equal(mine!.datasets.activity?.documentId, loaded.documentId)
    assert.ok(mine!.templates.includes('standard'))

    // Loading the same kind again wins over the first: newest per kind.
    const again = await client.executeTool('', 'roi_load_extract', { account: 'qa sample', kind: 'activity', rows: [{ email: 'x@sample.example', months: '2026-01-01', meeting_count: 1 }, { email: 'y@sample.example', months: '2026-01-01', meeting_count: 2 }] }) as { documentId: string }
    assert.deepEqual(await resolveRoiDatasetIds(seeded.organizationId, 'QA Sample'), [again.documentId])

    const setup = await loadRoiPageSetup({ organizationId: seeded.organizationId, userId: seeded.userId, role: 'ADMIN', canWriteAgents: true })
    const account = setup.accounts.find((entry) => entry.account.toLowerCase() === 'qa sample')
    assert.ok(account, 'the ROI page lists the account')
    assert.deepEqual(account!.extracts, ['activity'])
    assert.deepEqual(account!.covers, ['Activity trends'])
    assert.equal(account!.canRefresh, true)

    const data = await fetchRoiData({ organizationId: seeded.organizationId, userId: seeded.userId, analysisId: 'a1', account: 'QA Sample', reason: 'qa', config: DEFAULT_RUN_CONFIG, template: 'standard', dataFlowId: null })
    assert.deepEqual(data, { kind: 'ready', datasetIds: [again.documentId] })

    // Nothing was loaded, nothing is tagged: a bad file fails the step outright.
    await assert.rejects(client.executeTool('', 'roi_load_extract', { account: 'QA Sample', kind: 'usage', csv: '<html>' }), /not a CSV/)
    assert.equal((await listRoiSources(seeded.organizationId)).find((source) => source.account === 'QA Sample')!.datasets.usage, undefined)
  })
}
