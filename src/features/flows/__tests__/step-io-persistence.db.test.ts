import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode).
// Raw-I/O persistence: what the run panel reads out of flow_run_steps must be
// the value each node actually evaluated (input) and the value downstream
// steps actually consumed (output).
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'StepIO', slug: `step-io-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.httpCredential.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  const run = async (graph: unknown, input: unknown) => {
    const flow = await prisma.flow.create({
      data: { name: `io-${Date.now()}`, organizationId: ids.org, userId: ids.user, status: 'ACTIVE', graph, publishedGraph: graph },
    })
    const result = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, input, usePublished: true })
    const steps = await prisma.flowRunStep.findMany({ where: { flowRunId: result.flowRunId }, orderBy: { order: 'asc' } })
    return { result, steps }
  }

  test('interpreter steps persist the resolved input they evaluated (not the schema-default {})', async () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'cond', type: 'condition', data: { clauses: [{ left: '{{trigger.input.tier}}', op: 'eq', right: 'gold' }] } },
        { id: 'tf', type: 'transform', data: { fields: [{ name: 'greeting', value: 'hi {{trigger.input.name}}' }] } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'cond' },
        { id: 'e2', source: 'cond', target: 'tf', branch: 'true' },
      ],
    }
    const { result, steps } = await run(graph, { tier: 'gold', name: 'Ada' })
    assert.equal(result.status, 'succeeded')

    const cond = steps.find((s: any) => s.nodeId === 'cond')
    assert.deepEqual(cond.input, { clauses: [{ left: 'gold', op: 'eq', right: 'gold' }] })
    assert.equal(cond.output, true)

    const tf = steps.find((s: any) => s.nodeId === 'tf')
    assert.deepEqual(tf.input, { tier: 'gold', name: 'Ada' })
    assert.deepEqual(tf.output, { greeting: 'hi Ada' })
  })

  test('a code step whose raw text output parses as JSON persists the CONSUMED object, and its persisted input omits the embedded copy of every prior step output', async () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'first', type: 'transform', data: { fields: [{ name: 'seed', value: 'value-1' }] } },
        { id: 'js', type: 'code', data: { language: 'javascript', mode: 'all', code: 'return JSON.stringify({ made: true })' } },
        { id: 'reads', type: 'transform', data: { fields: [{ name: 'made', value: '{{step.js.output.made}}' }] } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'first' },
        { id: 'e2', source: 'first', target: 'js' },
        { id: 'e3', source: 'js', target: 'reads' },
      ],
    }
    const { result, steps } = await run(graph, '')
    assert.equal(result.status, 'succeeded')

    const js = steps.find((s: any) => s.nodeId === 'js')
    // Downstream consumed asStructured(text) — the object. The row must show
    // the consumed value, or the panel displays a string while {{step.js.output.made}} worked.
    assert.deepEqual(js.output, { made: true })
    // The whole-run context rides into the sandbox but must NOT be duplicated
    // into this row — every prior step's output is already on its own row.
    const persistedContext = (js.input as any).context
    assert.equal(typeof persistedContext.steps, 'string', 'context.steps is an omission marker, not the full copy')

    const reads = steps.find((s: any) => s.nodeId === 'reads')
    assert.deepEqual(reads.output, { made: true })
  })

  test('a knowledge step persists exactly ONE row, with its query as input', async () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'kn', type: 'knowledge', data: { query: 'find {{trigger.input.q}}' } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'kn' }],
    }
    const { result, steps } = await run(graph, { q: 'accounts' })
    assert.equal(result.status, 'succeeded')
    const rows = steps.filter((s: any) => s.nodeId === 'kn')
    assert.equal(rows.length, 1, 'knowledge must not double-persist (adapter row + interpreter row)')
    assert.equal((rows[0].input as any).query, 'find accounts')
  })

  test('a resolution failure on an adapter step persists a failed row naming the node — never a failed run with zero steps', async () => {
    // HTTP steps never run unauthenticated (validation rejects them up front),
    // so the step carries a real verified credential. The bad reference still
    // fails during input resolution, BEFORE the http adapter runs — so the
    // adapter writes no row. Without the interpreter-side fallback the run
    // fails with "No steps recorded" and nothing names the offending node
    // (the bug this test pins).
    const { encryptSecret } = await import('@/lib/crypto/secrets')
    const credential = await prisma.httpCredential.create({
      data: {
        organizationId: ids.org,
        name: 'api.example.com bearer',
        authType: 'bearer',
        allowedHost: 'api.example.com',
        secretConfig: encryptSecret(JSON.stringify({ token: 'test-token' })),
        status: 'verified',
        lastVerifiedAt: new Date(),
      },
    })
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        {
          id: 'h1',
          type: 'http',
          data: {
            label: 'Find Opportunity',
            method: 'GET',
            url: 'https://api.example.com/{{$json.query.opportunityId}}',
            credentialId: credential.id,
          },
        },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'h1' }],
    }
    const { result, steps } = await run(graph, '')
    assert.equal(result.status, 'failed')
    const failed = steps.find((s: any) => s.nodeId === 'h1')
    assert.ok(failed, 'the failing node must have a step row for the run panel to point at')
    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /Unknown data reference/)
    assert.ok(failed.input, 'the resolved config is persisted for inspection')
  })

  test('a per-item code step records each item row AND the aggregate array downstream consumed', async () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        {
          id: 'js',
          type: 'code',
          data: {
            language: 'javascript',
            mode: 'all',
            code: 'return `did:${input}`',
            input: '{{item}}',
            perItem: { over: '{{trigger.input.items}}' },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'js' }],
    }
    const { result, steps } = await run(graph, { items: ['a', 'b'] })
    assert.equal(result.status, 'succeeded')
    const children = steps.filter((s: any) => s.nodeId === 'js#0' || s.nodeId === 'js#1')
    assert.equal(children.length, 2)
    const aggregate = steps.find((s: any) => s.nodeId === 'js')
    assert.ok(aggregate, 'the aggregate array downstream consumed must have a row')
    assert.deepEqual(aggregate.output, ['did:a', 'did:b'])
  })
}
