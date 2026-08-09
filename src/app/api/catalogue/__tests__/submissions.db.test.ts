import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Who may propose a catalogue entry, and what a reviewer will actually see.
 * Two load-bearing assertions: the frozen snapshot proves an author cannot
 * edit their way into a different published entry after submitting, and the
 * sanitize pass proves an external workspace's private ids never ride along.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let installTestAuth: any
  let customer: any
  let partner: any
  let partnerTemplateId: string
  let customerTemplateId: string

  const mkTemplate = (organizationId: string, userId: string) =>
    prisma.agentTemplate.create({
      data: { name: 'Digest', type: 'Reporting', configuration: { instructions: 'do a thing' }, organizationId, userId },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    customer = await testAuth.seedTestOrg(prisma, { orgKind: 'customer' })
    partner = await testAuth.seedTestOrg(prisma, { orgKind: 'partner' })
    customerTemplateId = (await mkTemplate(customer.organizationId, customer.userId)).id
    partnerTemplateId = (await mkTemplate(partner.organizationId, partner.userId)).id
  })

  after(async () => {
    if (partner) await partner.cleanup()
    if (customer) await customer.cleanup()
  })

  const post = (body: unknown) =>
    new NextRequest(new URL('http://test/api/catalogue/submissions'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  test('an external customer workspace may submit — the review queue is the gate', async () => {
    installTestAuth(customer.auth)
    const { POST } = await import('../submissions/route')
    const response = await POST(post({
      kind: 'agent_template',
      sourceId: customerTemplateId,
      title: 'Digest',
      summary: 'A weekly digest.',
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.submission.status, 'pending')
    assert.equal(body.submission.organizationId, customer.organizationId)
  })

  test('a submission is sanitized on the way in: ids dropped, literals reported', async () => {
    installTestAuth(customer.auth)
    const dirty = await prisma.agentTemplate.create({
      data: {
        name: 'Dirty',
        type: 'Reporting',
        configuration: {
          instructions: 'call the API',
          connectionId: 'conn_private_123',
          headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
        },
        organizationId: customer.organizationId,
        userId: customer.userId,
      },
    })

    const { POST } = await import('../submissions/route')
    const response = await POST(post({
      kind: 'agent_template',
      sourceId: dirty.id,
      title: 'Dirty',
      summary: 'Carries a workspace id and a literal token.',
    }))
    assert.equal(response.status, 200)
    const { submission } = await response.json()

    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: submission.id, organizationId: customer.organizationId },
    })
    // The author's private connection id never reaches a published entry.
    assert.equal(row.snapshot.configuration.connectionId, undefined)
    assert.doesNotMatch(JSON.stringify(row.snapshot), /conn_private_123/)
    // The instructions — the reason the template is worth installing — survive.
    assert.equal(row.snapshot.configuration.instructions, 'call the API')
    // The literal token cannot be stripped without breaking the template, so
    // the reviewer is told about it instead.
    assert.ok(Array.isArray(row.warnings) && row.warnings.length >= 1)
    assert.match(row.warnings[0].path, /Authorization/)
    assert.doesNotMatch(JSON.stringify(row.warnings), /abcdefghijklmnop/)
  })

  test('a partner workspace submits and gets a pending row with a frozen snapshot', async () => {
    installTestAuth(partner.auth)
    const { POST } = await import('../submissions/route')
    const response = await POST(post({
      kind: 'agent_template',
      sourceId: partnerTemplateId,
      title: 'Digest',
      summary: 'A weekly digest.',
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.submission.status, 'pending')

    // Editing the source afterward must not change what a reviewer sees.
    await prisma.agentTemplate.update({
      where: { id: partnerTemplateId, organizationId: partner.organizationId },
      data: { configuration: { instructions: 'something else entirely' } },
    })
    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: body.submission.id, organizationId: partner.organizationId },
    })
    assert.equal(row.snapshot.configuration.instructions, 'do a thing')
  })

  test('submitting another workspace item fails without leaking its existence', async () => {
    installTestAuth(partner.auth)
    const { POST } = await import('../submissions/route')
    const response = await POST(post({
      kind: 'agent_template',
      sourceId: customerTemplateId,
      title: 'Not mine',
      summary: 'Should not resolve.',
    }))
    assert.equal(response.status, 404)
  })

  test('an author sees only their own workspace submissions', async () => {
    installTestAuth(partner.auth)
    const { GET } = await import('../submissions/route')
    const response = await GET(new NextRequest(new URL('http://test/api/catalogue/submissions')))
    const body = await response.json()
    assert.ok(body.submissions.length >= 1)
    for (const submission of body.submissions) {
      assert.equal(submission.organizationId, partner.organizationId)
    }
  })

  test('an author withdraws their own pending submission', async () => {
    installTestAuth(partner.auth)
    const pending = await prisma.catalogueSubmission.findFirst({
      where: { organizationId: partner.organizationId, status: 'pending' },
    })
    const { DELETE } = await import('../submissions/[id]/route')
    const response = await DELETE(
      new NextRequest(new URL(`http://test/api/catalogue/submissions/${pending.id}`), { method: 'DELETE' }),
      { params: Promise.resolve({ id: pending.id }) },
    )
    assert.equal(response.status, 200)
    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: pending.id, organizationId: partner.organizationId },
    })
    assert.equal(row.status, 'withdrawn')
  })
}
