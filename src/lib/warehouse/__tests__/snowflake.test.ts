import test from 'node:test'
import assert from 'node:assert/strict'
import { coerceSnowflakeValue, runSnowflakeStatement, snowflakeBindings, SnowflakeStatementError } from '../snowflake'
import { fakeWarehouse, noSleep } from './fake-warehouse'

const rowType = [
  { name: 'ID', type: 'fixed', scale: 0 },
  { name: 'NAME', type: 'text' },
  { name: 'AMOUNT', type: 'fixed', scale: 2 },
  { name: 'ACTIVE', type: 'boolean' },
]

test('a statement that finishes inside the sync window answers records converted per column type', async () => {
  const sf = fakeWarehouse([
    {
      match: /^\/api\/v2\/statements\?requestId=[0-9a-f-]{36}$/,
      method: 'POST',
      body: {
        statementHandle: 'h1',
        resultSetMetaData: { numRows: 2, rowType, partitionInfo: [{ rowCount: 2 }] },
        data: [['1', 'Acme', '12.50', 'true'], ['2', null, '0.00', 'false']],
      },
    },
  ])
  const result = await runSnowflakeStatement({ statement: 'select * from t', request: sf.request, sleep: noSleep, warehouse: 'COMPUTE_WH', role: 'ANALYST', database: 'SALES', schema: 'PUBLIC' })
  assert.deepEqual(result.columns, ['ID', 'NAME', 'AMOUNT', 'ACTIVE'])
  assert.deepEqual(result.rows, [
    { ID: 1, NAME: 'Acme', AMOUNT: 12.5, ACTIVE: true },
    { ID: 2, NAME: null, AMOUNT: 0, ACTIVE: false },
  ])
  assert.equal(result.rowCount, 2)
  assert.equal(result.truncated, false)
  const body = JSON.parse(sf.calls[0].body!) as Record<string, unknown>
  assert.equal(body.statement, 'select * from t')
  assert.equal(body.warehouse, 'COMPUTE_WH')
  assert.equal(body.role, 'ANALYST')
  assert.equal(body.database, 'SALES')
  assert.equal(body.schema, 'PUBLIC')
  assert.equal(typeof body.timeout, 'number')
  assert.equal('bindings' in body, false)
})

test('a 202 is polled with back-off until the result is ready, then every partition is read', async () => {
  const sf = fakeWarehouse([
    { match: /^\/api\/v2\/statements\?/, method: 'POST', status: 202, body: { code: '333334', message: 'Asynchronous execution in progress.', statementHandle: 'h2', statementStatusUrl: '/api/v2/statements/h2' } },
    { match: /^\/api\/v2\/statements\/h2$/, method: 'GET', status: 202, body: { code: '333334', statementHandle: 'h2' } },
    { match: /^\/api\/v2\/statements\/h2$/, method: 'GET', body: { statementHandle: 'h2', resultSetMetaData: { numRows: 5, rowType: [{ name: 'N', type: 'fixed', scale: 0 }], partitionInfo: [{ rowCount: 2 }, { rowCount: 2 }, { rowCount: 1 }] }, data: [['1'], ['2']] } },
    { match: /^\/api\/v2\/statements\/h2\?partition=1$/, method: 'GET', body: { data: [['3'], ['4']] } },
    { match: /^\/api\/v2\/statements\/h2\?partition=2$/, method: 'GET', body: { data: [['5']] } },
  ])
  const sleeps: number[] = []
  const result = await runSnowflakeStatement({ statement: 'select n from big', request: sf.request, sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(result.rows.map((row) => row.N), [1, 2, 3, 4, 5])
  assert.equal(result.partitions, 3)
  assert.equal(result.statementHandle, 'h2')
  assert.deepEqual(sleeps, [1000, 2000])
  assert.equal(sf.remaining.length, 0)
})

test('maxRows stops reading partitions early and says the result was truncated', async () => {
  const sf = fakeWarehouse([
    { match: /statements\?/, body: { statementHandle: 'h3', resultSetMetaData: { numRows: 6, rowType: [{ name: 'N', type: 'fixed', scale: 0 }], partitionInfo: [{ rowCount: 3 }, { rowCount: 3 }] }, data: [['1'], ['2'], ['3']] } },
  ])
  const result = await runSnowflakeStatement({ statement: 'select n', request: sf.request, maxRows: 2, sleep: noSleep })
  assert.deepEqual(result.rows, [{ N: 1 }, { N: 2 }])
  assert.equal(result.rowCount, 6)
  assert.equal(result.truncated, true)
})

test('bindings carry values typed and numbered, separate from the SQL', async () => {
  assert.deepEqual(snowflakeBindings(['x', 3, 2.5, true, null, { a: 1 }]), {
    1: { type: 'TEXT', value: 'x' },
    2: { type: 'FIXED', value: '3' },
    3: { type: 'REAL', value: '2.5' },
    4: { type: 'BOOLEAN', value: 'true' },
    5: { type: 'TEXT', value: null },
    6: { type: 'TEXT', value: '{"a":1}' },
  })
  assert.deepEqual(snowflakeBindings({ 1: { type: 'date', value: '2026-01-01' } }), { 1: { type: 'DATE', value: '2026-01-01' } })
  assert.equal(snowflakeBindings([]), undefined)
  assert.throws(() => snowflakeBindings({ name: 'x' }), /must be numbered/)

  const sf = fakeWarehouse([{ match: /statements\?/, body: { statementHandle: 'h4', resultSetMetaData: { numRows: 1, rowType: [{ name: 'number of rows inserted', type: 'fixed', scale: 0 }] }, data: [['1']] } }])
  await runSnowflakeStatement({ statement: 'INSERT INTO t (a, b) VALUES (?, ?)', bindings: ["O'Brien'); DROP TABLE t; --", 4], request: sf.request, sleep: noSleep })
  const body = JSON.parse(sf.calls[0].body!) as { statement: string; bindings: Record<string, unknown> }
  assert.equal(body.statement, 'INSERT INTO t (a, b) VALUES (?, ?)')
  assert.deepEqual(body.bindings, { 1: { type: 'TEXT', value: "O'Brien'); DROP TABLE t; --" }, 2: { type: 'FIXED', value: '4' } })
})

test('compilation errors, auth failures and missing warehouses surface Snowflake\'s own reason', async () => {
  const bad = fakeWarehouse([{ match: /statements\?/, status: 422, body: { code: '001003', sqlState: '42000', message: "SQL compilation error: syntax error line 1 at position 7 unexpected 'form'.", statementHandle: 'h5' } }])
  await assert.rejects(runSnowflakeStatement({ statement: 'select form t', request: bad.request }), (error: unknown) => error instanceof SnowflakeStatementError && /HTTP 422\): 001003: SQL compilation error/.test(error.message))

  const denied = fakeWarehouse([{ match: /statements\?/, status: 401, body: { code: '390318', message: 'OAuth access token expired.' } }])
  await assert.rejects(runSnowflakeStatement({ statement: 'select 1', request: denied.request }), /HTTP 401.*token expired.*saved Snowflake credential/)

  const noWarehouse = fakeWarehouse([{ match: /statements\?/, status: 422, body: { code: '000606', message: 'No active warehouse selected in the current session.' } }])
  await assert.rejects(runSnowflakeStatement({ statement: 'select 1', request: noWarehouse.request }), /pass "warehouse", or set a DEFAULT_WAREHOUSE/)

  const failedLater = fakeWarehouse([
    { match: /statements\?/, status: 202, body: { statementHandle: 'h6' } },
    { match: /statements\/h6$/, status: 422, body: { code: '100038', message: "Numeric value 'abc' is not recognized" } },
  ])
  await assert.rejects(runSnowflakeStatement({ statement: 'select 1', request: failedLater.request, sleep: noSleep }), /Reading the statement failed \(HTTP 422\).*not recognized/)
})

test('a statement still running at the deadline is cancelled and reported', async () => {
  let clock = 0
  const sf = fakeWarehouse([
    { match: /statements\?/, status: 202, body: { statementHandle: 'h7' } },
    { match: /statements\/h7$/, status: 202, body: { statementHandle: 'h7' } },
    { match: /statements\/h7\/cancel$/, method: 'POST', body: { code: '000604', message: 'cancelled' } },
  ])
  await assert.rejects(
    runSnowflakeStatement({ statement: 'select slow()', request: sf.request, deadlineMs: 60_000, now: () => clock, sleep: async () => { clock += 60_000 } }),
    /still running after 1 minutes and was cancelled/,
  )
  assert.equal(sf.calls.at(-1)?.path, '/api/v2/statements/h7/cancel')
})

test('jsonv2 cells convert to the values the n8n node produced', () => {
  assert.equal(coerceSnowflakeValue('12345678901234567890', { type: 'fixed', scale: 0 }), '12345678901234567890')
  assert.equal(coerceSnowflakeValue('1.5e3', { type: 'real' }), 1500)
  assert.deepEqual(coerceSnowflakeValue('{"a":[1,2]}', { type: 'variant' }), { a: [1, 2] })
  assert.equal(coerceSnowflakeValue('19723', { type: 'date' }), '2024-01-01')
  assert.equal(coerceSnowflakeValue('1704067200.123000000', { type: 'timestamp_ntz' }), '2024-01-01T00:00:00.123Z')
  assert.equal(coerceSnowflakeValue('1704067200.000000000 1500', { type: 'timestamp_tz' }), '2024-01-01T00:00:00.000Z')
  assert.equal(coerceSnowflakeValue('3723.5', { type: 'time' }), '01:02:03.5')
  assert.equal(coerceSnowflakeValue('plain', { type: 'text' }), 'plain')
  assert.equal(coerceSnowflakeValue(null, { type: 'fixed' }), null)
})
