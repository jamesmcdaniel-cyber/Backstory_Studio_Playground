import test from 'node:test'
import assert from 'node:assert/strict'
import { assertDatabricksHost, DatabricksStatementError, rowsToCsv, runWarehouseStatement, type DatabricksRequest } from '../databricks'

/** A Databricks that answers submit, polls and chunk reads from a script. */
function fakeDatabricks(script: Array<{ match: RegExp; method?: 'GET' | 'POST'; status?: number; body: unknown }>) {
  const calls: Array<{ path: string; method: string; body?: string }> = []
  const request: DatabricksRequest = async (path, init) => {
    calls.push({ path, method: init.method, ...(init.body ? { body: init.body } : {}) })
    const step = script.shift()
    if (!step) throw new Error(`unexpected request ${init.method} ${path}`)
    assert.match(path, step.match)
    if (step.method) assert.equal(init.method, step.method)
    const status = step.status ?? 200
    return { status, ok: status < 400, text: typeof step.body === 'string' ? step.body : JSON.stringify(step.body) }
  }
  return { request, calls }
}

const noSleep = async () => {}

test('a statement is submitted with a bounded wait, polled until it succeeds, and its chunks collected in order', async () => {
  const db = fakeDatabricks([
    { match: /^\/api\/2\.0\/sql\/statements$/, method: 'POST', body: { statement_id: 's1', status: { state: 'PENDING' } } },
    { match: /^\/api\/2\.0\/sql\/statements\/s1$/, method: 'GET', body: { statement_id: 's1', status: { state: 'RUNNING' } } },
    { match: /^\/api\/2\.0\/sql\/statements\/s1$/, method: 'GET', body: { statement_id: 's1', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'email' }, { name: 'bookings' }] }, truncated: false, total_chunk_count: 2 }, result: { data_array: [['a@x.com', 10]], next_chunk_internal_link: '/api/2.0/sql/statements/s1/result/chunks/1' } } },
    { match: /\/result\/chunks\/1$/, method: 'GET', body: { data_array: [['b@x.com', null]], next_chunk_internal_link: null } },
  ])
  const result = await runWarehouseStatement({ warehouseId: 'abc123def456', statement: 'select 1', request: db.request, sleep: noSleep })
  assert.equal(result.statementId, 's1')
  assert.deepEqual(result.columns, ['email', 'bookings'])
  assert.deepEqual(result.rows, [['a@x.com', 10], ['b@x.com', null]])
  assert.equal(result.chunks, 2)
  assert.equal(result.truncated, false)
  const submitted = JSON.parse(db.calls[0].body!) as Record<string, unknown>
  assert.equal(submitted.warehouse_id, 'abc123def456')
  assert.equal(submitted.statement, 'select 1')
  assert.equal(submitted.wait_timeout, '50s')
  assert.equal(submitted.on_wait_timeout, 'CONTINUE')
  assert.equal(submitted.format, 'JSON_ARRAY')
})

test('a failed statement, a rejected submit and a statement that outlives the deadline each fail with the reason', async () => {
  const failed = fakeDatabricks([
    { match: /statements$/, body: { statement_id: 's2', status: { state: 'FAILED', error: { error_code: 'SYNTAX', message: 'cannot resolve column' } } } },
  ])
  await assert.rejects(runWarehouseStatement({ warehouseId: 'w', statement: 'x', request: failed.request, sleep: noSleep }), (error: unknown) => error instanceof DatabricksStatementError && /failed: cannot resolve column/.test(error.message))

  const unauthorised = fakeDatabricks([{ match: /statements$/, status: 403, body: { error_code: 'PERMISSION_DENIED', message: 'no warehouse access' } }])
  await assert.rejects(runWarehouseStatement({ warehouseId: 'w', statement: 'x', request: unauthorised.request, sleep: noSleep }), /HTTP 403.*no warehouse access.*saved HTTP credential/)

  let clock = 0
  const slow = fakeDatabricks([
    { match: /statements$/, body: { statement_id: 's3', status: { state: 'PENDING' } } },
    { match: /statements\/s3$/, body: { statement_id: 's3', status: { state: 'RUNNING' } } },
  ])
  await assert.rejects(
    runWarehouseStatement({ warehouseId: 'w', statement: 'x', request: slow.request, sleep: async () => { clock += 60_000 }, now: () => clock, deadlineMs: 60_000 }),
    /still running after 1 minutes/,
  )
})

test('rows become RFC 4180 CSV with the manifest\'s header; nulls are empty, quotes and newlines are quoted', () => {
  const csv = rowsToCsv(['name', 'note', 'n'], [['Acme, Inc.', 'said "hi"\nthen left', 3], ['Plain', null, 0]])
  assert.equal(csv, 'name,note,n\n"Acme, Inc.","said ""hi""\nthen left",3\nPlain,,0\n')
})

test('the host is a bare hostname: schemes and paths are stripped, nonsense is refused', () => {
  assert.equal(assertDatabricksHost('https://dbc-a1b2c3d4-e5f6.cloud.databricks.com/sql/'), 'dbc-a1b2c3d4-e5f6.cloud.databricks.com')
  assert.throws(() => assertDatabricksHost('localhost'), /not a Databricks workspace host/)
  assert.throws(() => assertDatabricksHost('bad host.example.com'), /not a Databricks workspace host/)
})
