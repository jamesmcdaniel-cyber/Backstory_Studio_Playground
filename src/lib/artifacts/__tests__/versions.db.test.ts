import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The version-save path against a real database, through the tenant-guarded
 * client — the path the artifact assistant's tools take. A production check
 * found this path querying versions without organizationId; the guard only
 * fires with a database, so this is where it has to be pinned.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
  let service: typeof import('../service')

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    service = await import('../service')
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('versions from one run: the first carries the run id, a second still saves', async () => {
    const { artifact } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'report', title: 'Q3 review', content: '<html><body><h1>v1</h1></body></html>' })
    const executionId = `exec-${Date.now()}`
    const two = await service.addVersion({ artifactId: artifact.id, organizationId: seeded.organizationId, content: '<html><body><h1>v2</h1></body></html>', executionId, request: 'first edit' })
    const three = await service.addVersion({ artifactId: artifact.id, organizationId: seeded.organizationId, content: '<html><body><h1>v3</h1></body></html>', executionId, request: 'second edit' })
    assert.equal(two.number, 2)
    assert.equal(two.executionId, executionId)
    assert.equal(three.number, 3)
    assert.equal(three.executionId, null)
    const view = await service.loadArtifact(seeded.organizationId, artifact.id)
    assert.equal(view?.currentVersionId, three.id)
    assert.equal(view?.versionCount, 3)
  })

  test('concurrent saves serialize and invalid or stale edits cannot change current', async () => {
    const { artifact, version } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'page', title: 'Concurrency', content: '<html><body>One</body></html>' })
    const versions = await Promise.all([1, 2, 3].map(n => service.addVersion({ artifactId: artifact.id, organizationId: seeded.organizationId, content: `<html><body>${n}</body></html>` })))
    assert.deepEqual(versions.map(v => v.number).sort(), [2, 3, 4])
    const before = await service.loadArtifact(seeded.organizationId, artifact.id)
    await assert.rejects(service.addVersion({ artifactId: artifact.id, organizationId: seeded.organizationId, content: '<script>const = ;</script>' }), /failed validation/)
    await assert.rejects(service.addVersion({ artifactId: artifact.id, organizationId: seeded.organizationId, content: '<html><body>Stale</body></html>', expectedVersionId: version.id }), /changed while editing/)
    const after = await service.loadArtifact(seeded.organizationId, artifact.id)
    assert.equal(after?.currentVersionId, before?.currentVersionId)
    assert.equal(after?.versionCount, 4)
  })

  test('application data survives source revisions, is private, and rejects stale writes', async () => {
    const { readAppState, writeAppState } = await import('../app-state')
    const { artifact, version } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'page', title: 'State', content: '<html><body>State</body></html>' })
    const scope = { organizationId: seeded.organizationId, userId: seeded.userId, artifactId: artifact.id, key: 'records-v1' }
    assert.deepEqual(await writeAppState(scope, 0, { total: 7 }, version.id), { revision: 1 })
    assert.deepEqual(await readAppState(scope), { value: { total: 7 }, revision: 1 })
    assert.equal((await readAppState({ ...scope, userId: 'another-user' })).revision, 0)
    await assert.rejects(writeAppState(scope, 0, {}, version.id), /another tab/)
    const next = await service.addVersion({ organizationId: seeded.organizationId, artifactId: artifact.id, content: '<html><body>Version two</body></html>' })
    assert.deepEqual((await readAppState(scope)).value, { total: 7 })
    await assert.rejects(writeAppState(scope, 1, {}, version.id), /version changed/)
    await writeAppState(scope, 1, null, next.id)
    assert.deepEqual(await readAppState(scope), { value: null, revision: 2 })
    await assert.rejects(writeAppState(scope, 2, 'x'.repeat(256001), next.id), /256 KB/)
  })

  test('restoring makes an old version current as a new version, state included, history kept', async () => {
    const state = { roi: { note: 'the state behind v1' } }
    const { artifact, version: first } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'report', title: 'Plan', content: '<html><body><h1>one</h1></body></html>', state })
    await service.addVersion({ artifactId: artifact.id, organizationId: seeded.organizationId, content: '<html><body><h1>two</h1></body></html>', request: 'rewrite' })
    const restored = await service.restoreVersion({ organizationId: seeded.organizationId, userId: seeded.userId, artifactId: artifact.id, versionId: first.id })
    assert.equal(restored.number, 3)
    assert.equal(restored.request, 'Restored version 1')
    assert.match(restored.content, /one/)
    assert.deepEqual(restored.state, state)
    const view = await service.loadArtifact(seeded.organizationId, artifact.id)
    assert.equal(view?.versions.length, 3)
    assert.equal(view?.versions[0].source, 'restore')
    await assert.rejects(service.restoreVersion({ organizationId: seeded.organizationId, userId: seeded.userId, artifactId: artifact.id, versionId: restored.id }), /already the current one/)
  })

  test('another workspace cannot restore or read these versions', async () => {
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const other = await seedTestOrg(prisma)
    try {
      const { artifact, version } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'report', title: 'Private', content: '<html><body>secret</body></html>' })
      assert.equal(await service.loadArtifact(other.organizationId, artifact.id), null)
      assert.equal(await service.versionContent(other.organizationId, artifact.id, version.id), null)
      await assert.rejects(service.restoreVersion({ organizationId: other.organizationId, userId: other.userId, artifactId: artifact.id, versionId: version.id }), /not found/)
    } finally {
      await other.cleanup()
    }
  })
}
