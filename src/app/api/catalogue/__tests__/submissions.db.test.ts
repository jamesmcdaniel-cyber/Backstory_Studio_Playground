import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Who may propose a catalogue entry, and what a reviewer will actually see.
 * The snapshot assertion is the load-bearing one: it proves an author cannot
 * edit their way into a different published entry after submitting.
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

  test('a customer workspace cannot submit to the catalogue', async () => {
    installTestAuth(customer.auth)
    const { POST } = await import('../submissions/route')
    const response = await POST(post({
      kind: 'agent_template',
      sourceId: customerTemplateId,
      title: 'Digest',
      summary: 'A weekly digest.',
    }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'PERMISSION_DENIED')
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
