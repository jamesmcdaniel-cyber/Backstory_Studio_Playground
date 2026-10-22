import test from 'node:test'
import assert from 'node:assert/strict'
import { loadWarehousePlaneGroups, resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { requiresApproval } from '@/lib/agents/approval'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { warehouseCredentialStore, normalizeWarehouseHost } from '../credentials'
import { warehouseRequests } from '../tools'
import { fakeWarehouse, type ScriptStep } from './fake-warehouse'

/**
 * The warehouse planes end to end, minus the network and the database: the
 * credential store and the request factories are swapped for fakes, and
 * everything between — catalog, executor routing, host resolution, write
 * classification, the client protocols — is the real code.
 */

type Row = { id: string; allowedHost: string; userId: string | null; status: string; lastVerifiedAt: Date | null }

function useWarehouseFakes(rows: Row[], scripts: { databricks?: ScriptStep[]; snowflake?: ScriptStep[] } = {}) {
  const original = { rows: warehouseCredentialStore.rows, resolve: warehouseCredentialStore.resolve, ...warehouseRequests }
  const resolved: Array<{ id: string; consumer?: string }> = []
  const hostsUsed: string[] = []
  warehouseCredentialStore.rows = async (_org, where) => rows.filter((row) =>
    where.host ? row.allowedHost === where.host : where.kind ? row.allowedHost.includes(where.kind === 'databricks' ? 'databricks' : 'snowflake') : true)
  warehouseCredentialStore.resolve = async (id, _org, context) => {
    resolved.push({ id, consumer: context.consumer })
    const row = rows.find((candidate) => candidate.id === id)!
    return { id, name: id, authType: 'bearer', allowedHost: row.allowedHost, config: { token: 't' } }
  }
  const databricks = fakeWarehouse(scripts.databricks ?? [])
  const snowflake = fakeWarehouse(scripts.snowflake ?? [])
  warehouseRequests.databricks = (host) => { hostsUsed.push(host); return databricks.request }
  warehouseRequests.snowflake = (host) => { hostsUsed.push(host); return snowflake.request }
  const restore = () => {
    warehouseCredentialStore.rows = original.rows
    warehouseCredentialStore.resolve = original.resolve
    warehouseRequests.databricks = original.databricks
    warehouseRequests.snowflake = original.snowflake
  }
  return { resolved, hostsUsed, databricks, snowflake, restore }
}

const row = (id: string, allowedHost: string, userId: string | null = null): Row => ({ id, allowedHost, userId, status: 'verified', lastVerifiedAt: new Date(0) })

test('both warehouse planes are builtin, customer-facing and write planes at attachment time', () => {
  for (const providerId of ['databricks', 'snowflake']) {
    const descriptor = BUILTIN_CONNECTORS.find((c) => c.providerId === providerId)!
    assert.equal(descriptor.kind, 'builtin')
    assert.equal(descriptor.isWrite, true)
    assert.equal(descriptor.available(), true)
  }
  const previous = process.env.APP_EDITION
  process.env.APP_EDITION = 'customer'
  try {
    assert.equal(BUILTIN_CONNECTORS.find((c) => c.providerId === 'snowflake')!.available(), true)
    assert.equal(BUILTIN_CONNECTORS.find((c) => c.providerId === 'databricks')!.available(), true)
  } finally {
    if (previous === undefined) delete process.env.APP_EDITION
    else process.env.APP_EDITION = previous
  }
})

test('a Snowflake SELECT runs through resolveFlowToolExecutor as a read, on the only saved host', async () => {
  const fakes = useWarehouseFakes([row('cred-sf', 'acme.snowflakecomputing.com')], {
    snowflake: [{ match: /^\/api\/v2\/statements\?/, body: { statementHandle: 'h', resultSetMetaData: { numRows: 1, rowType: [{ name: 'N', type: 'fixed', scale: 0 }] }, data: [['3']] } }],
  })
  try {
    const args = { statement: 'select count(*) as n from accounts where region = ?', bindings: ['emea'] }
    const executor = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane: 'native', ref: 'snowflake', toolName: 'snowflake_sql_query', args })
    assert.equal(executor.provider, 'snowflake')
    assert.equal(executor.isWrite, false)
    const output = await executor.execute('snowflake_sql_query', args) as { rows: unknown[]; rowCount: number }
    assert.deepEqual(output.rows, [{ N: 3 }])
    assert.equal(output.rowCount, 1)
    assert.deepEqual(fakes.hostsUsed, ['acme.snowflakecomputing.com'])
    assert.deepEqual(fakes.resolved, [{ id: 'cred-sf', consumer: 'warehouse.snowflake' }])
  } finally {
    fakes.restore()
  }
})

test('a Databricks query and job run execute through the executor; DML and jobs are writes', async () => {
  const fakes = useWarehouseFakes([row('cred-db', 'dbc-1.cloud.databricks.com')], {
    databricks: [
      { match: /^\/api\/2\.0\/sql\/warehouses$/, body: { warehouses: [{ id: 'wh1', state: 'RUNNING' }] } },
      { match: /^\/api\/2\.0\/sql\/statements$/, body: { statement_id: 's', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'id' }, { name: 'name' }] } }, result: { data_array: [['1', 'Acme'], ['2', 'Beta']] } } },
      { match: /run-now$/, body: { run_id: 11 } },
      { match: /runs\/get\?run_id=11$/, body: { run_id: 11, state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } } },
    ],
  })
  try {
    const query = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane: 'native', ref: 'databricks', toolName: 'databricks_sql_query', args: { statement: 'SELECT id, name FROM main.crm.accounts' } })
    assert.equal(query.isWrite, false)
    const result = await query.execute('databricks_sql_query', { statement: 'SELECT id, name FROM main.crm.accounts', maxRows: 1 }) as { rows: unknown[]; truncated: boolean; rowCount: number; columns: string[] }
    assert.deepEqual(result.rows, [{ id: '1', name: 'Acme' }])
    assert.equal(result.truncated, true)
    assert.equal(result.rowCount, 2)
    assert.equal(JSON.parse(fakes.databricks.calls[1].body!).warehouse_id, 'wh1')

    const write = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane: 'native', ref: 'databricks', toolName: 'databricks_sql_query', args: { statement: 'DELETE FROM t' } })
    assert.equal(write.isWrite, true)

    const job = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane: 'native', ref: 'databricks', toolName: 'databricks_run_job', args: { jobId: '77' } })
    assert.equal(job.isWrite, true)
    const run = await job.execute('databricks_run_job', { jobId: '77' }) as { runId: number; completed: boolean }
    assert.deepEqual([run.runId, run.completed], [11, true])
  } finally {
    fakes.restore()
  }
})

test('without a credential the call fails with what to save; with several hosts it asks which', async () => {
  const none = useWarehouseFakes([])
  try {
    const executor = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane: 'native', ref: 'snowflake', toolName: 'snowflake_sql_query' })
    await assert.rejects(executor.execute('snowflake_sql_query', { statement: 'select 1' }), /No saved Snowflake credential\. Save a credential for <account>\.snowflakecomputing\.com in Integrations/)
    await assert.rejects(executor.execute('snowflake_sql_query', { statement: 'select 1', host: 'acme' }), /No saved Snowflake credential for acme\.snowflakecomputing\.com\. Save a credential for acme\.snowflakecomputing\.com in Integrations/)
  } finally {
    none.restore()
  }
  const two = useWarehouseFakes([row('a', 'dbc-1.cloud.databricks.com'), row('b', 'adb-2.azuredatabricks.net')])
  try {
    const executor = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane: 'native', ref: 'databricks', toolName: 'databricks_sql_query' })
    await assert.rejects(executor.execute('databricks_sql_query', { statement: 'select 1' }), /several hosts \(dbc-1\.cloud\.databricks\.com, adb-2\.azuredatabricks\.net\) — pass "host"/)
  } finally {
    two.restore()
  }
  assert.throws(() => normalizeWarehouseHost('api.github.com', 'databricks'), /not a Databricks host/)
  assert.equal(normalizeWarehouseHost('https://ACME.snowflakecomputing.com/console', 'snowflake'), 'acme.snowflakecomputing.com')
})

test('the acting person\'s own credential wins over one somebody else saved for the same host', async () => {
  const fakes = useWarehouseFakes([row('theirs', 'acme.snowflakecomputing.com', 'u2'), row('mine', 'acme.snowflakecomputing.com', 'u1')], {
    snowflake: [{ match: /statements\?/, body: { statementHandle: 'h', resultSetMetaData: { rowType: [] }, data: [] } }],
  })
  try {
    const executor = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane: 'native', ref: 'snowflake', toolName: 'snowflake_sql_query' })
    await executor.execute('snowflake_sql_query', { statement: 'select 1' })
    assert.equal(fakes.resolved[0].id, 'mine')
  } finally {
    fakes.restore()
  }
})

test('the catalog lists a plane with a credential as callable, and one without as needing a credential', async () => {
  const fakes = useWarehouseFakes([row('cred-db', 'dbc-1.cloud.databricks.com')])
  try {
    const catalog = await loadWarehousePlaneGroups('org')
    const databricks = catalog.find((group) => group.id === 'native:databricks')!
    const snowflake = catalog.find((group) => group.id === 'native:snowflake')!
    assert.ok(databricks.client)
    assert.equal(databricks.toolsError, undefined)
    assert.deepEqual(databricks.tools.map((tool) => tool.name), ['databricks_sql_query', 'databricks_run_job'])
    assert.equal(databricks.isWriteFor?.('databricks_sql_query', { statement: 'select 1' }), false)
    assert.equal(snowflake.client, undefined)
    assert.match(snowflake.toolsError!, /No saved Snowflake credential/)
    assert.deepEqual(snowflake.tools.map((tool) => tool.name), ['snowflake_sql_query'])

    // The agent path reports an attached-but-unconnected warehouse instead.
    const agent = await loadWarehousePlaneGroups('org', { providers: ['Snowflake'] })
    assert.equal(agent.length, 1)
    assert.equal(agent[0].client, undefined)
    assert.match(agent[0].toolsError!, /Save a credential for <account>\.snowflakecomputing\.com/)
  } finally {
    fakes.restore()
  }
})

test('warehouse writes route through the approval gate; reads never do', () => {
  const meta = { requireApproval: true }
  assert.equal(requiresApproval(meta, 'snowflake', true), true)
  assert.equal(requiresApproval(meta, 'databricks', true), true)
  assert.equal(requiresApproval(meta, 'snowflake', false), false)
  assert.equal(requiresApproval({}, 'databricks', true), false)
  assert.equal(requiresApproval({}, 'databricks', true, { injectionTainted: true }), true)
  // Other native planes are still never gated (the decider cannot run them).
  assert.equal(requiresApproval(meta, 'http', true), false)
})
