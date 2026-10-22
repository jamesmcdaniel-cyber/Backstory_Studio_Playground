import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabricksStatementError, pickDefaultWarehouse, runDatabricksJob, runWarehouseStatement } from '../databricks'
import { fakeWarehouse, noSleep } from './fake-warehouse'

test('named parameters, catalog and schema travel beside the statement, never inside it', async () => {
  const db = fakeWarehouse([
    { match: /^\/api\/2\.0\/sql\/statements$/, method: 'POST', body: { statement_id: 's1', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'id' }] } }, result: { data_array: [['7']] } } },
  ])
  await runWarehouseStatement({
    warehouseId: 'w1',
    statement: 'SELECT id FROM accounts WHERE name = :name',
    parameters: [{ name: 'name', value: "O'Brien; DROP TABLE x" }, { name: 'n', value: '3', type: 'INT' }],
    catalog: 'main',
    schema: 'sales',
    request: db.request,
    sleep: noSleep,
  })
  const body = JSON.parse(db.calls[0].body!) as Record<string, unknown>
  assert.equal(body.statement, 'SELECT id FROM accounts WHERE name = :name')
  assert.deepEqual(body.parameters, [{ name: 'name', value: "O'Brien; DROP TABLE x" }, { name: 'n', value: '3', type: 'INT' }])
  assert.equal(body.catalog, 'main')
  assert.equal(body.schema, 'sales')
})

test('a result spread over several chunks is collected in order after polling', async () => {
  const db = fakeWarehouse([
    { match: /statements$/, body: { statement_id: 's2', status: { state: 'PENDING' } } },
    { match: /statements\/s2$/, method: 'GET', body: { statement_id: 's2', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'a' }, { name: 'b' }] }, total_chunk_count: 3 }, result: { data_array: [['1', 'x']], next_chunk_internal_link: '/api/2.0/sql/statements/s2/result/chunks/1' } } },
    { match: /chunks\/1$/, body: { data_array: [['2', 'y']], next_chunk_internal_link: '/api/2.0/sql/statements/s2/result/chunks/2' } },
    { match: /chunks\/2$/, body: { data_array: [['3', null]] } },
  ])
  const result = await runWarehouseStatement({ warehouseId: 'w', statement: 'select a, b from t', request: db.request, sleep: noSleep })
  assert.deepEqual(result.rows, [['1', 'x'], ['2', 'y'], ['3', null]])
  assert.equal(result.chunks, 3)
})

test('a statement with no result set (DDL/DML) succeeds with no columns instead of failing', async () => {
  const db = fakeWarehouse([{ match: /statements$/, body: { statement_id: 's3', status: { state: 'SUCCEEDED' }, manifest: { schema: { column_count: 0 } } } }])
  const result = await runWarehouseStatement({ warehouseId: 'w', statement: 'CREATE TABLE t (a INT)', request: db.request, sleep: noSleep })
  assert.deepEqual(result, { statementId: 's3', columns: [], rows: [], truncated: false, chunks: 0 })
})

test('the default warehouse is the only one, else the only running one, else the caller must choose', async () => {
  const one = fakeWarehouse([{ match: /^\/api\/2\.0\/sql\/warehouses$/, method: 'GET', body: { warehouses: [{ id: 'abc', name: 'Main', state: 'STOPPED' }] } }])
  assert.equal(await pickDefaultWarehouse(one.request), 'abc')
  const running = fakeWarehouse([{ match: /warehouses$/, body: { warehouses: [{ id: 'a', state: 'STOPPED' }, { id: 'b', state: 'RUNNING' }] } }])
  assert.equal(await pickDefaultWarehouse(running.request), 'b')
  const ambiguous = fakeWarehouse([{ match: /warehouses$/, body: { warehouses: [{ id: 'a', name: 'One', state: 'RUNNING' }, { id: 'b', name: 'Two', state: 'RUNNING' }] } }])
  await assert.rejects(pickDefaultWarehouse(ambiguous.request), /pass warehouseId.*One \(a\), Two \(b\)/)
  const none = fakeWarehouse([{ match: /warehouses$/, body: { warehouses: [] } }])
  await assert.rejects(pickDefaultWarehouse(none.request), /no SQL warehouse/)
  const denied = fakeWarehouse([{ match: /warehouses$/, status: 401, body: { error_code: 'UNAUTHENTICATED', message: 'bad token' } }])
  await assert.rejects(pickDefaultWarehouse(denied.request), /HTTP 401.*bad token.*saved HTTP credential/)
})

test('a job run is started with its parameters and polled until it terminates successfully', async () => {
  const db = fakeWarehouse([
    { match: /^\/api\/2\.1\/jobs\/run-now$/, method: 'POST', body: { run_id: 42, number_in_job: 42 } },
    { match: /^\/api\/2\.1\/jobs\/runs\/get\?run_id=42$/, method: 'GET', body: { run_id: 42, state: { life_cycle_state: 'PENDING' } } },
    { match: /runs\/get\?run_id=42$/, body: { run_id: 42, state: { life_cycle_state: 'RUNNING' } } },
    { match: /runs\/get\?run_id=42$/, body: { run_id: 42, run_page_url: 'https://dbc.example/#job/1/run/42', run_duration: 61_000, state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS', state_message: '' } } },
  ])
  const sleeps: number[] = []
  const run = await runDatabricksJob({ jobId: 7, jobParameters: { region: 'emea' }, request: db.request, sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(JSON.parse(db.calls[0].body!), { job_id: 7, job_parameters: { region: 'emea' } })
  assert.equal(run.runId, 42)
  assert.equal(run.completed, true)
  assert.equal(run.resultState, 'SUCCESS')
  assert.equal(run.durationMs, 61_000)
  assert.equal(run.runPageUrl, 'https://dbc.example/#job/1/run/42')
  assert.equal(sleeps.length, 2)
})

test('a failed job run, a run past its deadline and an unwaited run each report honestly', async () => {
  const failed = fakeWarehouse([
    { match: /run-now$/, body: { run_id: 5 } },
    { match: /runs\/get/, body: { run_id: 5, run_page_url: 'https://dbc.example/run/5', state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED', state_message: 'Task notebook failed: NameError' } } },
  ])
  await assert.rejects(runDatabricksJob({ jobId: 1, request: failed.request, sleep: noSleep }), (error: unknown) => error instanceof DatabricksStatementError && /ended failed: Task notebook failed: NameError/.test(error.message) && /run\/5/.test(error.message))

  let clock = 0
  const slow = fakeWarehouse([
    { match: /run-now$/, body: { run_id: 6 } },
    { match: /runs\/get/, body: { run_id: 6, state: { life_cycle_state: 'RUNNING' } } },
    { match: /runs\/get/, body: { run_id: 6, state: { life_cycle_state: 'RUNNING' } } },
  ])
  await assert.rejects(
    runDatabricksJob({ jobId: 1, request: slow.request, deadlineMs: 60_000, now: () => clock, sleep: async () => { clock += 60_000 } }),
    /still running after 1 minutes — it keeps running in Databricks/,
  )

  const fire = fakeWarehouse([{ match: /run-now$/, body: { run_id: 9 } }])
  const started = await runDatabricksJob({ jobId: 1, request: fire.request, waitForCompletion: false })
  assert.deepEqual(started, { runId: 9, lifeCycleState: 'PENDING', completed: false })

  const refused = fakeWarehouse([{ match: /run-now$/, status: 403, body: { error_code: 'PERMISSION_DENIED', message: 'no CAN MANAGE RUN' } }])
  await assert.rejects(runDatabricksJob({ jobId: 1, request: refused.request }), /Starting the job failed \(HTTP 403\): PERMISSION_DENIED: no CAN MANAGE RUN/)
})
