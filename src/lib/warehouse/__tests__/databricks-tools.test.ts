import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { extractFlowCapabilities } from '@/lib/flows/import/capabilities'
import type { FlowGraph } from '@/lib/flows/graph'
import { warehouseCredentialStore } from '../credentials'
import { DATABRICKS_TOOLS, warehouseRequests, warehouseToolIsWrite } from '../tools'
import { DATABRICKS_API_TOOLS, databricksFileStore } from '../databricks-tools'
import { DATABRICKS_READ_TOOLS, DATABRICKS_WRITE_TOOLS } from '../tool-classify'
import { fakeWarehouse, type ScriptStep } from './fake-warehouse'

/**
 * The workspace-API tools through the real executor path: credential lookup,
 * host resolution, classification and file storage are the real code with
 * their seams (credential store, request factory, file store) faked.
 */

type Row = { id: string; allowedHost: string; userId: string | null; status: string; lastVerifiedAt: Date | null }

function withDatabricks(script: ScriptStep[]) {
  const original = { rows: warehouseCredentialStore.rows, resolve: warehouseCredentialStore.resolve, databricks: warehouseRequests.databricks, files: { ...databricksFileStore } }
  const rows: Row[] = [{ id: 'db', allowedHost: 'dbc-7.cloud.databricks.com', userId: null, status: 'verified', lastVerifiedAt: null }]
  warehouseCredentialStore.rows = async (_org, where) => rows.filter((row) => !where.host || row.allowedHost === where.host)
  warehouseCredentialStore.resolve = async (id) => ({ id, name: id, authType: 'bearer', allowedHost: rows[0].allowedHost, config: { token: 't' } })
  const db = fakeWarehouse(script)
  warehouseRequests.databricks = () => db.request
  const stored = new Map<string, { filename: string; mimeType: string; bytes: Uint8Array }>()
  databricksFileStore.maxBytes = async () => 1_000
  databricksFileStore.save = async ({ filename, mimeType, bytes }) => {
    const fileId = `file_${stored.size + 1}_abcdefgh`
    stored.set(fileId, { filename, mimeType, bytes })
    return { fileId, filename, mimeType, size: bytes.byteLength, url: `/api/files/${fileId}`, ...(mimeType.startsWith('text/') ? { content: new TextDecoder().decode(bytes) } : {}) }
  }
  databricksFileStore.read = async (fileId) => stored.get(fileId) ?? null
  const restore = () => {
    warehouseCredentialStore.rows = original.rows
    warehouseCredentialStore.resolve = original.resolve
    warehouseRequests.databricks = original.databricks
    Object.assign(databricksFileStore, original.files)
  }
  return { db, stored, restore }
}

const run = async (toolName: string, args: Record<string, unknown>) => {
  const executor = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane: 'native', ref: 'databricks', toolName, args })
  return { isWrite: executor.isWrite, output: await executor.execute(toolName, args) as Record<string, unknown> }
}

test('every Databricks tool is classified: reads are list/get/query/download/ask, everything else a write', () => {
  const names = DATABRICKS_TOOLS.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names')
  for (const name of names.filter((entry) => entry !== 'databricks_sql_query')) {
    assert.ok(DATABRICKS_READ_TOOLS.has(name) !== DATABRICKS_WRITE_TOOLS.has(name), `${name} is in exactly one list`)
    const isRead = /_(list|get|query|download|ask|get_metadata|get_space|get_message|get_query_result|execute_query|get_index|list_indexes|list_endpoints)$/.test(name) || name === 'databricks_files_list'
    assert.equal(warehouseToolIsWrite(name), !isRead, `${name} classified ${isRead ? 'read' : 'write'}`)
  }
  assert.equal(warehouseToolIsWrite('databricks_something_new'), true, 'an unknown tool is a write')
  assert.equal(DATABRICKS_API_TOOLS.length, 27)
})

test('the import capability report agrees with the planes on Databricks reads and writes', () => {
  const step = (id: string, toolName: string): FlowGraph['nodes'][number] => ({ id, type: 'tool', data: { connectionId: 'native:databricks', toolName, args: '{}' } } as FlowGraph['nodes'][number])
  const graph = { nodes: [step('a', 'databricks_genie_ask'), step('b', 'databricks_files_upload'), step('c', 'databricks_unity_catalog_get')], edges: [] } as unknown as FlowGraph
  const capabilities = extractFlowCapabilities(graph)
  const writes = capabilities.filter((capability) => /write/i.test(capability.kind)).flatMap((capability) => capability.nodeIds)
  assert.ok(writes.includes('b'), JSON.stringify(capabilities))
  assert.ok(!writes.includes('a') && !writes.includes('c'), JSON.stringify(capabilities))
})

test('a download is saved as a stored file and answered as a file reference; an upload sends a stored file back', async () => {
  const fakes = withDatabricks([
    { match: /^\/api\/2\.0\/fs\/files\/Volumes\/main\/default\/landing\/in\/accounts\.csv$/, method: 'GET', body: 'id,name\n1,Acme', headers: { 'content-type': 'text/csv' } },
    { match: /^\/api\/2\.0\/fs\/files\/Volumes\/main\/default\/landing\/out\/accounts\.csv\?overwrite=true$/, method: 'PUT', body: '' },
    { match: /^\/api\/2\.0\/fs\/files\/Volumes\/main\/default\/landing\/out\/notes\.txt\?overwrite=false$/, method: 'PUT', body: '' },
  ])
  try {
    const download = await run('databricks_files_download', { volumePath: 'main.default.landing', filePath: 'in/accounts.csv' })
    assert.equal(download.isWrite, false)
    assert.equal(fakes.db.calls[0].maxBytes, 1_000, 'capped at the stored-file ceiling for its name')
    assert.deepEqual(
      [download.output.fileId, download.output.filename, download.output.mimeType, download.output.size, download.output.content, download.output.path],
      ['file_1_abcdefgh', 'accounts.csv', 'text/csv', 14, 'id,name\n1,Acme', '/Volumes/main/default/landing/in/accounts.csv'],
    )

    const upload = await run('databricks_files_upload', { volumePath: 'main.default.landing', filePath: 'out/accounts.csv', file: { output: download.output }, overwrite: 'true' })
    assert.equal(upload.isWrite, true)
    assert.equal(new TextDecoder().decode(fakes.db.calls[1].bytes), 'id,name\n1,Acme')
    assert.equal(fakes.db.calls[1].contentType, 'text/csv')

    await run('databricks_files_upload', { path: '/Volumes/main/default/landing/out/notes.txt', content: 'hello' })
    assert.equal(new TextDecoder().decode(fakes.db.calls[2].bytes), 'hello')
    await assert.rejects(run('databricks_files_upload', { volumePath: 'main.default.landing', filePath: 'x' }), /Pass the file to upload/)
    await assert.rejects(run('databricks_files_upload', { volumePath: 'main.default.landing', filePath: 'x', file: { fileId: 'file_missing_xyz' } }), /no longer available/)
  } finally {
    fakes.restore()
  }
})

test('Genie, serving, Unity Catalog and vector search tools run through the executor with JSON-text args', async () => {
  const fakes = withDatabricks([
    { match: /start-conversation$/, body: { conversation_id: 'c', message_id: 'm', message: { id: 'm', status: 'COMPLETED', attachments: [{ text: { content: 'Forty.' } }] } } },
    { match: /^\/serving-endpoints\/scorer\/invocations$/, body: { predictions: [0.3] } },
    { match: /^\/api\/2\.1\/unity-catalog\/catalogs$/, method: 'POST', body: { name: 'sandbox' } },
    { match: /^\/api\/2\.0\/vector-search\/indexes\/main\.kb\.idx\/query$/, body: { manifest: { columns: [{ name: 'id' }] }, result: { data_array: [['9']] } } },
  ])
  try {
    const genie = await run('databricks_genie_ask', { spaceId: 'sp', question: 'How many?' })
    assert.deepEqual([genie.isWrite, genie.output.text, genie.output.status], [false, 'Forty.', 'COMPLETED'])
    const serving = await run('databricks_serving_query', { endpointName: 'scorer', requestBody: '{"dataframe_records": [{"x": 1}]}' })
    assert.deepEqual([serving.isWrite, serving.output.predictions], [false, [0.3]])
    assert.deepEqual(JSON.parse(fakes.db.calls[1].body!), { dataframe_records: [{ x: 1 }] })
    const created = await run('databricks_unity_catalog_create', { objectType: 'catalog', name: 'sandbox', comment: 'scratch' })
    assert.equal(created.isWrite, true)
    const found = await run('databricks_vector_search_query', { indexName: 'main.kb.idx', queryText: 'q', columns: 'id, text', numResults: '3' })
    assert.deepEqual([found.isWrite, found.output.rows], [false, [{ id: '9' }]])
    assert.deepEqual(JSON.parse(fakes.db.calls[3].body!).columns, ['id', 'text'])
    await assert.rejects(run('databricks_unity_catalog_get', { objectType: 'warehouse', name: 'x' }), /objectType must be one of/)
  } finally {
    fakes.restore()
  }
})

test('a one-time run (runSpec) goes to runs/submit and the output carries run_id for n8n-shaped references', async () => {
  const fakes = withDatabricks([
    { match: /runs\/submit$/, body: { run_id: 31 } },
    { match: /runs\/get\?run_id=31$/, body: { run_id: 31, state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } } },
  ])
  try {
    const job = await run('databricks_run_job', { runSpec: '{"run_name": "adhoc", "tasks": [{"task_key": "t"}]}' })
    assert.deepEqual([job.isWrite, job.output.runId, job.output.run_id, job.output.completed], [true, 31, 31, true])
    await assert.rejects(run('databricks_run_job', {}), /numeric Databricks job id.*or a runSpec/)
  } finally {
    fakes.restore()
  }
})
