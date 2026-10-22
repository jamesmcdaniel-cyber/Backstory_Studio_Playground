import test from 'node:test'
import assert from 'node:assert/strict'
import {
  askGenie,
  downloadVolumeFile,
  executeGenieQuery,
  listVolumeDirectory,
  queryServingEndpoint,
  segment,
  unityCreate,
  unityDelete,
  unityGet,
  unityList,
  unityUpdate,
  uploadVolumeFile,
  vectorSearchCreateIndex,
  vectorSearchDeleteData,
  vectorSearchListIndexes,
  vectorSearchQuery,
  vectorSearchUpsert,
  volumeFileMetadata,
  volumeTarget,
} from '../databricks-api'
import { runDatabricksJob } from '../databricks'
import { fakeWarehouse, noSleep } from './fake-warehouse'

/** The Databricks workspace-API clients against a scripted workspace — no network. */

test('volume paths: catalog.schema.volume + inner path or a full /Volumes path, every segment encoded', () => {
  assert.deepEqual(volumeTarget({ volumePath: 'main.default.landing', inner: 'exports/a b.csv' }, 'file'), { catalog: 'main', schema: 'default', volume: 'landing', rest: ['exports', 'a b.csv'] })
  assert.deepEqual(volumeTarget({ path: '/Volumes/main/default/landing/x.csv' }, 'file'), { catalog: 'main', schema: 'default', volume: 'landing', rest: ['x.csv'] })
  assert.deepEqual(volumeTarget({ volumePath: 'main.default.landing' }, 'directory').rest, [])
  assert.throws(() => volumeTarget({ volumePath: 'main.landing', inner: 'x' }, 'file'), /catalog\.schema\.volume/)
  assert.throws(() => volumeTarget({ volumePath: 'main.default.landing' }, 'file'), /file path inside the volume/)
  assert.throws(() => volumeTarget({ path: '/tmp/x' }, 'file'), /not a volume path/)
})

test('a dot segment can never walk a request to another API on the host', async () => {
  assert.equal(segment('a b/c'.replace('/', ''), 'x'), 'a%20bc')
  for (const bad of ['..', '.', '%2e%2E', '%2E', 'a/b', 'a\\b', '']) assert.throws(() => segment(bad, 'path segment'), /path segment/)
  const db = fakeWarehouse([])
  await assert.rejects(downloadVolumeFile(db.request, volumeTarget({ volumePath: 'main.default.v', inner: '../../../api/2.0/token/create' }, 'file'), 1000), /not a valid path segment/)
  await assert.rejects(unityGet(db.request, 'table', { fullName: '..' }), /not a valid table name/)
  assert.equal(db.calls.length, 0, 'nothing was sent')
})

test('files: upload sends raw bytes with the overwrite flag; download is binary and capped; list/metadata read', async () => {
  const db = fakeWarehouse([
    { match: /^\/api\/2\.0\/fs\/files\/Volumes\/main\/default\/landing\/out\/report%201\.csv\?overwrite=true$/, method: 'PUT', body: '' },
    { match: /^\/api\/2\.0\/fs\/files\/Volumes\/main\/default\/landing\/in\/data\.json$/, method: 'GET', body: '{"a":1}', headers: { 'content-type': 'application/octet-stream' } },
    { match: /^\/api\/2\.0\/fs\/directories\/Volumes\/main\/default\/landing\?page_size=50$/, method: 'GET', body: { contents: [{ path: '/Volumes/main/default/landing/in', is_directory: true }] } },
    { match: /^\/api\/2\.0\/fs\/files\/Volumes\/main\/default\/landing\/in\/data\.json$/, method: 'HEAD', body: '', headers: { 'content-length': '7', 'content-type': 'application/json', 'last-modified': 'Tue, 21 Oct 2026 10:00:00 GMT' } },
  ])
  await uploadVolumeFile(db.request, volumeTarget({ volumePath: 'main.default.landing', inner: 'out/report 1.csv' }, 'file'), new TextEncoder().encode('a,b\n1,2'), { contentType: 'text/csv', overwrite: true })
  assert.equal(new TextDecoder().decode(db.calls[0].bytes), 'a,b\n1,2')
  assert.equal(db.calls[0].contentType, 'text/csv')

  const file = await downloadVolumeFile(db.request, volumeTarget({ volumePath: 'main.default.landing', inner: 'in/data.json' }, 'file'), 5_000)
  assert.equal(new TextDecoder().decode(file.bytes), '{"a":1}')
  assert.equal(file.contentType, 'application/json', 'octet-stream is replaced by the type the name implies')
  assert.equal(file.fileName, 'data.json')
  assert.deepEqual([db.calls[1].binary, db.calls[1].maxBytes], [true, 5_000])

  const listed = await listVolumeDirectory(db.request, volumeTarget({ volumePath: 'main.default.landing' }, 'directory'), { pageSize: 50 })
  assert.equal((listed.contents as unknown[]).length, 1)
  assert.deepEqual(await volumeFileMetadata(db.request, volumeTarget({ path: '/Volumes/main/default/landing/in/data.json' }, 'file')), {
    path: '/Volumes/main/default/landing/in/data.json', contentLength: 7, contentType: 'application/json', lastModified: 'Tue, 21 Oct 2026 10:00:00 GMT',
  })
})

test('a refused upload reports Databricks\' reason and the credential hint', async () => {
  const db = fakeWarehouse([{ match: /fs\/files/, status: 409, body: { error_code: 'ALREADY_EXISTS', message: 'The file being created already exists.' } }])
  await assert.rejects(uploadVolumeFile(db.request, volumeTarget({ volumePath: 'a.b.c', inner: 'x' }, 'file'), new Uint8Array([1]), {}), /Uploading the file failed \(HTTP 409\): ALREADY_EXISTS: The file being created already exists/)
  const denied = fakeWarehouse([{ match: /fs\/directories/, status: 403, body: { error_code: 'PERMISSION_DENIED', message: 'no WRITE VOLUME' } }])
  await assert.rejects(listVolumeDirectory(denied.request, volumeTarget({ volumePath: 'a.b.c' }, 'directory'), {}), /HTTP 403.*no WRITE VOLUME.*saved HTTP credential/)
})

test('Genie: a question is asked, polled through its working states to COMPLETED, and its rows fetched', async () => {
  const message = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'm1', conversation_id: 'c1', status, ...extra })
  const db = fakeWarehouse([
    { match: /^\/api\/2\.0\/genie\/spaces\/sp1\/start-conversation$/, method: 'POST', body: { conversation_id: 'c1', message_id: 'm1', message: message('SUBMITTED') } },
    { match: /^\/api\/2\.0\/genie\/spaces\/sp1\/conversations\/c1\/messages\/m1$/, method: 'GET', body: message('ASKING_AI') },
    { match: /messages\/m1$/, method: 'GET', body: message('EXECUTING_QUERY') },
    { match: /messages\/m1$/, method: 'GET', body: message('COMPLETED', { attachments: [{ attachment_id: 'a1', query: { query: 'SELECT region, sum(arr) FROM t GROUP BY 1', description: 'ARR by region' } }, { attachment_id: 'a2', text: { content: 'EMEA leads.' } }] }) },
    { match: /^\/api\/2\.0\/genie\/spaces\/sp1\/conversations\/c1\/messages\/m1\/attachments\/a1\/query-result$/, method: 'GET', body: { statement_response: { statement_id: 's', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'region' }, { name: 'arr' }] } }, result: { data_array: [['EMEA', '9'], ['AMER', '7'], ['APAC', '3']] } } } },
  ])
  const sleeps: number[] = []
  const answer = await askGenie({ request: db.request, spaceId: 'sp1', question: 'Which region leads ARR?', maxRows: 2, sleep: async (ms) => { sleeps.push(ms) } })
  assert.equal(JSON.parse(db.calls[0].body!).content, 'Which region leads ARR?')
  assert.equal(sleeps.length, 3)
  assert.equal(answer.status, 'COMPLETED')
  assert.deepEqual([answer.conversation_id, answer.message_id, answer.attachmentId], ['c1', 'm1', 'a1'])
  assert.equal(answer.text, 'EMEA leads.')
  assert.equal(answer.sql, 'SELECT region, sum(arr) FROM t GROUP BY 1')
  assert.deepEqual(answer.result, { columns: ['region', 'arr'], rows: [{ region: 'EMEA', arr: '9' }, { region: 'AMER', arr: '7' }], rowCount: 3, truncated: true })
})

test('Genie: a follow-up goes to the conversation; FAILED throws Genie\'s reason; a slow answer times out with its ids', async () => {
  const failed = fakeWarehouse([
    { match: /^\/api\/2\.0\/genie\/spaces\/sp1\/conversations\/c9\/messages$/, method: 'POST', body: { id: 'm2', conversation_id: 'c9', status: 'FETCHING_METADATA' } },
    { match: /messages\/m2$/, body: { id: 'm2', conversation_id: 'c9', status: 'FAILED', error: { error: 'Warehouse is stopped', type: 'WAREHOUSE_ACCESS_MISSING_EXCEPTION' } } },
  ])
  await assert.rejects(askGenie({ request: failed.request, spaceId: 'sp1', conversationId: 'c9', question: 'and last year?', maxRows: 10, sleep: noSleep }), /Genie's answer failed: Warehouse is stopped \(conversation c9, message m2\)/)

  let clock = 0
  const slow = fakeWarehouse([
    { match: /start-conversation$/, body: { conversation_id: 'c1', message_id: 'm1', message: { id: 'm1', status: 'SUBMITTED' } } },
    { match: /messages\/m1$/, body: { id: 'm1', status: 'ASKING_AI' } },
    { match: /messages\/m1$/, body: { id: 'm1', status: 'ASKING_AI' } },
  ])
  await assert.rejects(
    askGenie({ request: slow.request, spaceId: 'sp1', question: 'q', maxRows: 10, deadlineMs: 60_000, sleep: async () => { clock += 40_000 }, now: () => clock }),
    /still asking ai after 1 minutes \(conversation c1, message m1\).*databricks_genie_get_message/,
  )

  const noWait = fakeWarehouse([{ match: /start-conversation$/, body: { conversation_id: 'c1', message_id: 'm1', message: { id: 'm1', status: 'SUBMITTED' } } }])
  const accepted = await askGenie({ request: noWait.request, spaceId: 'sp1', question: 'q', maxRows: 10, waitForCompletion: false })
  assert.deepEqual([accepted.status, accepted.messageId, noWait.calls.length], ['SUBMITTED', 'm1', 1])
})

test('Genie attachment queries re-run with POST execute-query', async () => {
  const db = fakeWarehouse([{ match: /^\/api\/2\.0\/genie\/spaces\/s\/conversations\/c\/messages\/m\/attachments\/a\/execute-query$/, method: 'POST', body: { statement_response: { manifest: { schema: { columns: [] } } } } }])
  await executeGenieQuery(db.request, { spaceId: 's', conversationId: 'c', messageId: 'm', attachmentId: 'a' })
  assert.equal(db.calls.length, 1)
})

test('Model Serving posts the body to /invocations and tags the answer with its endpoint', async () => {
  const db = fakeWarehouse([{ match: /^\/serving-endpoints\/databricks-claude\/invocations$/, method: 'POST', body: { choices: [{ message: { content: 'hi' } }] } }])
  const out = await queryServingEndpoint(db.request, 'databricks-claude', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 50 })
  assert.deepEqual(JSON.parse(db.calls[0].body!), { messages: [{ role: 'user', content: 'hello' }], max_tokens: 50 })
  assert.deepEqual(out._metadata, { endpoint: 'databricks-claude' })
  await assert.rejects(queryServingEndpoint(db.request, '../x', {}), /not a serving endpoint name/)
})

test('Unity Catalog: list needs its parents, get/delete use the full name, create sends n8n\'s bodies', async () => {
  const db = fakeWarehouse([
    { match: /^\/api\/2\.1\/unity-catalog\/catalogs$/, body: { catalogs: [{ name: 'main' }] } },
    { match: /^\/api\/2\.1\/unity-catalog\/tables\?catalog_name=main&schema_name=sales&max_results=5$/, body: { tables: [] } },
    { match: /^\/api\/2\.1\/unity-catalog\/tables\/main\.sales\.orders$/, method: 'GET', body: { name: 'orders', columns: [] } },
    { match: /^\/api\/2\.1\/unity-catalog\/volumes$/, method: 'POST', body: { full_name: 'main.sales.raw' } },
    { match: /^\/api\/2\.1\/unity-catalog\/functions$/, method: 'POST', body: {} },
    { match: /^\/api\/2\.1\/unity-catalog\/catalogs\/main$/, method: 'PATCH', body: { name: 'main', comment: 'prod' } },
    { match: /^\/api\/2\.1\/unity-catalog\/schemas\/main\.old\?force=true$/, method: 'DELETE', body: '' },
  ])
  await unityList(db.request, 'catalog', {})
  await unityList(db.request, 'table', { schema: 'main.sales', maxResults: 5 })
  await assert.rejects(unityList(db.request, 'volume', { catalog: 'main' }), /needs the catalog and the schema/)
  await unityGet(db.request, 'table', { catalog: 'main', schema: 'sales', name: 'orders' })
  await unityCreate(db.request, 'volume', { catalog: 'main', schema: 'sales', name: 'raw', comment: 'landing' })
  assert.deepEqual(JSON.parse(db.calls[3].body!), { catalog_name: 'main', schema_name: 'sales', name: 'raw', volume_type: 'MANAGED', comment: 'landing' })
  await unityCreate(db.request, 'function', { catalog: 'main', schema: 'sales', name: 'plus_one', inputParams: [{ name: 'x', type_name: 'INT' }], routineDefinition: 'RETURN x + 1', returnType: 'INT' })
  const fn = JSON.parse(db.calls[4].body!).function_info
  assert.deepEqual([fn.name, fn.data_type, fn.routine_body, fn.input_params.parameters[0].type_text, fn.input_params.parameters[0].type_json], ['plus_one', 'INT', 'SQL', 'INT', '{"name":"INT"}'])
  await assert.rejects(unityCreate(db.request, 'table', { catalog: 'main', schema: 'sales', name: 't' }), /needs storageLocation/)
  await assert.rejects(unityCreate(db.request, 'volume', { catalog: 'main', schema: 'sales', name: 'v', volumeType: 'EXTERNAL' }), /EXTERNAL volume needs storageLocation/)
  await unityUpdate(db.request, 'catalog', { name: 'main', comment: 'prod' })
  assert.deepEqual(JSON.parse(db.calls[5].body!), { comment: 'prod' })
  await assert.rejects(unityUpdate(db.request, 'table', { fullName: 'a.b.c', comment: 'x' }), /catalogs and schemas/)
  assert.deepEqual(await unityDelete(db.request, 'schema', { catalog: 'main', name: 'old', force: true }), { success: true, objectType: 'schema', fullName: 'main.old' })
  assert.equal(db.remaining.length, 0)
})

test('Vector Search: a text query answers records; index list/create/upsert/delete hit their endpoints', async () => {
  const db = fakeWarehouse([
    { match: /^\/api\/2\.0\/vector-search\/indexes\/main\.docs\.idx\/query$/, method: 'POST', body: { manifest: { column_count: 3, columns: [{ name: 'id' }, { name: 'text' }, { name: 'score' }] }, result: { row_count: 2, data_array: [['1', 'alpha', 0.9], ['2', 'beta', 0.7]] } } },
    { match: /^\/api\/2\.0\/vector-search\/indexes\?endpoint_name=vs1$/, method: 'GET', body: { vector_indexes: [] } },
    { match: /^\/api\/2\.0\/vector-search\/indexes$/, method: 'POST', body: { name: 'main.docs.idx2' } },
    { match: /^\/api\/2\.0\/vector-search\/indexes\/main\.docs\.idx\/upsert-data$/, method: 'POST', body: { status: 'SUCCESS' } },
    { match: /^\/api\/2\.0\/vector-search\/indexes\/main\.docs\.idx\/delete-data\?primary_keys=1&primary_keys=2$/, method: 'DELETE', body: { status: 'SUCCESS' } },
  ])
  const found = await vectorSearchQuery(db.request, { indexName: 'main.docs.idx', queryText: 'renewal risk', columns: ['id', 'text'], numResults: 5, searchMode: 'hybrid', filtersJson: '{"lang": "en"}', reranker: { columnsToRerank: ['text'] } }, 1)
  assert.deepEqual(JSON.parse(db.calls[0].body!), { num_results: 5, query_type: 'HYBRID', columns: ['id', 'text'], query_text: 'renewal risk', filters_json: '{"lang": "en"}', reranker: { model: 'databricks_reranker', parameters: { columns_to_rerank: ['text'] } } })
  assert.deepEqual([found.rows, found.rowCount, found.truncated], [[{ id: '1', text: 'alpha', score: 0.9 }], 2, true])
  await vectorSearchListIndexes(db.request, 'vs1')
  await vectorSearchCreateIndex(db.request, { indexName: 'main.docs.idx2', endpointName: 'vs1', primaryKey: 'id', indexType: 'DIRECT_ACCESS', directAccessIndexSpec: { embedding_vector_columns: [{ name: 'e', embedding_dimension: 3 }] } })
  assert.deepEqual(Object.keys(JSON.parse(db.calls[2].body!)), ['name', 'endpoint_name', 'primary_key', 'index_type', 'direct_access_index_spec'])
  await vectorSearchUpsert(db.request, 'main.docs.idx', [{ id: '3', e: [0.1, 0.2, 0.3] }])
  assert.equal(JSON.parse(db.calls[3].body!).inputs_json, '[{"id":"3","e":[0.1,0.2,0.3]}]')
  await vectorSearchDeleteData(db.request, 'main.docs.idx', ['1', '2'])
  await assert.rejects(vectorSearchQuery(db.request, { indexName: 'i', columns: [], numResults: 1 }, 10), /columns to return/)
})

test('a one-time job run is submitted with its spec and polled like a saved job', async () => {
  const db = fakeWarehouse([
    { match: /^\/api\/2\.1\/jobs\/runs\/submit$/, method: 'POST', body: { run_id: 5 } },
    { match: /runs\/get\?run_id=5$/, body: { run_id: 5, state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } } },
  ])
  const spec = { run_name: 'backfill', tasks: [{ task_key: 't', notebook_task: { notebook_path: '/Shared/backfill' }, existing_cluster_id: 'c-1' }] }
  const run = await runDatabricksJob({ runSpec: spec, request: db.request, sleep: noSleep })
  assert.deepEqual(JSON.parse(db.calls[0].body!), spec)
  assert.deepEqual([run.runId, run.completed], [5, true])
  await assert.rejects(runDatabricksJob({ request: db.request }), /job id to run, or a run specification/)
})
