/**
 * The MCP health sweep runs cross-tenant from cron and writes the state the UI
 * shows for every workspace's connections. What matters is that each connection
 * gets the right persisted outcome, and that ONE dead third-party server cannot
 * stop the rest of the sweep — a single unreachable host silently freezing
 * everyone else's health state is exactly the failure this guards against.
 *
 * Verification itself is injected: it speaks HTTPS to a third-party server and
 * the SSRF guard refuses every address a test could bind, so the healthy and
 * schema-drift outcomes are unreachable otherwise. The final test uses the REAL
 * verifier to prove the default wiring still reaches the database.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — the MCP health sweep needs a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
}

let systemPrisma: any
let sweepMcpConnectionHealth: any

before(async () => {
  if (!TEST_DB) return
  ;({ systemPrisma } = await import('@/lib/prisma'))
  ;({ sweepMcpConnectionHealth } = await import('../health-sweep'))
})

const HOUR = 60 * 60_000

async function seedOrg() {
  const org = await systemPrisma.organization.create({
    data: { name: 'sweep', slug: `sweep-${crypto.randomUUID()}`, kind: 'customer' },
  })
  return org.id
}

/**
 * The sweep is GLOBAL by design (cron-gated, cross-tenant) and CI runs every DB
 * test file against one shared database, so a bare `checked === 1` would be
 * measuring the whole database. Returned counts are therefore asserted as lower
 * bounds; the per-row state of this test's own fixtures carries the weight.
 */
const atLeast = (actual: number, expected: number, what: string) =>
  assert.ok(actual >= expected, `${what}: expected at least ${expected}, got ${actual}`)

const dropOrg = async (organizationId: string) => {
  await systemPrisma.user.updateMany({ where: { organizationId }, data: { organizationId: null } }).catch(() => {})
  await systemPrisma.organization.delete({ where: { id: organizationId } }).catch(() => {})
}

async function seedConnection(organizationId: string, overrides: Record<string, unknown> = {}) {
  return systemPrisma.mcpConnection.create({
    data: {
      organizationId,
      name: `conn-${crypto.randomUUID()}`,
      serverUrl: 'https://mcp.example.com/rpc',
      authType: 'none',
      ...overrides,
    },
  })
}

const verifiesAs = (schemaHash: string, verifiedAt?: Date) => async () => ({
  // Default to now: the sweep persists the VERIFIER's timestamp, so a fixed
  // past date would leave the row instantly stale again.
  verifiedAt: verifiedAt ?? new Date(),
  toolCount: 2,
  toolNames: ['a', 'b'],
  schemaHash,
})

test('a healthy connection records the verification time, status and schema hash', { skip }, async () => {
  const organizationId = await seedOrg()
  try {
    const connection = await seedConnection(organizationId)
    const verifiedAt = new Date('2026-01-02T03:04:05.000Z')

    const result = await sweepMcpConnectionHealth(new Date(), { verify: verifiesAs('hash-1', verifiedAt) })

    atLeast(result.checked, 1, 'checked')
    const row = await systemPrisma.mcpConnection.findUnique({ where: { id: connection.id } })
    assert.equal(row.healthStatus, 'healthy')
    assert.equal(row.lastError, null)
    assert.equal(row.toolSchemaHash, 'hash-1')
    assert.equal(row.lastVerifiedAt.toISOString(), verifiedAt.toISOString(), 'the verifier’s clock is persisted')
  } finally {
    await dropOrg(organizationId)
  }
})

test('a changed tool schema is recorded as drift, not as healthy', { skip }, async () => {
  const organizationId = await seedOrg()
  try {
    const connection = await seedConnection(organizationId, { toolSchemaHash: 'old-hash' })

    const result = await sweepMcpConnectionHealth(new Date(), { verify: verifiesAs('new-hash') })

    atLeast(result.changed, 1, 'changed')
    const row = await systemPrisma.mcpConnection.findUnique({ where: { id: connection.id } })
    assert.equal(row.healthStatus, 'schema_changed')
    assert.equal(row.toolSchemaHash, 'new-hash', 'the new hash is stored so drift is reported once, not forever')
  } finally {
    await dropOrg(organizationId)
  }
})

test('an unchanged schema is healthy, and a first-ever hash is not drift', { skip }, async () => {
  const organizationId = await seedOrg()
  try {
    const unchanged = await seedConnection(organizationId, { toolSchemaHash: 'same-hash' })
    const firstTime = await seedConnection(organizationId, { toolSchemaHash: null })

    const result = await sweepMcpConnectionHealth(new Date(), { verify: verifiesAs('same-hash') })

    atLeast(result.checked, 2, 'checked')
    for (const id of [unchanged.id, firstTime.id]) {
      const row = await systemPrisma.mcpConnection.findUnique({ where: { id } })
      assert.equal(row.healthStatus, 'healthy')
    }
  } finally {
    await dropOrg(organizationId)
  }
})

test('a failing connection is recorded unhealthy with a redacted error', { skip }, async () => {
  const organizationId = await seedOrg()
  try {
    const connection = await seedConnection(organizationId, { healthStatus: 'healthy', toolSchemaHash: 'h' })
    const now = new Date('2026-02-02T00:00:00.000Z')

    const result = await sweepMcpConnectionHealth(now, {
      verify: async () => {
        throw new Error('401 from server, sent Authorization: Bearer sk-ant-supersecrettoken123')
      },
    })

    atLeast(result.unhealthy, 1, 'unhealthy')
    const row = await systemPrisma.mcpConnection.findUnique({ where: { id: connection.id } })
    assert.equal(row.healthStatus, 'unhealthy')
    assert.equal(row.lastVerifiedAt.toISOString(), now.toISOString(), 'the attempt time is recorded so it is not re-swept immediately')
    assert.ok(row.lastError.includes('Bearer [redacted]'), `error not redacted: ${row.lastError}`)
    assert.ok(!row.lastError.includes('supersecrettoken123'), 'the credential must never be persisted')
    assert.equal(row.toolSchemaHash, 'h', 'the last known good schema hash is kept on failure')
  } finally {
    await dropOrg(organizationId)
  }
})

test('one dead server does not abort the sweep — the rest still get checked', { skip }, async () => {
  const orgA = await seedOrg()
  const orgB = await seedOrg()
  try {
    const first = await seedConnection(orgA, { name: 'first', serverUrl: 'https://a.example.com/rpc' })
    const dead = await seedConnection(orgA, { name: 'dead', serverUrl: 'https://dead.example.com/rpc' })
    // A different workspace entirely: the sweep is cross-tenant, so orgA's dead
    // server must not be able to strand orgB's health state.
    const other = await seedConnection(orgB, { name: 'other', serverUrl: 'https://b.example.com/rpc' })

    const result = await sweepMcpConnectionHealth(new Date(), {
      verify: async (connection: any) => {
        if (connection.serverUrl.includes('dead')) throw new Error('ECONNREFUSED')
        return { verifiedAt: new Date(), toolCount: 1, toolNames: ['t'], schemaHash: 'ok' }
      },
    })

    atLeast(result.checked, 3, 'checked')
    atLeast(result.unhealthy, 1, 'unhealthy')
    const statuses = Object.fromEntries(
      (await systemPrisma.mcpConnection.findMany({ where: { id: { in: [first.id, dead.id, other.id] } } })).map(
        (row: any) => [row.name, row.healthStatus],
      ),
    )
    assert.deepEqual(statuses, { first: 'healthy', dead: 'unhealthy', other: 'healthy' })
  } finally {
    await dropOrg(orgA)
    await dropOrg(orgB)
  }
})

test('only stale, active connections are swept', { skip }, async () => {
  const organizationId = await seedOrg()
  try {
    const never = await seedConnection(organizationId, { name: 'never', lastVerifiedAt: null })
    const stale = await seedConnection(organizationId, {
      name: 'stale',
      lastVerifiedAt: new Date(Date.now() - 7 * HOUR),
    })
    const fresh = await seedConnection(organizationId, {
      name: 'fresh',
      lastVerifiedAt: new Date(Date.now() - 1 * HOUR),
    })
    const inactive = await seedConnection(organizationId, {
      name: 'inactive',
      isActive: false,
      lastVerifiedAt: null,
    })

    const result = await sweepMcpConnectionHealth(new Date(), { verify: verifiesAs('h') })

    atLeast(result.checked, 2, 'checked')
    const byName = Object.fromEntries(
      (await systemPrisma.mcpConnection.findMany({ where: { organizationId } })).map((row: any) => [
        row.name,
        row.healthStatus,
      ]),
    )
    assert.equal(byName.never, 'healthy')
    assert.equal(byName.stale, 'healthy')
    assert.equal(byName.fresh, 'unknown', 'a recently verified connection is not re-checked')
    assert.equal(byName.inactive, 'unknown', 'a disabled connection is never contacted')
    assert.ok(never && stale && fresh && inactive)
  } finally {
    await dropOrg(organizationId)
  }
})

test('the sweep is bounded — a large backlog is drained over several runs', { skip }, async () => {
  // Unbounded, a workspace with hundreds of connections would turn one cron
  // tick into a burst of third-party traffic.
  const organizationId = await seedOrg()
  try {
    for (let i = 0; i < 23; i += 1) await seedConnection(organizationId)

    const first = await sweepMcpConnectionHealth(new Date(), { verify: verifiesAs('h') })
    assert.equal(first.checked, 20, 'exactly the cap — 23 rows are eligible, one tick must not take them all')
    assert.ok(
      (await systemPrisma.mcpConnection.count({ where: { organizationId, healthStatus: 'unknown' } })) >= 3,
      'the remainder is deferred to a later tick',
    )

    // Already-verified rows sort last, so successive ticks drain the backlog
    // rather than re-checking the ones just done.
    let ticks = 1
    while (
      (await systemPrisma.mcpConnection.count({ where: { organizationId, healthStatus: 'unknown' } })) > 0
    ) {
      assert.ok(ticks < 6, 'the backlog is not draining — later ticks are re-checking fresh rows')
      const next = await sweepMcpConnectionHealth(new Date(), { verify: verifiesAs('h') })
      assert.ok(next.checked <= 20, `a tick checked ${next.checked} connections, above the cap`)
      ticks += 1
    }
    assert.ok(ticks <= 3, `23 connections should drain in 2 ticks, took ${ticks}`)
  } finally {
    await dropOrg(organizationId)
  }
})

test('the real verifier is wired in and its failure lands in the database', { skip }, async () => {
  // No injected dependency: this is the production path end to end. The host
  // does not resolve, so the sweep must record it rather than throw.
  const organizationId = await seedOrg()
  try {
    const connection = await seedConnection(organizationId, {
      serverUrl: 'https://mcp-does-not-exist.invalid/rpc',
    })

    const result = await sweepMcpConnectionHealth(new Date())

    atLeast(result.checked, 1, 'checked')
    atLeast(result.unhealthy, 1, 'unhealthy')
    const row = await systemPrisma.mcpConnection.findUnique({ where: { id: connection.id } })
    assert.equal(row.healthStatus, 'unhealthy')
    assert.ok(row.lastError && row.lastError.length > 0, 'the operator needs to see why it failed')
    assert.ok(row.lastError.length <= 300, 'the stored error stays bounded')
  } finally {
    await dropOrg(organizationId)
  }
})
