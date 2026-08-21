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

  const DEMO_MODEL = `demo-only-model-${crypto.randomUUID().slice(0, 8)}`
  const get = () => new NextRequest(new URL('http://test/api/admin/models?days=90'))
  const total = async () => {
    const response = await modelsRoute.GET(get())
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return body
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')

    operator = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    testAuth.installTestAuth(operator.auth)

    modelsRoute = await import('../models/route')
  })

  after(async () => {
    await operator?.cleanup()
  })

  test('a demo-clone organization does not appear in the models rollup or headline total', async () => {
    // costs/route.ts and models/route.ts aggregate the SAME cross-org
    // LlmCall table, and the shared bs_ci_repro database runs suites
    // concurrently — a sibling suite mutating that table mid-test (seeding or
    // cleaning up its own rows) can land between two calls to this route.
    // Bracketing the baseline capture, the seed, and the final read all
    // inside ONE test body (no `before`/`after` boundary crossing, no
    // unrelated awaits in between) keeps that window as small as it can be.
    const before1 = await total()

    const demoOrg = await prisma.organization.create({
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

    try {
      const body = await total()

      assert.ok(
        !body.models.some((row: any) => row.model === DEMO_MODEL),
        'the demo-only model must not appear in the rollup',
      )
      const delta = Number((body.total.costUsd - before1.total.costUsd).toFixed(2))
      assert.equal(delta, 0, 'seeding the demo org\'s fabricated spend must leave the unbounded total unchanged')
    } finally {
      await prisma.llmCall.deleteMany({ where: { organizationId: demoOrg.id } })
      await prisma.organization.delete({ where: { id: demoOrg.id } })
    }
  })
}
