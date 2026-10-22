import { test } from 'node:test'
import assert from 'node:assert/strict'
import { n8nToFlow } from '@/lib/flows/import/from-n8n'
import { databricksToolFor } from '@/lib/flows/import/n8n-databricks'
import { DATABRICKS_TOOLS } from '@/lib/warehouse/tools'
import { toolArgumentIssues } from '@/lib/flows/tool-argument-validation'
import type { FlowNode } from '@/lib/flows/graph'

/**
 * Every n8n Databricks node operation (n8n-nodes-base Databricks v1) imports
 * onto its Databricks plane tool with its parameters carried over, and the
 * Jobs API called over HTTP lands on databricks_run_job. Lives apart from
 * from-n8n.test.ts, which is past the tsx size cliff.
 */

const n8nNode = (name: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id: `id-${name}`, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra })

const credentials = { databricksApi: { id: 'd', name: 'Databricks account' } }

/** Import one Databricks node after a manual trigger; return its step and the import notes. */
function importOne(parameters: Record<string, unknown>) {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [n8nNode('Start', 'n8n-nodes-base.manualTrigger'), n8nNode('DB', 'n8n-nodes-base.databricks', parameters, { credentials })],
    connections: { Start: { main: [[{ node: 'DB', type: 'main', index: 0 }]] } },
  })
  const node = result.graph.nodes.find((candidate) => candidate.id === 'id-DB') as FlowNode
  assert.equal(node.type, 'tool')
  const data = node.data as { connectionId: string; toolName: string; args: string; note?: string }
  return { ...data, parsed: JSON.parse(data.args) as Record<string, unknown>, notes: result.notes }
}

const rl = (value: string, mode = 'list') => ({ __rl: true, mode, value })

/** [resource, operation, n8n parameters, tool, expected args] for every n8n operation besides SQL. */
const CASES: Array<[string, string, Record<string, unknown>, string, Record<string, unknown>]> = [
  // Files
  ['files', 'uploadFile', { volumePath: 'main.default.landing', filePath: '={{ $json.name }}.csv', additionalFields: { overwrite: true } }, 'databricks_files_upload',
    { volumePath: 'main.default.landing', filePath: '{{trigger.input.name}}.csv', file: '{{trigger.input}}', overwrite: true }],
  ['files', 'downloadFile', { volumePath: 'main.default.landing', filePath: 'in/a.csv' }, 'databricks_files_download', { volumePath: 'main.default.landing', filePath: 'in/a.csv' }],
  ['files', 'deleteFile', { volumePath: 'main.default.landing', filePath: 'in/a.csv' }, 'databricks_files_delete', { volumePath: 'main.default.landing', filePath: 'in/a.csv' }],
  ['files', 'getFileInfo', { volumePath: 'main.default.landing', filePath: 'in/a.csv' }, 'databricks_files_get_metadata', { volumePath: 'main.default.landing', filePath: 'in/a.csv' }],
  ['files', 'listDirectory', { volumePath: 'main.default.landing', directoryPath: 'in', additionalFields: { pageSize: 100 } }, 'databricks_files_list', { volumePath: 'main.default.landing', directoryPath: 'in', pageSize: 100 }],
  ['files', 'createDirectory', { volumePath: 'main.default.landing', directoryPath: 'out/2026' }, 'databricks_files_mkdir', { volumePath: 'main.default.landing', directoryPath: 'out/2026' }],
  ['files', 'deleteDirectory', { volumePath: 'main.default.landing', directoryPath: 'out/2026' }, 'databricks_files_rmdir', { volumePath: 'main.default.landing', directoryPath: 'out/2026' }],
  // Genie
  ['genie', 'startConversation', { spaceId: 'sp1', initialMessage: '={{ $json.question }}' }, 'databricks_genie_ask', { spaceId: 'sp1', question: '{{trigger.input.question}}' }],
  ['genie', 'createMessage', { spaceId: 'sp1', conversationId: 'c1', message: 'And by region?' }, 'databricks_genie_ask', { spaceId: 'sp1', conversationId: 'c1', question: 'And by region?' }],
  ['genie', 'getMessage', { spaceId: 'sp1', conversationId: 'c1', messageId: 'm1' }, 'databricks_genie_get_message', { spaceId: 'sp1', conversationId: 'c1', messageId: 'm1' }],
  ['genie', 'getSpace', { spaceId: 'sp1' }, 'databricks_genie_get_space', { spaceId: 'sp1' }],
  ['genie', 'getQueryResults', { spaceId: 'sp1', conversationId: 'c1', messageId: 'm1', attachmentId: 'a1' }, 'databricks_genie_get_query_result', { spaceId: 'sp1', conversationId: 'c1', messageId: 'm1', attachmentId: 'a1' }],
  ['genie', 'executeMessageQuery', { spaceId: 'sp1', conversationId: 'c1', messageId: 'm1', attachmentId: 'a1' }, 'databricks_genie_execute_query', { spaceId: 'sp1', conversationId: 'c1', messageId: 'm1', attachmentId: 'a1' }],
  // Model Serving
  ['modelServing', 'queryEndpoint', { endpointName: rl('https://adb-1.2.azuredatabricks.net/ml/endpoints/churn-model', 'url'), requestBody: '={ "dataframe_records": [{ "account": "{{ $json.id }}" }] }' }, 'databricks_serving_query',
    { endpointName: 'churn-model', requestBody: { dataframe_records: [{ account: '{{trigger.input.id}}' }] } }],
  // Unity Catalog
  ['unityCatalog', 'listCatalogs', {}, 'databricks_unity_catalog_list', { objectType: 'catalog' }],
  ['unityCatalog', 'listTables', { catalogName: rl('main'), schemaName: rl('sales', 'string') }, 'databricks_unity_catalog_list', { objectType: 'table', catalog: 'main', schema: 'sales' }],
  ['unityCatalog', 'listVolumes', { catalogName: rl('main'), schemaName: rl('sales') }, 'databricks_unity_catalog_list', { objectType: 'volume', catalog: 'main', schema: 'sales' }],
  ['unityCatalog', 'listFunctions', { catalogName: rl('main'), schemaName: rl('sales') }, 'databricks_unity_catalog_list', { objectType: 'function', catalog: 'main', schema: 'sales' }],
  ['unityCatalog', 'getCatalog', { catalogName: rl('main') }, 'databricks_unity_catalog_get', { objectType: 'catalog', name: 'main' }],
  ['unityCatalog', 'getTable', { fullName: rl('main.sales.orders') }, 'databricks_unity_catalog_get', { objectType: 'table', fullName: 'main.sales.orders' }],
  ['unityCatalog', 'getVolume', { catalogName: rl('main'), schemaName: rl('sales'), volumeName: 'raw' }, 'databricks_unity_catalog_get', { objectType: 'volume', catalog: 'main', schema: 'sales', name: 'raw' }],
  ['unityCatalog', 'getFunction', { fullName: rl('main.sales.plus_one', 'string') }, 'databricks_unity_catalog_get', { objectType: 'function', fullName: 'main.sales.plus_one' }],
  ['unityCatalog', 'createCatalog', { catalogName: rl('sandbox', 'string'), comment: 'scratch' }, 'databricks_unity_catalog_create', { objectType: 'catalog', name: 'sandbox', comment: 'scratch' }],
  ['unityCatalog', 'createTable', { catalogName: rl('main'), schemaName: rl('sales'), tableName: 'events', storageLocation: 's3://b/events', tableAdditionalFields: { columns: '[{"name": "id", "type_name": "LONG"}]', comment: 'raw events' } }, 'databricks_unity_catalog_create',
    { objectType: 'table', catalog: 'main', schema: 'sales', name: 'events', storageLocation: 's3://b/events', columns: [{ name: 'id', type_name: 'LONG' }], comment: 'raw events' }],
  ['unityCatalog', 'createVolume', { catalogName: rl('main'), schemaName: rl('sales'), volumeName: 'ext', volumeType: 'EXTERNAL', additionalFields: { storage_location: 's3://b/ext' } }, 'databricks_unity_catalog_create',
    { objectType: 'volume', catalog: 'main', schema: 'sales', name: 'ext', volumeType: 'EXTERNAL', storageLocation: 's3://b/ext' }],
  ['unityCatalog', 'createFunction', { catalogName: rl('main'), schemaName: rl('sales'), functionName: 'plus_one', inputParams: '[{"name": "x", "type_name": "INT", "type_text": "INT"}]', returnType: 'INT', routineDefinition: 'RETURN x + 1' }, 'databricks_unity_catalog_create',
    { objectType: 'function', catalog: 'main', schema: 'sales', name: 'plus_one', inputParams: [{ name: 'x', type_name: 'INT', type_text: 'INT' }], returnType: 'INT', routineBody: 'SQL', routineDefinition: 'RETURN x + 1' }],
  ['unityCatalog', 'deleteCatalog', { catalogName: rl('sandbox') }, 'databricks_unity_catalog_delete', { objectType: 'catalog', name: 'sandbox' }],
  ['unityCatalog', 'deleteTable', { fullName: rl('main.sales.events') }, 'databricks_unity_catalog_delete', { objectType: 'table', fullName: 'main.sales.events' }],
  ['unityCatalog', 'deleteVolume', { catalogName: rl('main'), schemaName: rl('sales'), volumeName: 'ext' }, 'databricks_unity_catalog_delete', { objectType: 'volume', catalog: 'main', schema: 'sales', name: 'ext' }],
  ['unityCatalog', 'deleteFunction', { fullName: rl('main.sales.plus_one') }, 'databricks_unity_catalog_delete', { objectType: 'function', fullName: 'main.sales.plus_one' }],
  ['unityCatalog', 'updateCatalog', { catalogName: rl('main'), comment: '={{ $json.note }}' }, 'databricks_unity_catalog_update', { objectType: 'catalog', name: 'main', comment: '{{trigger.input.note}}' }],
  // Vector Search
  ['vectorSearch', 'queryIndex', { indexName: 'main.kb.docs', queryText: '={{ $json.q }}', columns: 'id, text', numResults: 5, enableReranking: true, columnsToRerank: 'text', options: { filterExpression: '{"lang": "en"}', scoreThreshold: 0.5 } }, 'databricks_vector_search_query',
    { indexName: 'main.kb.docs', queryText: '{{trigger.input.q}}', columns: ['id', 'text'], numResults: 5, searchMode: 'ANN', filtersJson: '{"lang": "en"}', scoreThreshold: 0.5, reranker: { model: 'databricks_reranker', columnsToRerank: ['text'] } }],
  ['vectorSearch', 'getIndex', { indexName: 'main.kb.docs' }, 'databricks_vector_search_get_index', { indexName: 'main.kb.docs' }],
  ['vectorSearch', 'listIndexes', { endpointName: 'vs-main' }, 'databricks_vector_search_list_indexes', { endpointName: 'vs-main' }],
  ['vectorSearch', 'createIndex', { indexName: 'main.kb.docs2', endpointName: 'vs-main', primaryKey: 'id', deltaSyncIndexSpec: '{"source_table": "main.kb.src", "pipeline_type": "TRIGGERED"}' }, 'databricks_vector_search_create_index',
    { indexName: 'main.kb.docs2', endpointName: 'vs-main', primaryKey: 'id', indexType: 'DELTA_SYNC', deltaSyncIndexSpec: { source_table: 'main.kb.src', pipeline_type: 'TRIGGERED' } }],
]

test('every n8n Databricks operation imports onto its tool with its parameters, valid against the tool schema', () => {
  assert.equal(CASES.length, 35, 'n8n v1 defines 36 operations: SQL executeQuery plus these 35')
  const schemas = new Map(DATABRICKS_TOOLS.map((tool) => [tool.name, tool.inputSchema]))
  for (const [resource, operation, parameters, toolName, expected] of CASES) {
    const step = importOne({ resource, operation, ...parameters })
    const label = `${resource}.${operation}`
    assert.equal(step.connectionId, 'native:databricks', label)
    assert.equal(step.toolName, toolName, label)
    assert.deepEqual(step.parsed, expected, label)
    assert.deepEqual(toolArgumentIssues(step.parsed, schemas.get(toolName)), [], `${label} args fit ${toolName}`)
    assert.equal(databricksToolFor(resource, operation), toolName)
    assert.ok(!step.notes.some((note) => note.code === 'UNMAPPED_OPERATION'), `${label} is not unmapped`)
    assert.ok(step.notes.some((note) => note.code === 'INTEGRATION_BOUND' && note.message.includes(toolName)), `${label} reports its tool`)
    assert.ok(step.notes.some((note) => note.code === 'WAREHOUSE_CREDENTIAL'), `${label} names the credential to save`)
  }
})

test('n8n\'s omitted defaults are n8n\'s own: each resource\'s default operation and parameter defaults', () => {
  assert.equal(importOne({ resource: 'files', volumePath: 'a.b.c' }).toolName, 'databricks_files_list')
  assert.equal(importOne({ resource: 'genie', spaceId: 's', initialMessage: 'hi' }).toolName, 'databricks_genie_ask')
  assert.equal(importOne({ resource: 'unityCatalog', catalogName: rl('main'), schemaName: rl('s') }).toolName, 'databricks_unity_catalog_list')
  assert.equal(importOne({ resource: 'vectorSearch', endpointName: 'vs' }).toolName, 'databricks_vector_search_list_indexes')
  const serving = importOne({ resource: 'modelServing', endpointName: rl('chat-model', 'name') })
  assert.deepEqual(serving.parsed, { endpointName: 'chat-model', requestBody: { messages: [{ role: 'user', content: 'Hello!' }] } })
  const vector = importOne({ resource: 'vectorSearch', operation: 'queryIndex', indexName: 'i', queryType: 'vector', queryVector: '[0.1, 0.2]', columns: 'id' })
  assert.deepEqual(vector.parsed, { indexName: 'i', queryVector: [0.1, 0.2], columns: ['id'], numResults: 10, searchMode: 'ANN' })
  const volume = importOne({ resource: 'unityCatalog', operation: 'createVolume', catalogName: rl('m'), schemaName: rl('s'), volumeName: 'v' })
  assert.equal(volume.parsed.volumeType, 'MANAGED')
})

test('expressions become flow tokens; a whole-value JSON expression stays one token the tool resolves', () => {
  const upload = importOne({ resource: 'files', operation: 'uploadFile', volumePath: '={{ $json.volume }}', filePath: 'x.bin', dataFieldName: 'attachment' })
  assert.deepEqual(upload.parsed, { volumePath: '{{trigger.input.volume}}', filePath: 'x.bin', file: '{{trigger.input}}', dataFieldName: 'attachment' })
  assert.match(upload.note ?? '', /binary field “attachment”/)
  const serving = importOne({ resource: 'modelServing', endpointName: rl('m', 'name'), requestBody: '={{ $json.payload }}' })
  assert.equal(serving.parsed.requestBody, '{{trigger.input.payload}}')
  const genie = importOne({ resource: 'genie', operation: 'startConversation', spaceId: 's', initialMessage: 'q' })
  assert.match(genie.note ?? '', /Waits for Genie's answer/)
})

test('an operation n8n does not define stays on the connection, flagged — never a silent passthrough', () => {
  const step = importOne({ resource: 'genie', operation: 'trashSpace', spaceId: 'sp1' })
  assert.equal(step.toolName, '')
  assert.equal(step.parsed.spaceId, 'sp1')
  const note = step.notes.find((entry) => entry.code === 'UNMAPPED_OPERATION')
  assert.equal(note?.severity, 'error')
  assert.match(note!.message, /Databricks genie\.trashSpace has no Backstory equivalent yet.*pick the matching databricks_\* action/)
  assert.equal(importOne({ resource: 'warehouses', operation: 'start' }).toolName, '')
})

test('HTTP calls to the Jobs API run as databricks_run_job: run-now carries the job and its parameters, runs/submit its spec', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Run', 'n8n-nodes-base.httpRequest', {
        method: 'POST',
        url: 'https://dbc-9.cloud.databricks.com/api/2.1/jobs/run-now',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'databricksApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={ "job_id": 812, "job_parameters": { "day": "{{ $json.day }}" }, "python_params": ["x"] }',
      }, { credentials }),
      n8nNode('Submit', 'n8n-nodes-base.httpRequest', {
        method: 'POST',
        url: 'https://adb-1.2.azuredatabricks.net/api/2.2/jobs/runs/submit',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '{ "run_name": "adhoc", "tasks": [{ "task_key": "t", "notebook_task": { "notebook_path": "/Shared/x" }, "existing_cluster_id": "c-1" }] }',
      }),
      n8nNode('Poll', 'n8n-nodes-base.httpRequest', { method: 'GET', url: '=https://dbc-9.cloud.databricks.com/api/2.1/jobs/runs/get?run_id={{ $json.run_id }}' }),
    ],
    connections: {
      Start: { main: [[{ node: 'Run', type: 'main', index: 0 }]] },
      Run: { main: [[{ node: 'Submit', type: 'main', index: 0 }]] },
      Submit: { main: [[{ node: 'Poll', type: 'main', index: 0 }]] },
    },
  })
  const step = (id: string) => {
    const node = result.graph.nodes.find((candidate) => candidate.id === id)!
    return { type: node.type, data: node.data as { toolName?: string; args?: string } }
  }
  const run = step('id-Run')
  assert.equal(run.data.toolName, 'databricks_run_job')
  assert.deepEqual(JSON.parse(run.data.args!), { jobId: '812', jobParameters: { day: '{{trigger.input.day}}' }, host: 'dbc-9.cloud.databricks.com' })
  assert.ok(result.notes.some((note) => note.code === 'WAREHOUSE_REVIEW' && /python_params are not carried/.test(note.message)))
  const submit = step('id-Submit')
  assert.equal(submit.data.toolName, 'databricks_run_job')
  assert.deepEqual(JSON.parse(submit.data.args!), { runSpec: { run_name: 'adhoc', tasks: [{ task_key: 't', notebook_task: { notebook_path: '/Shared/x' }, existing_cluster_id: 'c-1' }] }, host: 'adb-1.2.azuredatabricks.net' })
  assert.equal(step('id-Poll').type, 'http', 'a manual runs/get poll stays an HTTP step')
})

test('an agent\'s Databricks tool names the plane tool its operation runs as', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Agent', '@n8n/n8n-nodes-langchain.agent', { options: { systemMessage: 'Analyst.' } }),
      n8nNode('Model', '@n8n/n8n-nodes-langchain.lmChatAnthropic', { model: 'claude' }),
      n8nNode('Ask Genie', 'n8n-nodes-base.databricksTool', { resource: 'genie', operation: 'startConversation', spaceId: 'sp1' }, { credentials }),
    ],
    connections: {
      Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
      Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
      'Ask Genie': { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
    },
  })
  const [agent] = result.agents
  assert.ok(agent.integrations.includes('Databricks'))
  assert.match(JSON.stringify(agent), /databricks_genie_ask/)
})
