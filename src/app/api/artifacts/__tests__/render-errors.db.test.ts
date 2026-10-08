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
  let resolvePermissions: any
  let route: any
  let ArtifactToolClient: any
  let readStoredFile: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    ;({ resolvePermissions } = await import('@/lib/authz/permissions'))
    ;({ ArtifactToolClient } = await import('@/lib/artifacts/tools'))
    ;({ readStoredFile } = await import('@/lib/files/storage'))
    route = await import('../[id]/render-errors/route')
  })

  const req = (path: string, method = 'GET', body?: unknown) =>
    new NextRequest(new URL(`http://test${path}`), { method, ...(body ? { body: JSON.stringify(body) } : {}) })

  /** A second person in the same workspace, with their own role. */
  async function member(prismaClient: any, owner: any, role: 'USER' | 'VIEWER') {
    const user = await prismaClient.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `${role.toLowerCase()}-${crypto.randomUUID()}@example.test`, name: role, role, organizationId: owner.organizationId },
    })
    const permissions = resolvePermissions({ role: user.role, platformRole: user.platformRole }, { kind: 'customer' })
    return { ...owner.auth, dbUser: user, userId: user.supabaseId, permissions, can: (p: string) => permissions.has(p) }
  }

  async function pageWithVersions(s: any, count: number) {
    const artifact = await prisma.artifact.create({ data: { organizationId: s.organizationId, userId: s.userId, title: 'Cockpit', kind: 'page' } })
    const versions = []
    for (let number = 1; number <= count; number++) {
      versions.push(await prisma.artifactVersion.create({ data: { organizationId: s.organizationId, artifactId: artifact.id, number, content: `<!doctype html><html><body><h1>Cockpit ${number}</h1><script>1</script></body></html>` } }))
    }
    await prisma.artifact.update({ where: { id: artifact.id, organizationId: s.organizationId }, data: { currentVersionId: versions.at(-1).id, versionCount: count } })
    return { artifact, versions }
  }

  test('render errors: an editor records the latest report per version, readers see it, the assistant is told', async () => {
    const s = await seedTestOrg(prisma, { role: 'USER' })
    try {
      const { artifact, versions: [v1, v2] } = await pageWithVersions(s, 2)
      const path = `/api/artifacts/${artifact.id}/render-errors`
      installTestAuth(s.auth)
      assert.equal((await route.PUT(req(path, 'PUT', { versionId: v2.id, errors: [{ message: 'boom', stack: 'at render', count: 2 }] }))).status, 200)
      // A later report replaces the earlier one: one row per artifact + version.
      assert.equal((await route.PUT(req(path, 'PUT', { versionId: v2.id, errors: [{ message: 'later' }] }))).status, 200)
      const rows = await prisma.artifactRenderError.findMany({ where: { organizationId: s.organizationId, artifactId: artifact.id } })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].errors[0].message, 'later')
      assert.equal(rows[0].userId, s.auth.dbUser.id)

      const seen = await (await route.GET(req(`${path}?versionId=${v2.id}`))).json()
      assert.equal(seen.report.versionId, v2.id)
      assert.deepEqual(seen.report.errors, [{ message: 'later' }])
      assert.equal((await (await route.GET(req(`${path}?versionId=${v1.id}`))).json()).report, null, 'nothing recorded for the earlier version')
      assert.equal((await route.GET(req(path))).status, 400, 'a version is required')

      // The assistant sees the current version's errors from get_artifact.
      const tools = new ArtifactToolClient(s.organizationId, s.userId, { artifactId: artifact.id, executionId: 'render-errors-qa', request: null })
      const got = await tools.executeTool('', 'get_artifact', {})
      assert.equal(got.renderErrors.errors[0].message, 'later', JSON.stringify(got.renderErrors))
      assert.match(got.renderErrors.note, /Fix these first/)

      // A version that is not this artifact's records nothing.
      const { versions: [foreign] } = await pageWithVersions(s, 1)
      assert.equal((await route.PUT(req(path, 'PUT', { versionId: foreign.id, errors: [{ message: 'elsewhere' }] }))).status, 200)
      assert.equal(await prisma.artifactRenderError.count({ where: { organizationId: s.organizationId, versionId: foreign.id } }), 0)

      // Bounded and shaped: an empty message or more than 20 errors is refused.
      assert.equal((await route.PUT(req(path, 'PUT', { versionId: v2.id, errors: [{ message: '' }] }))).status, 400)
      assert.equal((await route.PUT(req(path, 'PUT', { versionId: v2.id, errors: Array.from({ length: 21 }, () => ({ message: 'm' })) }))).status, 400)

      // An empty report clears the version's errors, and get_artifact stops mentioning them.
      assert.equal((await route.PUT(req(path, 'PUT', { versionId: v2.id, errors: [] }))).status, 200)
      assert.equal((await (await route.GET(req(`${path}?versionId=${v2.id}`))).json()).report, null)
      assert.equal('renderErrors' in await tools.executeTool('', 'get_artifact', {}), false)

      // A viewer reads the report but cannot record one.
      assert.equal((await route.PUT(req(path, 'PUT', { versionId: v2.id, errors: [{ message: 'again' }] }))).status, 200)
      installTestAuth(await member(prisma, s, 'VIEWER'))
      assert.equal((await route.GET(req(`${path}?versionId=${v2.id}`))).status, 200)
      assert.equal((await route.PUT(req(path, 'PUT', { versionId: v2.id, errors: [{ message: 'viewer' }] }))).status, 403)
      assert.equal((await prisma.artifactRenderError.findFirst({ where: { organizationId: s.organizationId, artifactId: artifact.id, versionId: v2.id } })).errors[0].message, 'again')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('view_artifact_screenshot stores the validator picture as a workspace file and points the assistant at it', async () => {
    const keys = ['ARTIFACT_VALIDATOR_URL', 'ARTIFACT_VALIDATOR_TOKEN', 'ARTIFACT_RUNTIME_PREFLIGHT'] as const
    const saved = keys.map((key) => process.env[key])
    const originalFetch = globalThis.fetch
    const s = await seedTestOrg(prisma, { role: 'USER' })
    try {
      delete process.env.ARTIFACT_RUNTIME_PREFLIGHT
      process.env.ARTIFACT_VALIDATOR_URL = 'https://validator.example'
      process.env.ARTIFACT_VALIDATOR_TOKEN = 'unit-test-token'
      // A real 1×1 PNG: stored files are typed by their bytes, so a stand-in string would be text.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      globalThis.fetch = async () => Response.json({ ok: true, checks: ['startup'], screenshot: png })
      const { artifact, versions: [version] } = await pageWithVersions(s, 1)
      const tools = new ArtifactToolClient(s.organizationId, s.userId, { artifactId: artifact.id, executionId: 'screenshot-qa', request: null })
      const result = await tools.executeTool('', 'view_artifact_screenshot', {})
      assert.ok(result.fileId, JSON.stringify(result))
      assert.equal(result.url, `/api/files/${result.fileId}`)
      assert.equal(result.version, version.number)
      assert.deepEqual([result.width, result.height], [1280, 800])
      assert.ok(result.dataUrl.startsWith('data:image/png;base64,'), 'a small picture travels inline as a data URL')
      assert.match(result.note, /text only/)
      const stored = await readStoredFile(result.fileId, s.organizationId)
      assert.equal(stored.mimeType, 'image/png')
      assert.equal(stored.buffer.toString('base64'), png)

      // A Markdown document has no page to picture.
      const doc = await prisma.artifact.create({ data: { organizationId: s.organizationId, userId: s.userId, title: 'Notes', kind: 'document' } })
      const md = await prisma.artifactVersion.create({ data: { organizationId: s.organizationId, artifactId: doc.id, number: 1, content: '# Notes\n\nPlain text.' } })
      await prisma.artifact.update({ where: { id: doc.id, organizationId: s.organizationId }, data: { currentVersionId: md.id, versionCount: 1 } })
      const none = await new ArtifactToolClient(s.organizationId, s.userId, { artifactId: doc.id, executionId: 'screenshot-md', request: null }).executeTool('', 'view_artifact_screenshot', {})
      assert.match(none.error, /Markdown/)
    } finally {
      globalThis.fetch = originalFetch
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })
}
