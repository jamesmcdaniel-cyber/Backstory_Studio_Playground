/**
 * The snapshot's one claim: the demo org contains NO real value at all. These
 * tests seed a workspace with known real names threaded through structured
 * columns, prose, run payloads and connection metadata, clone it, and walk
 * every copied row asserting the names are gone — plus the invariants that
 * make the sandbox safe: no credentials cross, shadow identities cannot
 * authenticate, and re-entry reuses the standing sandbox.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — the demo snapshot needs a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
}

let systemPrisma: any
let ensureDemoWorkspace: any

before(async () => {
  if (!TEST_DB) return
  ;({ systemPrisma } = await import('@/lib/prisma'))
  ;({ ensureDemoWorkspace } = await import('../snapshot'))
})

const REAL_COMPANY = 'Acmezilla Corp'
const REAL_EMAIL = 'sarah.chen@acmezilla.com'
const REAL_PERSON = 'Sarah Chen'

async function seedRealOrg() {
  const org = await systemPrisma.organization.create({
    data: { name: REAL_COMPANY, slug: `demo-src-${crypto.randomUUID()}`, kind: 'customer' },
  })
  const user = await systemPrisma.user.create({
    data: {
      supabaseId: crypto.randomUUID(),
      email: REAL_EMAIL,
      name: REAL_PERSON,
      organizationId: org.id,
      isActive: true,
      role: 'ADMIN',
    },
  })
  const flow = await systemPrisma.flow.create({
    data: {
      name: `${REAL_COMPANY} renewal digest`,
      description: `Email ${REAL_EMAIL} the Acmezilla pipeline`,
      trigger: { type: 'manual' },
      graph: { nodes: [{ id: 'n1', data: { prompt: `Summarise ${REAL_COMPANY} activity for ${REAL_PERSON}` } }] },
      organizationId: org.id,
      userId: user.id,
      status: 'published',
    },
  })
  const run = await systemPrisma.flowRun.create({
    data: {
      flowId: flow.id,
      status: 'succeeded',
      trigger: { type: 'manual' },
      input: {},
      output: { summary: `${REAL_PERSON} of ${REAL_COMPANY} confirmed the renewal (${REAL_EMAIL}).` },
      organizationId: org.id,
      userId: user.id,
    },
  })
  await systemPrisma.flowRunStep.create({
    data: {
      flowRunId: run.id,
      nodeId: 'n1',
      order: 0,
      status: 'succeeded',
      input: {},
      output: { text: `Called ${REAL_PERSON} at 415-555-2671 about Acmezilla.` },
    },
  })
  const agent = await systemPrisma.agentTask.create({
    data: {
      type: 'scheduled',
      priority: 'medium',
      agentType: 'digest',
      description: `Watch ${REAL_COMPANY}`,
      objective: `Track the ${REAL_COMPANY} account`,
      context: {},
      schedule: {},
      status: 'active',
      organizationId: org.id,
      userId: user.id,
    },
  })
  await systemPrisma.notification.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      type: 'run',
      level: 'info',
      title: `${REAL_COMPANY} digest ready`,
      body: `Includes notes from ${REAL_EMAIL}`,
      agentTaskId: agent.id,
    },
  })
  await systemPrisma.nangoConnection.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      connectionId: `real-conn-${crypto.randomUUID()}`,
      providerConfigKey: 'slack',
      status: 'connected',
      metadata: { team: REAL_COMPANY },
    },
  })
  await systemPrisma.httpCredential.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      name: 'Acmezilla API',
      authType: 'bearer',
      allowedHost: 'api.acmezilla.com',
      secretConfig: 'enc:not-a-real-secret',
    },
  })
  return { org, user, flow }
}

/** Every copied table, dumped as one string for the absence assertions. */
async function dumpDemoOrg(demoOrgId: string): Promise<string> {
  const parts: unknown[] = []
  const org = await systemPrisma.organization.findUnique({ where: { id: demoOrgId } })
  parts.push(org)
  const users = await systemPrisma.user.findMany({ where: { organizationId: demoOrgId } })
  parts.push(users)
  const flows = await systemPrisma.flow.findMany({ where: { organizationId: demoOrgId } })
  parts.push(flows)
  const runs = await systemPrisma.flowRun.findMany({ where: { organizationId: demoOrgId } })
  parts.push(runs)
  parts.push(await systemPrisma.flowRunStep.findMany({ where: { flowRunId: { in: runs.map((run: any) => run.id) } } }))
  parts.push(await systemPrisma.agentTask.findMany({ where: { organizationId: demoOrgId } }))
  parts.push(await systemPrisma.notification.findMany({ where: { organizationId: demoOrgId } }))
  parts.push(await systemPrisma.nangoConnection.findMany({ where: { organizationId: demoOrgId } }))
  return JSON.stringify(parts, (_key, value) => (typeof value === 'bigint' ? String(value) : value))
}

test('no demo-org row contains the real company, person, or email', { skip }, async () => {
  const { org, user } = await seedRealOrg()
  const { demoOrgId, created } = await ensureDemoWorkspace(org.id, user.id)
  assert.ok(created)
  const dump = await dumpDemoOrg(demoOrgId)
  assert.ok(!/acmezilla/i.test(dump), 'real company name leaked into the demo org')
  assert.ok(!dump.includes(REAL_EMAIL), 'real email leaked into the demo org')
  assert.ok(!/Sarah Chen/.test(dump), 'real person name leaked into the demo org')
  assert.ok(!dump.includes('415-555-2671'), 'real phone leaked into the demo org')
})

test('the demo org is populated, not blank', { skip }, async () => {
  const { org, user } = await seedRealOrg()
  const { demoOrgId } = await ensureDemoWorkspace(org.id, user.id)
  assert.equal(await systemPrisma.flow.count({ where: { organizationId: demoOrgId } }), 1)
  assert.equal(await systemPrisma.flowRun.count({ where: { organizationId: demoOrgId } }), 1)
  assert.equal(await systemPrisma.agentTask.count({ where: { organizationId: demoOrgId } }), 1)
  const run = await systemPrisma.flowRun.findFirst({ where: { organizationId: demoOrgId } })
  const steps = await systemPrisma.flowRunStep.count({ where: { flowRunId: run.id } })
  assert.equal(steps, 1)
})

test('no credential rows cross; connection shells carry no real ids', { skip }, async () => {
  const { org, user } = await seedRealOrg()
  const { demoOrgId } = await ensureDemoWorkspace(org.id, user.id)
  assert.equal(await systemPrisma.httpCredential.count({ where: { organizationId: demoOrgId } }), 0)
  assert.equal(await systemPrisma.integrationSecret.count({ where: { organizationId: demoOrgId } }), 0)
  assert.equal(await systemPrisma.apiKey.count({ where: { user: { organizationId: demoOrgId } } }), 0)
  const shell = await systemPrisma.nangoConnection.findFirst({ where: { organizationId: demoOrgId } })
  assert.equal(shell.status, 'connected')
  assert.match(shell.connectionId, /^demo-/)
  assert.deepEqual(shell.metadata, {})
})

test('shadow members cannot be a real identity and hold no platform role', { skip }, async () => {
  const { org, user } = await seedRealOrg()
  const { demoOrgId } = await ensureDemoWorkspace(org.id, user.id)
  const shadows = await systemPrisma.user.findMany({ where: { organizationId: demoOrgId } })
  assert.equal(shadows.length, 1)
  assert.notEqual(shadows[0].supabaseId, user.supabaseId)
  assert.equal(shadows[0].platformRole, null)
})

test('re-entry reuses the standing sandbox', { skip }, async () => {
  const { org, user } = await seedRealOrg()
  const first = await ensureDemoWorkspace(org.id, user.id)
  const second = await ensureDemoWorkspace(org.id, user.id)
  assert.equal(second.demoOrgId, first.demoOrgId)
  assert.equal(second.created, false)
})
