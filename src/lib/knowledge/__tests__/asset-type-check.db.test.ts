import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { KnowledgeTextAssetInput } from '../ingest'

/**
 * knowledge_documents.assetType is a String in Prisma with a CHECK constraint
 * in the database (20260828120000, widened in 20260901140000 and
 * 20260929150000). The two drifted once — 'project' and 'synced_file' were
 * added to the code, the CHECK was not — and every GitHub sync and project
 * save 500'd in production (fixed in fb2d405d). This pins the database to
 * the code: one insert per value the ingest path can produce, so a CHECK that
 * narrows again, or a value added to the union without a migration, fails
 * here before it reaches anyone.
 */
type AssetType = NonNullable<KnowledgeTextAssetInput['assetType']>

// Every member of the union, as a Record so that adding one to the type
// without listing it here is a compile error — and listing it here without
// widening the CHECK is a failing insert.
const PRODUCED: Record<AssetType, true> = { file: true, pull_artifact: true, note: true, project: true, synced_file: true, dataset: true }
const ASSET_TYPES = Object.keys(PRODUCED) as AssetType[]

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('knowledge_documents.assetType CHECK matches the code (requires TEST_DATABASE_URL)', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let organizationId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    organizationId = (await prisma.organization.create({ data: { name: 'assetType check', slug: `asset-type-${Date.now()}` } })).id
  })

  after(async () => {
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined)
  })

  test('the database accepts every assetType the code can produce', async () => {
    for (const assetType of ASSET_TYPES) {
      await assert.doesNotReject(
        prisma.knowledgeDocument.create({ data: { organizationId, filename: `${assetType}.md`, mimeType: 'text/markdown', content: `# ${assetType}`, assetType } }),
        `assetType '${assetType}' is produced by src/lib/knowledge but the knowledge_documents_assetType_check constraint rejects it — widen the CHECK in a migration`,
      )
    }
    const stored = await prisma.knowledgeDocument.findMany({ where: { organizationId }, select: { assetType: true } })
    assert.deepEqual(stored.map((row: { assetType: string }) => row.assetType).sort(), [...ASSET_TYPES].sort())
  })

  test('the CHECK is still there: a value the code never produces is refused', async () => {
    await assert.rejects(
      prisma.knowledgeDocument.create({ data: { organizationId, filename: 'bogus.md', mimeType: 'text/markdown', assetType: 'bogus' } }),
      (error: unknown) => /assetType_check|check constraint|23514/i.test(String((error as Error).message)),
    )
  })
}
