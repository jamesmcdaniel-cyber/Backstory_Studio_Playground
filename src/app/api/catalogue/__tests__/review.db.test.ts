import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * The review gate end to end: only a reviewer sees the cross-org queue, an
 * approval publishes into the internal org, and a second approval cannot
 * double-publish.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let installTestAuth: any
  let partner: any
  let backstory: any
  let submissionId: string

  const openSubmission = async (overrides: Record<string, unknown> = {}) => {
    const submission = await prisma.catalogueSubmission.create({
      data: {
        kind: 'agent_template',
        title: 'Weekly pipeline digest',
        summary: 'Summarises pipeline movement every Monday.',
        snapshot: {
          name: 'Weekly pipeline digest',
          description: 'A digest',
          type: 'Reporting',
          configuration: { instructions: 'Summarise the pipeline.', authorName: 'Rin' },
        },
        organizationId: partner.organizationId,
        submittedByUserId: partner.userId,
        ...overrides,
      },
    })
    return submission.id
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    partner = await testAuth.seedTestOrg(prisma, { orgKind: 'partner' })
    backstory = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    submissionId = await openSubmission()
  })

  after(async () => {
    if (backstory) await backstory.cleanup()
    if (partner) await partner.cleanup()
  })

  const decide = (id: string, body: unknown) => [
    new NextRequest(new URL(`http://test/api/catalogue/review/${id}`), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  ] as const

  test('a submitter cannot read the cross-org review queue', async () => {
    installTestAuth(partner.auth)
    const { GET } = await import('../review/route')
    const response = await GET(new NextRequest(new URL('http://test/api/catalogue/review')))
    assert.equal(response.status, 403)
  })

  test('a reviewer sees pending submissions from every workspace', async () => {
    installTestAuth(backstory.auth)
    const { GET } = await import('../review/route')
    const response = await GET(new NextRequest(new URL('http://test/api/catalogue/review')))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(body.submissions.some((s: any) => s.id === submissionId))
  })

  test('requesting changes leaves the submission un-published', async () => {
    installTestAuth(backstory.auth)
    const id = await openSubmission()
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(id, { decision: 'changes_requested', note: 'Add a setup step.' }))
    assert.equal(response.status, 200)
    const row = await prisma.catalogueSubmission.findFirst({ where: { id, organizationId: partner.organizationId } })
    assert.equal(row.status, 'changes_requested')
    assert.equal(row.reviewNote, 'Add a setup step.')
    assert.equal(row.publishedEntryId, null)
  })

  test('a rejection stores the reason and notifies the author with rejection copy', async () => {
    installTestAuth(backstory.auth)
    const id = await openSubmission()
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(id, { decision: 'rejected', note: 'Duplicates an existing template.' }))
    assert.equal(response.status, 200)
    const row = await prisma.catalogueSubmission.findFirst({ where: { id, organizationId: partner.organizationId } })
    assert.equal(row.status, 'rejected')
    assert.equal(row.reviewNote, 'Duplicates an existing template.')
    assert.equal(row.publishedEntryId, null)
    // The author hears the actual outcome — rejected, not "needs changes".
    const notification = await prisma.notification.findFirst({
      where: { organizationId: partner.organizationId, userId: partner.userId, type: 'catalogue.decision' },
      orderBy: { createdAt: 'desc' },
    })
    assert.match(notification.title, /was not accepted to the catalogue/)
    assert.equal(notification.level, 'error')
    assert.equal(notification.body, 'Duplicates an existing template.')
  })

  test('requesting changes without a note is refused', async () => {
    installTestAuth(backstory.auth)
    const id = await openSubmission()
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(id, { decision: 'changes_requested' }))
    assert.equal(response.status, 400)
    // The submission must remain pending — a rejected decision is not a decision.
    const row = await prisma.catalogueSubmission.findFirst({ where: { id, organizationId: partner.organizationId } })
    assert.equal(row.status, 'pending')
  })

  test('approving publishes into the internal org and stamps the entry', async () => {
    installTestAuth(backstory.auth)
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(submissionId, { decision: 'approved' }))
    assert.equal(response.status, 200)

    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: submissionId, organizationId: partner.organizationId },
    })
    assert.equal(row.status, 'approved')
    assert.ok(row.publishedEntryId)

    const entry = await prisma.agentTemplate.findFirst({
      where: { id: row.publishedEntryId, organizationId: backstory.organizationId },
    })
    assert.equal(entry.visibility, 'global')
    assert.equal(entry.catalogueStatus, 'published')
    // The approving reviewer is the accountable owner, not the outside author.
    assert.equal(entry.userId, backstory.userId)
    assert.equal(entry.configuration.authorName, 'Rin')
  })

  test('a second approval of the same submission conflicts rather than double-publishing', async () => {
    installTestAuth(backstory.auth)
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(submissionId, { decision: 'approved' }))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'ALREADY_DECIDED')
  })

  test('approving still works when the author deleted the source row', async () => {
    installTestAuth(backstory.auth)
    const id = await openSubmission({ sourceId: 'a-row-that-no-longer-exists' })
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(id, { decision: 'approved' }))
    // The snapshot is authoritative — publishing never reads the source again,
    // so a deleted original is expected rather than an error.
    assert.equal(response.status, 200)
    assert.ok((await response.json()).publishedEntryId)
  })

  test('takedown retires a published entry without deleting it', async () => {
    installTestAuth(backstory.auth)
    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: submissionId, organizationId: partner.organizationId },
    })
    const { DELETE } = await import('../entries/[id]/route')
    const response = await DELETE(
      new NextRequest(new URL(`http://test/api/catalogue/entries/${row.publishedEntryId}`), { method: 'DELETE' }),
      { params: Promise.resolve({ id: row.publishedEntryId }) },
    )
    assert.equal(response.status, 200)
    const entry = await prisma.agentTemplate.findFirst({
      where: { id: row.publishedEntryId, organizationId: backstory.organizationId },
    })
    assert.equal(entry.isActive, false)
  })

  test('a submitter cannot take an entry down', async () => {
    installTestAuth(partner.auth)
    const { DELETE } = await import('../entries/[id]/route')
    const response = await DELETE(
      new NextRequest(new URL('http://test/api/catalogue/entries/anything'), { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'anything' }) },
    )
    assert.equal(response.status, 403)
  })
}
