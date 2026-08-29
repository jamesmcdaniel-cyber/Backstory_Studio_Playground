import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY

  let prisma: any
  let seeded: any
  let agentId: string
  let ingestKnowledgeFile: typeof import('../ingest').ingestKnowledgeFile
  let ingestKnowledgeText: typeof import('../ingest').ingestKnowledgeText
  let listRepositoryAssets: typeof import('../repository').listRepositoryAssets
  let updateRepositoryAsset: typeof import('../repository').updateRepositoryAsset
  let deleteRepositoryAsset: typeof import('../repository').deleteRepositoryAsset
  let RepositoryAssetConflictError: typeof import('../repository').RepositoryAssetConflictError
  let retrieveKnowledge: typeof import('../retrieve').retrieveKnowledge
  let readStoredFile: typeof import('@/lib/files/storage').readStoredFile

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const authHelpers = await import('@/lib/server/__tests__/test-auth')
    seeded = await authHelpers.seedTestOrg(prisma)
    authHelpers.installTestAuth(seeded.auth)
    agentId = (await prisma.agentTask.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        description: 'Repository test agent',
        objective: 'Use governed repository content',
        status: 'ACTIVE',
      },
    })).id
    ;({ ingestKnowledgeFile, ingestKnowledgeText } = await import('../ingest'))
    ;({
      listRepositoryAssets,
      updateRepositoryAsset,
      deleteRepositoryAsset,
      RepositoryAssetConflictError,
    } = await import('../repository'))
    ;({ retrieveKnowledge } = await import('../retrieve'))
    ;({ readStoredFile } = await import('@/lib/files/storage'))
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('repository upload retains the original, re-indexes edits, and enforces the agent disable gate', async () => {
    const original = Buffer.from('Original acorn reference content.', 'utf8')
    const created = await ingestKnowledgeFile({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      agentId,
      filename: 'reference.md',
      mimeType: 'text/markdown',
      buffer: original,
      description: 'Lifecycle coverage',
    })

    const storedRow = await prisma.knowledgeDocument.findUnique({
      where: { id: created.id, organizationId: seeded.organizationId },
      select: { storedFileId: true, version: true },
    })
    assert.ok(storedRow?.storedFileId, 'upload should retain and link its original bytes')
    assert.equal(storedRow.version, 1)
    assert.deepEqual(
      (await readStoredFile(storedRow.storedFileId, seeded.organizationId))?.buffer,
      original,
    )

    const listed = await listRepositoryAssets({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
    })
    assert.ok(listed.assets.some((asset) => asset.id === created.id && asset.hasOriginal && asset.isEnabled))

    const second = await ingestKnowledgeText({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      agentId: null,
      filename: 'second-reference.md',
      mimeType: 'text/markdown',
      content: 'A second repository asset used to verify cursor pagination.',
    })
    await prisma.knowledgeDocument.update({
      where: { id: second.id, organizationId: seeded.organizationId },
      data: { status: 'processing', updatedAt: new Date(Date.now() - 20 * 60 * 1_000) },
    })
    const recovered = await updateRepositoryAsset({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      id: second.id,
      content: 'Recovered content after an abandoned indexing lease.',
      expectedVersion: 1,
    })
    assert.equal(recovered.status, 'ready')
    assert.equal(recovered.version, 2)
    const firstPage = await listRepositoryAssets({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      limit: 1,
    })
    assert.equal(firstPage.assets.length, 1)
    assert.ok(firstPage.nextCursor)
    assert.equal(firstPage.stats.total, 2)
    const secondPage = await listRepositoryAssets({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      limit: 1,
      cursor: firstPage.nextCursor!,
    })
    assert.equal(secondPage.assets.length, 1)
    assert.notEqual(secondPage.assets[0]?.id, firstPage.assets[0]?.id)

    const edited = await updateRepositoryAsset({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      id: created.id,
      filename: 'reference-v2.md',
      content: 'Edited-only cedar catalogue reference.',
      expectedVersion: 1,
    })
    assert.equal(edited.version, 2)
    assert.equal(edited.filename, 'reference-v2.md')
    assert.equal(
      (await readStoredFile(storedRow.storedFileId, seeded.organizationId))?.buffer.toString('utf8'),
      original.toString('utf8'),
      'editing indexed text must not overwrite the immutable original',
    )

    await assert.rejects(
      updateRepositoryAsset({
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        id: created.id,
        description: 'stale write',
        expectedVersion: 1,
      }),
      RepositoryAssetConflictError,
    )

    const beforeDisable = await retrieveKnowledge({
      organizationId: seeded.organizationId,
      agentId,
      query: 'cedar catalogue reference',
    })
    assert.ok(beforeDisable.some((hit) => hit.documentId === created.id))

    const disabled = await updateRepositoryAsset({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      id: created.id,
      isEnabled: false,
      expectedVersion: edited.version,
    })
    assert.equal(disabled.version, 3)
    assert.equal(disabled.isEnabled, false)
    assert.deepEqual(
      await retrieveKnowledge({
        organizationId: seeded.organizationId,
        agentId,
        query: 'cedar catalogue reference',
      }),
      [],
      'disabled repository content must not enter agent retrieval',
    )

    const enabled = await updateRepositoryAsset({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      id: created.id,
      isEnabled: true,
      expectedVersion: disabled.version,
    })
    assert.equal(enabled.version, 4)
    assert.ok((await retrieveKnowledge({
      organizationId: seeded.organizationId,
      agentId,
      query: 'cedar catalogue reference',
    })).some((hit) => hit.documentId === created.id))

    await deleteRepositoryAsset({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      id: second.id,
    })

    await deleteRepositoryAsset({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      id: created.id,
    })
    assert.equal(await prisma.knowledgeDocument.findUnique({
      where: { id: created.id, organizationId: seeded.organizationId },
    }), null)
    assert.equal(await readStoredFile(storedRow.storedFileId, seeded.organizationId), null)
  })
}
