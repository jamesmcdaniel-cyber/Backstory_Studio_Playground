import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * /api/admin/models against a real database — demo-clone exclusion only.
 *
 * Demo orgs (kind === 'demo') are disposable anonymised clones of a real
 * workspace (src/lib/demo/snapshot.ts). Their LlmCall rows are canned history
 * the clone wrote for itself, not real spend or real model performance. If
 * they leaked into this route's cross-org rollup, a fabricated model/provider
 * pair would inflate both the top-50 table and the unbounded headline total.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin models route demo exclusion (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let modelsRoute: any
  let operator: any
  let demoOrg: any

  const DEMO_MODEL = `demo-only-model-${crypto.randomUUID().slice(0, 8)}`
  const get = () => new NextRequest(new URL('http://test/api/admin/models?days=90'))

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')

    operator = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    testAuth.installTestAuth(operator.auth)

    demoOrg = await prisma.organization.create({
      data: { name: 'Demo Clone Org', slug: `demo-org-${crypto.randomUUID()}`, kind: 'demo' },
    })
    await prisma.llmCall.create({
      data: {
        organizationId: demoOrg.id,
        surface: 'agent_turn',
        provider: 'anthropic',
        model: DEMO_MODEL,
        priceVersion: 'test-2026-08',
        costUsd: '999999.00',
        inputTokens: 10,
        outputTokens: 10,
      },
    })

    modelsRoute = await import('../models/route')
  })

  after(async () => {
    await prisma.llmCall.deleteMany({ where: { organizationId: demoOrg.id } })
    await prisma.organization.delete({ where: { id: demoOrg.id } })
    await operator?.cleanup()
  })

  test('a demo-clone organization does not appear in the models rollup or headline total', async () => {
    const response = await modelsRoute.GET(get())
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    assert.ok(
      !body.models.some((row: any) => row.model === DEMO_MODEL),
      'the demo-only model must not appear in the rollup',
    )
    assert.ok(
      body.total.costUsd < 999999,
      'the unbounded total must not include the demo org\'s fabricated spend',
    )
  })
}
