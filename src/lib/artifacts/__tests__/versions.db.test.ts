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

  test('a run about an ROI dashboard, or an ROI analysis run, never creates a second artifact', async () => {
    const before = await prisma.artifact.count({ where: { organizationId: seeded.organizationId } })
    const { artifact } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'roi_dashboard', title: 'ROI analysis · Acme', content: '<html><body><h1>Acme</h1></body></html>' })
    const longAnswer = `# Win rate by region\n\n${'Engaged deals win more often. '.repeat(80)}\n\n## Why\n\n${'The data says so. '.repeat(40)}`
    const html = '<!DOCTYPE html><html><head><title>A new dashboard</title></head><body><h1>Acme</h1><script>1</script></body></html>'
    // The assistant answering a question at length about the dashboard.
    const asked = await service.registerVersionFromExecution({ organizationId: seeded.organizationId, userId: seeded.userId, executionId: `exec-ask-${Date.now()}`, agentTaskId: 'agent', agentTitle: 'ROI Analyst', trigger: { type: 'artifact', artifactId: artifact.id, artifactMode: 'ask' }, summary: longAnswer })
    assert.equal(asked, null)
    // The analyst writing an HTML page instead of its narrative.
    const analysed = await service.registerVersionFromExecution({ organizationId: seeded.organizationId, userId: seeded.userId, executionId: `exec-roi-${Date.now()}`, agentTaskId: 'agent', agentTitle: 'ROI Analyst', trigger: { type: 'roi_analysis', analysisId: 'a1', link: '/roi?account=Acme' }, summary: html })
    assert.equal(analysed, null)
    assert.equal(await prisma.artifact.count({ where: { organizationId: seeded.organizationId } }), before + 1)
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

  test('late agent and flow results cannot replace the version they did not read', async () => {
    const { ArtifactToolClient } = await import('../tools')
    const { artifact, version } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'page', title: 'Stale result guard', content: '<html><body>Initial</body></html>' })
    const next = await service.addVersion({ organizationId: seeded.organizationId, artifactId: artifact.id, content: '<html><body>Newer</body></html>' })
    await assert.rejects(service.registerVersionFromFlowRun({ organizationId: seeded.organizationId, flowRunId: 'stale-test-flow', trigger: { artifactId: artifact.id, artifactBaseVersionId: version.id }, output: '<html><body>Stale flow</body></html>' }), /changed while editing/)
    const tools = new ArtifactToolClient(seeded.organizationId, seeded.userId, { artifactId: artifact.id, executionId: 'stale-test-agent', request: null, expectedVersionId: version.id })
    const result = await tools.executeTool('', 'revise_artifact', { content: '<html><body>Stale agent</body></html>', summary: 'stale' }) as { error: string }
    assert.match(result.error, /changed since this request started/)
    assert.equal((await service.loadArtifact(seeded.organizationId, artifact.id))?.currentVersionId, next.id)
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

  test('saving application data leaves the artifact\'s updatedAt alone — it is the key the conversation writes compare-and-swap on', async () => {
    const { writeAppState } = await import('../app-state')
    const { artifact, version } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'page', title: 'State vs chat', content: '<html><body>State</body></html>' })
    const scope = { organizationId: seeded.organizationId, userId: seeded.userId, artifactId: artifact.id, key: 'board' }
    const before = (await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId }, select: { updatedAt: true } })).updatedAt
    await writeAppState(scope, 0, { cards: 1 }, version.id)
    await writeAppState(scope, 1, { cards: 2 }, version.id)
    const after = (await prisma.artifact.findFirstOrThrow({ where: { id: artifact.id, organizationId: seeded.organizationId }, select: { updatedAt: true } })).updatedAt
    assert.equal(after.getTime(), before.getTime())
    // The row lock still refuses a frame holding a version that is not current, and an archived artifact.
    await assert.rejects(writeAppState(scope, 2, { cards: 3 }, 'not-the-current-version'), /version changed/)
    await service.archiveArtifact(seeded.organizationId, artifact.id, true)
    await assert.rejects(writeAppState(scope, 2, { cards: 3 }, version.id), /version changed/)
  })

  test('restoring a version does not send content that already passed the browser preflight back to the validator', async () => {
    const keys = ['ARTIFACT_VALIDATOR_URL', 'ARTIFACT_VALIDATOR_TOKEN', 'ARTIFACT_RUNTIME_PREFLIGHT'] as const
    const saved = keys.map((key) => process.env[key])
    for (const key of keys) delete process.env[key]
    const scripted = (n: number) => `<!doctype html><html><body><h1>v${n}</h1><script>document.title = "v${n}"</script></body></html>`
    try {
      const { artifact, version: first } = await service.createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'page', title: 'Restore vs validator', content: scripted(1) })
      await service.addVersion({ organizationId: seeded.organizationId, artifactId: artifact.id, content: scripted(2) })
      // The validator is now required but not reachable: a new scripted save
      // is refused as a validator outage, never as a content failure...
      process.env.ARTIFACT_RUNTIME_PREFLIGHT = 'required'
      await assert.rejects(service.addVersion({ organizationId: seeded.organizationId, artifactId: artifact.id, content: scripted(3) }), /validator is unavailable/)
      // ...while going back to a version that passed when it was saved still works.
      const restored = await service.restoreVersion({ organizationId: seeded.organizationId, userId: seeded.userId, artifactId: artifact.id, versionId: first.id })
      assert.equal(restored.number, 3)
      assert.equal(restored.request, 'Restored version 1')
      assert.equal((await service.loadArtifact(seeded.organizationId, artifact.id))?.currentVersionId, restored.id)
    } finally {
      keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
    }
  })
}
