import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * The free-tier ceilings, enforced where they are actually enforced: in the
 * route handlers.
 *
 * src/lib/usage/__tests__ covers the counting rules as pure functions, which is
 * why deleting a rule would fail CI. Deleting the three CALL SITES would not
 * have: `POST /api/flows/[id]/execute`, `POST /api/agents/[id]/execute` and
 * `POST /api/nango/session-token` are the only places the ceilings are applied,
 * and all three sat on the SKIPS list in mutating-route-smoke.test.ts citing
 * coverage that did not exist. Removing `if (allowance.over) throw ...` from any
 * of them was a green build.
 *
 * Each route gets the same three cases:
 *   over the cap    → the canonical 429 AND the downstream side effect (a run
 *                     row, a minted Nango session) never happens;
 *   under the cap   → the request gets PAST the gate, stopping at a stubbed
 *                     boundary rather than a live model or a live Nango;
 *   super admin     → exempt, per isUnlimitedActor.
 *
 * The boundaries come from src/app/api/__tests__/helpers/stub-execution.ts:
 * runs stop at the queue dispatcher (the product's own EXECUTION_MODE /
 * BULLMQ_DISABLE switch), and Nango is a localhost HTTP server whose recorded
 * calls ARE the "was it minted?" assertion.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'
}

const skip = TEST_DB ? false : 'requires TEST_DATABASE_URL'

let prisma: any
let helpers: any
let installTestAuth: (auth: any) => void
let restoreExecution: () => void
let nango: any

/** A workspace at its ceiling, one under it, and a super admin. */
let capped: any
let under: any
let admin: any
const seeded: any[] = []

// Per-fixture resources, so no test depends on another's ordering.
const flowId: Record<string, string> = {}
const agentId: Record<string, string> = {}

const LIMIT_BODY = (code: string) => ({ status: 429, code })

before(async () => {
  if (!TEST_DB) return
  helpers = await import('./helpers/stub-execution')
  // Before ANY route import: both flags are read into module constants at load.
  restoreExecution = helpers.stubBackgroundExecution()
  nango = await helpers.startFakeNango()
  ;({ prisma } = await import('@/lib/prisma'))
  const testAuth = await import('@/lib/server/__tests__/test-auth')
  installTestAuth = testAuth.installTestAuth

  capped = await testAuth.seedTestOrg(prisma)
  under = await testAuth.seedTestOrg(prisma)
  // catalogue.review — the permission isUnlimitedActor treats as "super admin".
  // Far-future createdAt so this internal org never wins resolveInternalOrgId
  // out from under a concurrently running catalogue test (see domains-route.db.test.ts).
  admin = await testAuth.seedTestOrg(prisma, {
    orgKind: 'internal',
    platformRole: 'reviewer',
    orgCreatedAt: new Date('2099-01-01T00:00:00.000Z'),
  })
  seeded.push(capped, under, admin)
  assert.ok(admin.auth.can('catalogue.review'), 'the admin fixture must actually be exempt')
  assert.ok(!capped.auth.can('catalogue.review'), 'the capped fixture must actually be capped')

  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'out', type: 'output', data: { outputs: [{ name: 'ok', value: 'ran', type: 'text' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'out' }],
  }
  for (const [name, fixture] of Object.entries({ capped, under, admin })) {
    flowId[name] = (
      await prisma.flow.create({
        data: {
          name: `${name} flow`,
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          trigger: { type: 'manual' },
          graph,
        },
      })
    ).id
    agentId[name] = (
      await prisma.agentTask.create({
        data: {
          description: `${name} agent`,
          objective: 'say hello',
          status: 'ACTIVE',
          visibility: 'shared',
          organizationId: fixture.organizationId,
          userId: fixture.userId,
        },
      })
    ).id
  }

  // Put `capped` and `admin` on every ceiling. `under` is left empty — the two
  // fixtures differ only in how many rows they already have, which is what
  // makes the 429/non-429 split attributable to the allowance check alone.
  for (const name of ['capped', 'admin'] as const) {
    const fixture = name === 'capped' ? capped : admin
    await helpers.fillDailyRunAllowance(prisma, {
      kind: 'flow',
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      flowId: flowId[name],
    })
    await helpers.fillDailyRunAllowance(prisma, {
      kind: 'agent',
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agentTaskId: agentId[name],
    })
    await helpers.fillIntegrationAllowance(prisma, {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
    })
  }
})

after(async () => {
  if (!TEST_DB) return
  await nango?.close()
  restoreExecution?.()
  for (const fixture of seeded) await fixture?.cleanup?.()
})

const request = (path: string, payload?: unknown) =>
  helpers.jsonRequest(NextRequest, path, 'POST', payload)

const runFlow = async (id: string, payload?: unknown) =>
  (await import('../flows/[id]/execute/route')).POST(request(`/api/flows/${id}/execute`, payload ?? {}))

const runAgent = async (id: string, payload?: unknown) =>
  (await import('../agents/[id]/execute/route')).POST(request(`/api/agents/${id}/execute`, payload ?? {}))

const mintSession = async (payload?: unknown) =>
  (await import('../nango/session-token/route')).POST(request('/api/nango/session-token', payload ?? {}))

const countFlowRuns = (fixture: any) =>
  prisma.flowRun.count({ where: { organizationId: fixture.organizationId, userId: fixture.userId } })
const countAgentRuns = (fixture: any) =>
  prisma.agentExecution.count({ where: { organizationId: fixture.organizationId, userId: fixture.userId } })

/** Assert the canonical limit response: 429 with the route's documented code. */
async function assertLimitResponse(response: Response, code: string) {
  const body = await helpers.readJson(response)
  assert.deepEqual(
    { status: response.status, code: body.code },
    LIMIT_BODY(code),
    `expected the free-tier limit response, got ${response.status} ${JSON.stringify(body)}`,
  )
  assert.equal(body.success, false)
  assert.match(String(body.error), /limit|used all/i, 'the message must say what the caller ran into')
}

// ---------------------------------------------------------------- flow runs

test('a flow run over the daily cap is refused, and no run is started', { skip }, async () => {
  installTestAuth(capped.auth)
  const before = await countFlowRuns(capped)
  const response = await runFlow(flowId.capped)
  await assertLimitResponse(response, 'DAILY_LIMIT_REACHED')
  assert.equal(await countFlowRuns(capped), before, 'the refused call must not create a FlowRun')
})

test('the flow cap is checked BEFORE the flow is looked up', { skip }, async () => {
  installTestAuth(capped.auth)
  // Same call, an id that does not exist. A capped caller must still see 429 —
  // if the lookup ran first this would be 404, and the ceiling would be
  // trivially probeable for which flows exist.
  const response = await runFlow('does-not-exist')
  await assertLimitResponse(response, 'DAILY_LIMIT_REACHED')
})

test('under the cap, a flow run reaches the execution layer', { skip }, async () => {
  installTestAuth(under.auth)
  const before = await countFlowRuns(under)
  const response = await runFlow(flowId.under)
  const body = await helpers.readJson(response)
  assert.notEqual(response.status, 429, JSON.stringify(body))
  assert.notEqual(body.code, 'DAILY_LIMIT_REACHED')
  // The FlowRun row is the proof: startFlowExecution validates the graph and
  // persists the run BEFORE handing it to the dispatcher, which the stub then
  // refuses. Nothing was interpreted, and no model was called.
  assert.equal(await countFlowRuns(under), before + 1, 'the gate must let a real run through')
  const run = await prisma.flowRun.findFirst({
    where: { organizationId: under.organizationId, flowId: flowId.under },
    orderBy: { startedAt: 'desc' },
  })
  assert.ok(run, 'a FlowRun row is the proof the request got past the gate')
})

test('a super admin is exempt from the daily flow cap', { skip }, async () => {
  installTestAuth(admin.auth)
  // Already holding a full day's worth of runs — a capped actor would 429 here.
  const response = await runFlow(flowId.admin)
  const body = await helpers.readJson(response)
  assert.notEqual(response.status, 429, JSON.stringify(body))
  assert.notEqual(body.code, 'DAILY_LIMIT_REACHED')
})

// --------------------------------------------------------------- agent runs

test('an agent run over the daily cap is refused, and no execution is created', { skip }, async () => {
  installTestAuth(capped.auth)
  const before = await countAgentRuns(capped)
  const response = await runAgent(agentId.capped, { input: 'hello' })
  await assertLimitResponse(response, 'DAILY_LIMIT_REACHED')
  assert.equal(await countAgentRuns(capped), before, 'the refused call must not create an AgentExecution')
})

test('the agent cap is checked BEFORE the agent is looked up', { skip }, async () => {
  installTestAuth(capped.auth)
  const response = await runAgent('does-not-exist', { input: 'hello' })
  await assertLimitResponse(response, 'DAILY_LIMIT_REACHED')
})

test('under the cap, an agent run reaches the dispatch boundary', { skip }, async () => {
  installTestAuth(under.auth)
  const before = await countAgentRuns(under)
  const response = await runAgent(agentId.under, { input: 'hello' })
  const body = await helpers.readJson(response)
  assert.notEqual(response.status, 429, JSON.stringify(body))
  // The queue seam is stubbed off, so the route stops at "worker disabled"
  // AFTER creating the execution row — past the gate, without a model call.
  assert.equal(response.status, 503, JSON.stringify(body))
  assert.equal(body.code, 'WORKER_DISABLED')
  assert.equal(await countAgentRuns(under), before + 1, 'the gate must let a real run through')
})

test('a super admin is exempt from the daily agent cap', { skip }, async () => {
  installTestAuth(admin.auth)
  const response = await runAgent(agentId.admin, { input: 'hello' })
  const body = await helpers.readJson(response)
  assert.notEqual(response.status, 429, JSON.stringify(body))
  assert.equal(response.status, 503, 'and stops at the same stubbed boundary')
})

// ------------------------------------------------------------- integrations

test('a workspace at the integration cap is refused before Nango is called', { skip }, async () => {
  installTestAuth(capped.auth)
  const before = nango.calls.length
  const response = await mintSession({ integrationId: 'slack' })
  await assertLimitResponse(response, 'INTEGRATION_LIMIT_REACHED')
  assert.equal(nango.calls.length, before, 'no connect session may be minted for a refused workspace')
})

test('under the cap, a Nango connect session is minted', { skip }, async () => {
  installTestAuth(under.auth)
  const before = nango.calls.length
  const response = await mintSession({ integrationId: 'slack' })
  const body = await helpers.readJson(response)
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.sessionToken, nango.token)
  assert.equal(nango.calls.length, before + 1, 'exactly one mint')
  const call = nango.calls.at(-1)
  assert.match(call.path, /\/connect\/sessions/)
  assert.equal((call.body as any).organization.id, under.organizationId, 'sessions stay org-scoped')
})

test('a super admin is exempt from the integration cap', { skip }, async () => {
  installTestAuth(admin.auth)
  const before = nango.calls.length
  const response = await mintSession({ integrationId: 'slack' })
  assert.equal(response.status, 200, await response.text())
  assert.equal(nango.calls.length, before + 1)
})
