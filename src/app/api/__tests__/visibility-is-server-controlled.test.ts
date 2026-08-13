import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NextRequest } from 'next/server'

const apiDir = path.dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '')

// A static guard: accepting `visibility` from a request body is what let any
// workspace publish into every other workspace's catalogue, and it must not be
// reintroduced by a future schema edit.
test('no template route accepts visibility from a request body', () => {
  for (const route of ['flow-templates/route.ts', 'agent-templates/route.ts']) {
    const source = readFileSync(path.join(apiDir, route), 'utf8')
    assert.ok(
      !/visibility:\s*z\./.test(source),
      `${route} declares visibility in a Zod schema — publishing must be server-controlled`,
    )
    assert.ok(
      !/body\.visibility|data\.visibility/.test(source),
      `${route} reads visibility from the request body`,
    )
  }
})

// The private-flow invariant held in four of the five places that resolve a flow
// by id: the v1 run route filtered on organizationId alone, so an API key could
// EXECUTE a colleague's private flow (firing its side effects under the
// workspace's credentials) while being unable to read, edit, or delete it. A
// static guard, because the gap was an omission in one route rather than a
// disagreement about the rule.
test('every public API v1 flow route applies the owner visibility scope', () => {
  for (const route of ['v1/flows/route.ts', 'v1/flows/[id]/route.ts', 'v1/flows/[id]/run/route.ts']) {
    const source = readFileSync(path.join(apiDir, route), 'utf8')
    assert.ok(
      /agentVisibilityScope\(auth\.userId\)/.test(source),
      `${route} resolves a flow without agentVisibilityScope — an API key must reach only its minter's private flows`,
    )
  }
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const post = (body: unknown) =>
    new NextRequest(new URL('http://test/api/agent-templates'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  test('a template created with visibility=global in the body is still org-scoped', async () => {
    const { POST } = await import('../agent-templates/route')
    const response = await POST(post({
      name: 'Sneaky publish',
      category: 'Custom',
      instructions: 'do a thing',
      visibility: 'global',
    }))
    assert.equal(response.status, 200)
    const row = await prisma.agentTemplate.findFirst({
      where: { organizationId: seeded.organizationId, name: 'Sneaky publish' },
    })
    assert.equal(row.visibility, 'org')
    assert.equal(row.catalogueStatus, 'none')
  })

  test('an update cannot promote an existing template into the catalogue', async () => {
    const existing = await prisma.agentTemplate.create({
      data: {
        name: 'Quiet template',
        type: 'Custom',
        configuration: { instructions: 'do a thing' },
        organizationId: seeded.organizationId,
        userId: seeded.userId,
      },
    })
    const { PUT } = await import('../agent-templates/route')
    const response = await PUT(new NextRequest(new URL('http://test/api/agent-templates'), {
      method: 'PUT',
      body: JSON.stringify({ id: existing.id, visibility: 'global' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(response.status, 200)
    const row = await prisma.agentTemplate.findFirst({
      where: { id: existing.id, organizationId: seeded.organizationId },
    })
    assert.equal(row.visibility, 'org')
  })
}
