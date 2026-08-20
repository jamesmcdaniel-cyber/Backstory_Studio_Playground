/**
 * The outbound gate: inside a demo org's ambient context, every transport
 * seam returns a canned success and the real dialler is never invoked;
 * outside it, the real path runs untouched.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — the demo transport gate needs a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
}

let systemPrisma: any
let ambientOrganization: any
let transport: any

before(async () => {
  if (!TEST_DB) return
  ;({ systemPrisma } = await import('@/lib/prisma'))
  ;({ ambientOrganization } = await import('@/lib/tenant-database-context'))
  transport = await import('../transport')
})

async function seedOrg(kind: string) {
  return systemPrisma.organization.create({
    data: { name: `transport-${kind}`, slug: `transport-${crypto.randomUUID()}`, kind },
  })
}

test('demoFetchOr shorts to canned inside a demo org and never dials', { skip }, async () => {
  transport.clearDemoKindCache()
  const demo = await seedOrg('demo')
  let dialled = false
  const response = await ambientOrganization.run(demo.id, () =>
    transport.demoFetchOr('slack', async () => {
      dialled = true
      return new Response('real')
    }),
  )
  assert.equal(dialled, false)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.channel, 'C0DEMO')
})

test('demoFetchOr runs the real call for a normal org', { skip }, async () => {
  transport.clearDemoKindCache()
  const real = await seedOrg('customer')
  let dialled = false
  await ambientOrganization.run(real.id, () =>
    transport.demoFetchOr('email', async () => {
      dialled = true
      return new Response('real')
    }),
  )
  assert.equal(dialled, true)
})

test('no ambient org means no demo gate (worker paths without context)', { skip }, async () => {
  transport.clearDemoKindCache()
  let dialled = false
  await transport.demoFetchOr('http', async () => {
    dialled = true
    return new Response('real')
  })
  assert.equal(dialled, true)
})

test('demoAmbientActive is true only inside the demo org context', { skip }, async () => {
  transport.clearDemoKindCache()
  const demo = await seedOrg('demo')
  const real = await seedOrg('customer')
  assert.equal(await ambientOrganization.run(demo.id, () => transport.demoAmbientActive()), true)
  assert.equal(await ambientOrganization.run(real.id, () => transport.demoAmbientActive()), false)
  assert.equal(await transport.demoAmbientActive(), false)
})

test('canned shapes: mcp result names the tool, nango proxy carries data', { skip: false }, async () => {
  const { cannedResponse } = await import('../transport')
  const mcp = cannedResponse('mcp', { toolName: 'slack_post_message' }) as { content: { text: string }[] }
  assert.match(mcp.content[0].text, /slack_post_message/)
  const proxy = cannedResponse('nango-proxy', { endpoint: '/repos', method: 'GET' }) as { data: { demo: boolean } }
  assert.equal(proxy.data.demo, true)
})
