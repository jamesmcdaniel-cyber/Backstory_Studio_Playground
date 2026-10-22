import { test } from 'node:test'
import assert from 'node:assert/strict'
import { n8nToFlow } from '@/lib/flows/import/from-n8n'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { loadWarehousePlaneGroups, resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { resolveTemplateValue, type FlowContext } from '@/features/flows/context'
import { prepareToolArgs } from '@/features/flows/tool-args'
import { warehouseCredentialStore } from '@/lib/warehouse/credentials'
import { warehouseRequests } from '@/lib/warehouse/tools'
import { databricksFileStore } from '@/lib/warehouse/databricks-tools'
import { fakeWarehouse } from '@/lib/warehouse/__tests__/fake-warehouse'

/**
 * End to end, minus the network and the database: an n8n workflow using one
 * operation from each Databricks group — Files, Genie, Model Serving, Unity
 * Catalog, Vector Search — plus a Jobs API call over HTTP is imported,
 * validated the way a run validates it (blocked without a credential, clean
 * with one), and every step is resolved and executed through
 * resolveFlowToolExecutor against a scripted workspace.
 */

const node = (name: string, type: string, parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, type, typeVersion: 1, position: [0, 0], parameters, ...extra })
const credentials = { databricksApi: { id: '8', name: 'Databricks account' } }

const WORKFLOW = {
  name: 'Weekly account digest',
  nodes: [
    node('Every Monday', 'n8n-nodes-base.scheduleTrigger', { rule: { interval: [{ field: 'weeks', triggerAtDay: [1], triggerAtHour: 8 }] } }),
    node('Fetch extract', 'n8n-nodes-base.databricks', { resource: 'files', operation: 'downloadFile', volumePath: 'main.default.landing', filePath: 'exports/accounts.csv' }, { credentials }),
    node('Ask Genie', 'n8n-nodes-base.databricks', { resource: 'genie', operation: 'startConversation', spaceId: '01ef-genie', initialMessage: '=Which accounts in {{ $json.fileName }} grew fastest?' }, { credentials }),
    node('Score churn', 'n8n-nodes-base.databricks', {
      resource: 'modelServing', operation: 'queryEndpoint',
      endpointName: { __rl: true, mode: 'list', value: 'churn-model' },
      requestBody: '={ "dataframe_records": [{ "question": "{{ $json.message_id }}" }] }',
    }, { credentials }),
    node('Describe table', 'n8n-nodes-base.databricks', { resource: 'unityCatalog', operation: 'getTable', fullName: { __rl: true, mode: 'string', value: 'main.sales.accounts' } }, { credentials }),
    node('Find playbooks', 'n8n-nodes-base.databricks', { resource: 'vectorSearch', operation: 'queryIndex', indexName: 'main.kb.playbooks', queryText: 'expansion playbook', columns: 'id, title' }, { credentials }),
    node('Refresh dashboard', 'n8n-nodes-base.httpRequest', {
      method: 'POST', url: 'https://dbc-5f3e.cloud.databricks.com/api/2.1/jobs/run-now',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'databricksApi',
      sendBody: true, specifyBody: 'json', jsonBody: '{ "job_id": 4242 }',
    }, { credentials }),
  ],
  connections: {
    'Every Monday': { main: [[{ node: 'Fetch extract', type: 'main', index: 0 }]] },
    'Fetch extract': { main: [[{ node: 'Ask Genie', type: 'main', index: 0 }]] },
    'Ask Genie': { main: [[{ node: 'Score churn', type: 'main', index: 0 }]] },
    'Score churn': { main: [[{ node: 'Describe table', type: 'main', index: 0 }]] },
    'Describe table': { main: [[{ node: 'Find playbooks', type: 'main', index: 0 }]] },
    'Find playbooks': { main: [[{ node: 'Refresh dashboard', type: 'main', index: 0 }]] },
  },
}

type Row = { id: string; allowedHost: string; userId: string | null; status: string; lastVerifiedAt: Date | null }

function withCredentials(rows: Row[]) {
  const original = { rows: warehouseCredentialStore.rows, resolve: warehouseCredentialStore.resolve, databricks: warehouseRequests.databricks, files: { ...databricksFileStore } }
  warehouseCredentialStore.rows = async (_org, where) => rows.filter((row) => (where.host ? row.allowedHost === where.host : !where.kind || where.kind === 'databricks'))
  warehouseCredentialStore.resolve = async (id) => ({ id, name: id, authType: 'bearer', allowedHost: rows.find((row) => row.id === id)!.allowedHost, config: { token: 't' } })
  return () => {
    warehouseCredentialStore.rows = original.rows
    warehouseCredentialStore.resolve = original.resolve
    warehouseRequests.databricks = original.databricks
    Object.assign(databricksFileStore, original.files)
  }
}

async function catalogFor(connectionIds: string[]) {
  const refs = connectionIds.map(parseFlowToolConnectionId).filter((id) => id.plane === 'native').map((id) => id.ref)
  return (await loadWarehousePlaneGroups('org', { providers: refs, userId: 'u1' })).map((group) => ({
    id: group.id,
    name: group.name,
    ...(group.toolsError ? { toolsError: group.toolsError } : {}),
    tools: group.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
  }))
}

const CREDENTIAL: Row = { id: 'db', allowedHost: 'dbc-5f3e.cloud.databricks.com', userId: null, status: 'verified', lastVerifiedAt: null }

test('one operation from each Databricks group imports as a runnable step and validates once a credential exists', async () => {
  const result = n8nToFlow(WORKFLOW)
  const graph = flowGraphSchema.parse(result.graph)
  const tools = graph.nodes.filter((entry) => entry.type === 'tool') as Array<{ id: string; data: { connectionId: string; toolName: string } }>
  assert.deepEqual(tools.map((entry) => [entry.id, entry.data.connectionId, entry.data.toolName]), [
    ['fetch-extract', 'native:databricks', 'databricks_files_download'],
    ['ask-genie', 'native:databricks', 'databricks_genie_ask'],
    ['score-churn', 'native:databricks', 'databricks_serving_query'],
    ['describe-table', 'native:databricks', 'databricks_unity_catalog_get'],
    ['find-playbooks', 'native:databricks', 'databricks_vector_search_query'],
    ['refresh-dashboard', 'native:databricks', 'databricks_run_job'],
  ])
  assert.ok(!result.notes.some((note) => note.code === 'UNMAPPED_OPERATION'), 'nothing left unmapped')
  assert.ok(!graph.nodes.some((entry) => entry.type === 'http'), 'no hand-auth HTTP step left')

  const connectionIds = tools.map((entry) => entry.data.connectionId)
  let restore = withCredentials([])
  try {
    const blocked = validateFlowGraph(graph, { toolCatalog: await catalogFor(connectionIds) })
    assert.equal(blocked.errors.filter((issue) => issue.code === 'TOOL_CONNECTION_UNAVAILABLE').length, 6, JSON.stringify(blocked.errors))
  } finally {
    restore()
  }
  restore = withCredentials([CREDENTIAL])
  try {
    const validation = validateFlowGraph(graph, { toolCatalog: await catalogFor(connectionIds) })
    assert.deepEqual(validation.errors, [])
  } finally {
    restore()
  }
})

test('every imported Databricks step resolves to its tool, is classified, and runs against the workspace', async () => {
  const graph = flowGraphSchema.parse(n8nToFlow(WORKFLOW).graph)
  const restore = withCredentials([CREDENTIAL])
  const db = fakeWarehouse([
    { match: /^\/api\/2\.0\/fs\/files\/Volumes\/main\/default\/landing\/exports\/accounts\.csv$/, method: 'GET', body: 'id,arr\n001,90', headers: { 'content-type': 'text/csv' } },
    { match: /^\/api\/2\.0\/genie\/spaces\/01ef-genie\/start-conversation$/, method: 'POST', body: { conversation_id: 'c1', message_id: 'm1', message: { id: 'm1', status: 'EXECUTING_QUERY' } } },
    { match: /conversations\/c1\/messages\/m1$/, method: 'GET', body: { id: 'm1', status: 'COMPLETED', attachments: [{ attachment_id: 'a1', query: { query: 'SELECT 1' } }] } },
    { match: /messages\/m1\/attachments\/a1\/query-result$/, method: 'GET', body: { statement_response: { manifest: { schema: { columns: [{ name: 'account' }] } }, result: { data_array: [['001']] } } } },
    { match: /^\/serving-endpoints\/churn-model\/invocations$/, method: 'POST', body: { predictions: [0.12] } },
    { match: /^\/api\/2\.1\/unity-catalog\/tables\/main\.sales\.accounts$/, method: 'GET', body: { full_name: 'main.sales.accounts', columns: [{ name: 'id' }] } },
    { match: /^\/api\/2\.0\/vector-search\/indexes\/main\.kb\.playbooks\/query$/, method: 'POST', body: { manifest: { columns: [{ name: 'id' }, { name: 'title' }, { name: 'score' }] }, result: { data_array: [['p1', 'Land and expand', 0.8]] } } },
    { match: /^\/api\/2\.1\/jobs\/run-now$/, method: 'POST', body: { run_id: 99 } },
    { match: /runs\/get\?run_id=99$/, body: { run_id: 99, state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } } },
  ])
  const hosts: string[] = []
  warehouseRequests.databricks = (host) => { hosts.push(host); return db.request }
  databricksFileStore.maxBytes = async () => 10_000_000
  databricksFileStore.save = async ({ filename, mimeType, bytes }) => ({ fileId: 'f1', filename, mimeType, size: bytes.byteLength, url: '/api/files/f1', content: new TextDecoder().decode(bytes) })
  try {
    const ctx: FlowContext = { trigger: { input: {} }, step: {} }
    const outputs: Record<string, Record<string, unknown>> = {}
    const writes: string[] = []
    for (const entry of graph.nodes) {
      if (entry.type !== 'tool') continue
      const data = entry.data as { connectionId: string; toolName: string; args: string }
      const args = prepareToolArgs(resolveTemplateValue(JSON.parse(data.args), ctx))
      const { plane, ref } = parseFlowToolConnectionId(data.connectionId)
      const executor = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane, ref, toolName: data.toolName, args, approval: 'gate' })
      if (executor.isWrite) writes.push(entry.id)
      outputs[entry.id] = await executor.execute(data.toolName, args) as Record<string, unknown>
      ctx.step[entry.id] = { output: outputs[entry.id] }
    }
    assert.deepEqual(writes, ['refresh-dashboard'], 'only the job run is a write (it goes through approval)')
    assert.deepEqual([outputs['fetch-extract'].fileId, outputs['fetch-extract'].content], ['f1', 'id,arr\n001,90'])
    assert.equal(JSON.parse(db.calls[1].body!).content, 'Which accounts in accounts.csv grew fastest?', 'an expression over the previous step carried over')
    assert.deepEqual((outputs['ask-genie'].result as { rows: unknown[] }).rows, [{ account: '001' }])
    assert.deepEqual(JSON.parse(db.calls[4].body!), { dataframe_records: [{ question: 'm1' }] })
    assert.deepEqual(outputs['score-churn'].predictions, [0.12])
    assert.equal(outputs['describe-table'].full_name, 'main.sales.accounts')
    assert.deepEqual(outputs['find-playbooks'].rows, [{ id: 'p1', title: 'Land and expand', score: 0.8 }])
    assert.deepEqual([outputs['refresh-dashboard'].runId, outputs['refresh-dashboard'].completed], [99, true])
    assert.equal(JSON.parse(db.calls[7].body!).job_id, 4242)
    assert.ok(hosts.every((host) => host === 'dbc-5f3e.cloud.databricks.com'))
    assert.equal(db.remaining.length, 0)
  } finally {
    restore()
  }
})
