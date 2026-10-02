import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The guest copilot: a public template link used with no account. Driven
 * through the public route (GET and POST), since that route is the only way
 * in — the same handlers a visitor's browser calls.
 */
const database = process.env.TEST_DATABASE_URL
if (!database) {
  test('guest copilot (requires TEST_DATABASE_URL)', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = database
  process.env.DIRECT_URL = database
  let db: typeof import('@/lib/prisma').prisma
  let host: Awaited<ReturnType<typeof import('@/lib/server/__tests__/test-auth').seedTestOrg>>
  let route: typeof import('@/app/api/share/artifacts/[token]/copilot/route')
  let contentRoute: typeof import('@/app/api/share/artifacts/[token]/copilot/content/route')
  let restoreExecution: () => void
  let sourceId: string
  let cookie = ''
  let copyId = ''
  const token = randomBytes(24).toString('base64url')
  const content = '<!doctype html><html><body><h1>Template original</h1></body></html>'
  const base = `https://qa.invalid/api/share/artifacts/${token}/copilot`

  const call = (method: 'GET' | 'POST', body?: unknown, withCookie = cookie, url = base) =>
    (method === 'GET' ? route.GET : route.POST)(new NextRequest(url, { method, headers: { 'content-type': 'application/json', ...(withCookie ? { cookie: `bs_guest=${withCookie}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }))

  before(async () => {
    const helpers = await import('@/app/api/__tests__/helpers/stub-execution')
    // Before any route import: runs stop at the queue dispatcher, not a model.
    restoreExecution = helpers.stubBackgroundExecution()
    ;({ prisma: db } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { hashToken } = await import('@/lib/crypto/secrets')
    route = await import('@/app/api/share/artifacts/[token]/copilot/route')
    contentRoute = await import('@/app/api/share/artifacts/[token]/copilot/content/route')
    host = await seedTestOrg(db)
    const source = await db.artifact.create({ data: {
      organizationId: host.organizationId, userId: host.userId, title: 'QA template', kind: 'page',
      shareAnonymous: true, shareTemplate: true, shareTokenDigest: hashToken(token),
      versions: { create: { organizationId: host.organizationId, number: 1, content } },
    }, include: { versions: true } })
    sourceId = source.id
    await db.artifact.update({ where: { id: sourceId, organizationId: host.organizationId }, data: { currentVersionId: source.versions[0].id, versionCount: 1 } })
  })
  after(async () => { restoreExecution?.(); await host?.cleanup(); await db?.$disconnect() })

  test('a visitor with no account opens the copilot: an ownerless copy in the sender’s workspace, opened by their cookie alone', async () => {
    assert.equal((await (await call('GET', undefined, '')).json()).copilot, null, 'looking never creates a copy')
    assert.equal(await db.artifact.count({ where: { organizationId: host.organizationId, templateSourceId: sourceId } }), 0)

    const opened = await call('POST', { action: 'open' }, '')
    assert.equal(opened.status, 200)
    const set = opened.headers.get('set-cookie') ?? ''
    assert.match(set, /bs_guest=[A-Za-z0-9_-]{43};/)
    assert.match(set, /HttpOnly/i)
    cookie = /bs_guest=([^;]+)/.exec(set)![1]
    const view = (await opened.json()).copilot
    copyId = view.copyId
    assert.deepEqual(view.chat, [])

    const copy = await db.artifact.findFirstOrThrow({ where: { id: copyId, organizationId: host.organizationId }, include: { versions: true } })
    assert.equal(copy.userId, null)
    assert.equal(copy.templateSourceId, sourceId)
    assert.ok(copy.guestDigest && copy.guestDigest !== cookie, 'only a digest of the visitor token is stored')
    assert.equal(copy.shareAnonymous, false)
    assert.equal(copy.versions[0].content, content)
    const agent = await db.agentTask.findFirstOrThrow({ where: { id: copy.agentTaskId!, organizationId: host.organizationId } })
    assert.equal(agent.artifactTemplateCopyId, copyId)
    assert.equal(agent.userId, host.userId, 'the copilot runs as the template’s owner')
    assert.equal(agent.visibility, 'private')

    assert.equal((await (await call('POST', { action: 'open' })).json()).copilot.copyId, copyId, 'the same visitor gets the same copy')
    assert.equal((await (await call('GET')).json()).copilot.copyId, copyId)
    const stranger = await call('POST', { action: 'open' }, '')
    assert.notEqual((await stranger.json()).copilot.copyId, copyId, 'another visitor never lands in this copy')
  })

  test('the copy is served by link + copy id, and is invisible to every signed-in surface', async () => {
    const version = await db.artifactVersion.findFirstOrThrow({ where: { artifactId: copyId, organizationId: host.organizationId } })
    const page = await contentRoute.GET(new NextRequest(`${base}/content?copy=${copyId}&v=${version.id}`))
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Template original/)
    assert.match(page.headers.get('content-security-policy') ?? '', /^sandbox/)
    assert.equal((await contentRoute.GET(new NextRequest(`${base}/content?copy=${crypto.randomUUID()}&v=${version.id}`))).status, 404)
    assert.equal((await contentRoute.GET(new NextRequest(`${base}/content?copy=${sourceId}&v=${version.id}`))).status, 404, 'the original is not a guest copy')

    const { listArtifacts, askArtifact } = await import('../service')
    const { requireReadable } = await import('../route-access')
    const { requireArtifactEdit } = await import('../sharing')
    assert.equal((await listArtifacts(host.organizationId, { userId: host.userId })).some(a => a.id === copyId), false)
    await assert.rejects(requireReadable(host.auth, copyId), /not found/)
    await assert.rejects(requireArtifactEdit(host.organizationId, copyId, { userId: host.userId, can: () => true }), /not change/)
    await assert.rejects(askArtifact({ organizationId: host.organizationId, userId: host.userId, id: copyId, message: 'hi', mode: 'auto' }), /not found/, 'even the host cannot talk to a visitor’s copy from the app')
    await assert.rejects(askArtifact({ organizationId: host.organizationId, userId: host.userId, id: copyId, message: 'hi', mode: 'auto', guestDigest: 'wrong' }), /not found/)
  })

  test('only the copy’s own copilot run can edit it; the original never changes', async () => {
    const { ArtifactToolClient } = await import('../tools')
    const outside = new ArtifactToolClient(host.organizationId, host.userId, { artifactId: copyId, executionId: 'guest-qa-outside', request: 'Update heading' })
    assert.match(((await outside.executeTool('', 'edit_artifact', { edits: [{ find: 'Template original', replace: 'Hijacked' }], summary: 'x' })) as { error?: string }).error ?? '', /not found/i)
    const copilot = new ArtifactToolClient(host.organizationId, host.userId, { artifactId: copyId, executionId: 'guest-qa-edit', request: 'Update heading', templateCopy: true })
    const result = await copilot.executeTool('', 'edit_artifact', { edits: [{ find: 'Template original', replace: 'Visitor version' }], summary: 'Heading' }) as { saved?: boolean; error?: string }
    assert.equal(result.saved, true, result.error)
    const source = await db.artifact.findFirstOrThrow({ where: { id: sourceId, organizationId: host.organizationId }, include: { versions: true } })
    assert.equal(source.versionCount, 1)
    assert.equal(source.versions[0].content, content)
    const view = (await (await call('GET')).json()).copilot
    const page = await contentRoute.GET(new NextRequest(`${base}/content?copy=${copyId}&v=${view.versionId}`))
    assert.match(await page.text(), /Visitor version/)
  })

  test('a message starts a run as the host, marked guest; it never spends the host’s own allowance and is capped per visitor', async () => {
    const asked = await call('POST', { action: 'ask', message: 'Make the heading blue' })
    // The stubbed dispatcher refuses the job; the visitor sees no internals.
    assert.equal(asked.status, 400)
    assert.equal((await asked.json()).error, 'The copilot is unavailable right now. Please try again.')
    const copy = await db.artifact.findFirstOrThrow({ where: { id: copyId, organizationId: host.organizationId } })
    const run = await db.agentExecution.findFirstOrThrow({ where: { organizationId: host.organizationId, agentTaskId: copy.agentTaskId! } })
    assert.equal(run.userId, host.userId)
    assert.deepEqual({ guest: (run.trigger as any).guest, template: (run.trigger as any).guestTemplateId, artifactId: (run.trigger as any).artifactId }, { guest: true, template: sourceId, artifactId: copyId })

    const { checkDailyRunAllowance } = await import('@/lib/usage/free-tier-limits')
    assert.equal((await checkDailyRunAllowance('agent', { organizationId: host.organizationId, userId: host.userId, canReview: false })).used, 0)

    const { GUEST_COPILOT_LIMITS } = await import('../template-policy')
    await db.agentExecution.createMany({ data: Array.from({ length: GUEST_COPILOT_LIMITS.messagesPerVisitor - 1 }, () => ({ organizationId: host.organizationId, userId: host.userId, agentTaskId: copy.agentTaskId!, agentType: 'CUSTOM', status: 'completed', input: {}, trigger: { type: 'artifact', artifactId: copyId, guest: true, guestTemplateId: sourceId } })) })
    const capped = await call('POST', { action: 'ask', message: 'One more' })
    assert.equal(capped.status, 429)
    assert.equal((await capped.json()).code, 'GUEST_LIMIT_REACHED')
    assert.equal((await call('POST', { action: 'ask', message: 'x' }, '')).status, 404, 'no cookie, no copy to talk to')
  })

  test('turning the offer off closes the copilot and the copy’s page for visitors', async () => {
    const view = (await (await call('GET')).json()).copilot
    await db.artifact.update({ where: { id: sourceId, organizationId: host.organizationId }, data: { shareTemplate: false } })
    assert.equal((await call('GET')).status, 404)
    assert.equal((await call('POST', { action: 'open' })).status, 404)
    assert.equal((await call('POST', { action: 'ask', message: 'still there?' })).status, 404)
    assert.equal((await contentRoute.GET(new NextRequest(`${base}/content?copy=${copyId}&v=${view.versionId}`))).status, 404)
  })

  test('a template whose owner is gone has nobody to host a guest: the visitor is asked to sign in', async () => {
    const { hashToken } = await import('@/lib/crypto/secrets')
    const orphanToken = randomBytes(24).toString('base64url')
    const orphan = await db.artifact.create({ data: {
      organizationId: host.organizationId, userId: null, title: 'Ownerless', kind: 'page', shareAnonymous: true, shareTemplate: true, shareTokenDigest: hashToken(orphanToken),
      versions: { create: { organizationId: host.organizationId, number: 1, content } },
    }, include: { versions: true } })
    await db.artifact.update({ where: { id: orphan.id, organizationId: host.organizationId }, data: { currentVersionId: orphan.versions[0].id, versionCount: 1 } })
    const response = await call('POST', { action: 'open' }, '', `https://qa.invalid/api/share/artifacts/${orphanToken}/copilot`)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'SIGN_IN_REQUIRED')
  })
}
