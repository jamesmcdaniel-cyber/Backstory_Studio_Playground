import { test } from 'node:test'
import assert from 'node:assert/strict'
import { n8nToFlow } from '@/lib/flows/import/from-n8n'
import { parameterizeN8nSql, splitQueryReplacement, escapeSnowflakeObjectIdentifier } from '@/lib/flows/import/n8n-warehouse'
import { bindAgentEndpointAuth, resolveWarehouseCredentialNotes } from '@/lib/flows/import/bind-imported-auth'
import { flowGraphSchema, type FlowNode } from '@/lib/flows/graph'

/**
 * The n8n importer's warehouse mappings: the Snowflake and Databricks nodes,
 * raw HTTP calls to either statements API, and an agent's HTTP / warehouse
 * tools. (from-n8n.test.ts is past the tsx size cliff, so these live here.)
 */

const n8nNode = (name: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id: `id-${name}`, name, type, typeVersion: 1, position: [100, 200] as [number, number], parameters, ...extra })

const chain = (...names: string[]) => {
  const connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }> = {}
  for (let i = 0; i < names.length - 1; i++) connections[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }
  return connections
}

const manual = () => n8nNode('Start', 'n8n-nodes-base.manualTrigger')
const toolNode = (nodes: FlowNode[], id: string) => {
  const node = nodes.find((candidate) => candidate.id === id)
  assert.ok(node, `no node ${id}`)
  assert.equal(node.type, 'tool')
  const data = node.data as { connectionId: string; toolName: string; args: string; note?: string; forEach?: unknown }
  return { ...data, parsed: JSON.parse(data.args) as Record<string, unknown> }
}

test('a Snowflake executeQuery becomes snowflake_sql_query, its quoted expressions bound instead of spliced', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Accounts', 'n8n-nodes-base.snowflake', {
        operation: 'executeQuery',
        query: "SELECT ID, NAME FROM ACCOUNTS WHERE REGION = '{{ $json.region }}' AND TIER = ? LIMIT {{ $json.limit }}",
        options: { queryReplacement: 'gold' },
      }, { credentials: { snowflake: { id: 'c1', name: 'Snowflake account' } } }),
    ],
    connections: chain('Start', 'Accounts'),
  })
  const step = toolNode(result.graph.nodes, 'id-Accounts')
  assert.equal(step.connectionId, 'native:snowflake')
  assert.equal(step.toolName, 'snowflake_sql_query')
  assert.equal(step.parsed.statement, 'SELECT ID, NAME FROM ACCOUNTS WHERE REGION = ? AND TIER = ? LIMIT ?')
  assert.deepEqual(step.parsed.bindings, ['{{trigger.input.region}}', 'gold', '{{trigger.input.limit}}'])
  const credential = result.notes.find((note) => note.code === 'WAREHOUSE_CREDENTIAL')
  assert.equal(credential?.nodeId, 'id-Accounts')
  assert.match(credential!.message, /Snowflake Key Pair or Snowflake Access Token credential for <account>\.snowflakecomputing\.com.*does not accept a username and password/)
  assert.ok(!result.graph.nodes.some((node) => node.type === 'http'), 'no HTTP skeleton any more')
  assert.ok(!result.graph.nodes.some((node) => node.id.endsWith('-rows')), 'records already — no converter step')
})

test('a Snowflake node without an operation but with a query is an executeQuery (n8n omits defaults)', () => {
  const result = n8nToFlow({ name: 'wf', nodes: [manual(), n8nNode('Q', 'n8n-nodes-base.snowflake', { query: 'SELECT 1' })], connections: chain('Start', 'Q') })
  assert.equal(toolNode(result.graph.nodes, 'id-Q').parsed.statement, 'SELECT 1')
})

test('Snowflake insert and update generate parameterized SQL with every value bound from the item', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Rows', 'n8n-nodes-base.code', { jsCode: 'return [{ json: { id: 1, name: "a" } }]' }),
      n8nNode('Insert', 'n8n-nodes-base.snowflake', { table: 'sales.public.leads', columns: 'id, name, "Mixed Case"' }, { credentials: { snowflake: { id: 'c', name: 's' } } }),
      n8nNode('Update', 'n8n-nodes-base.snowflake', { operation: 'update', table: 'leads', updateKey: 'id', columns: 'status' }, { credentials: { snowflake: { id: 'c', name: 's' } } }),
    ],
    connections: chain('Start', 'Rows', 'Insert', 'Update'),
  })
  const insert = toolNode(result.graph.nodes, 'id-Insert')
  assert.equal(insert.parsed.statement, 'INSERT INTO "SALES"."PUBLIC"."LEADS" ("ID","NAME","Mixed Case") VALUES (?,?,?)')
  // Fed by a code step's item list → runs per item, binding the item's fields.
  assert.deepEqual(insert.parsed.bindings, ['{{item.id}}', '{{item.name}}', ''])
  assert.ok(result.notes.some((note) => note.code === 'WAREHOUSE_REVIEW' && /Mixed Case/.test(note.message)), 'an unreadable column is called out')
  const update = toolNode(result.graph.nodes, 'id-Update')
  assert.equal(update.parsed.statement, 'UPDATE "LEADS" SET "ID" = ?,"STATUS" = ? WHERE "ID" = ?')
  assert.equal((update.parsed.bindings as string[]).length, 3)
  for (const step of [insert, update]) assert.ok(!/'/.test(String(step.parsed.statement)), 'no value is ever written into the SQL')
})

test('a Databricks executeQuery becomes databricks_sql_query with its warehouse and :name parameters', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('DB', 'n8n-nodes-base.databricks', {
        resource: 'databricksSql',
        operation: 'executeQuery',
        warehouseId: { __rl: true, mode: 'url', value: 'https://adb-1.2.azuredatabricks.net/sql/warehouses/abc123def' },
        query: "=SELECT * FROM main.crm.accounts WHERE id = :account_id AND owner = '{{ $json.owner }}'",
        queryParameters: { parameters: [{ name: 'account_id', value: '={{ $json.accountId }}', type: 'STRING' }] },
      }, { credentials: { databricksApi: { id: 'd', name: 'Databricks' } } }),
    ],
    connections: chain('Start', 'DB'),
  })
  const step = toolNode(result.graph.nodes, 'id-DB')
  assert.equal(step.connectionId, 'native:databricks')
  assert.equal(step.toolName, 'databricks_sql_query')
  assert.equal(step.parsed.warehouseId, 'abc123def')
  assert.equal(step.parsed.statement, 'SELECT * FROM main.crm.accounts WHERE id = :account_id AND owner = :p1')
  assert.deepEqual(step.parsed.parameters, [
    { name: 'account_id', value: '{{trigger.input.accountId}}', type: 'STRING' },
    { name: 'p1', value: '{{trigger.input.owner}}' },
  ])
  assert.match(result.notes.find((note) => note.code === 'WAREHOUSE_CREDENTIAL')!.message, /Bearer credential holding a Databricks personal access token/)
})

test('a Databricks operation n8n does not define is kept, flagged as an error, never a silent passthrough', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [manual(), n8nNode('Genie', 'n8n-nodes-base.databricks', { resource: 'genie', operation: 'renameSpace', spaceId: 'sp1', title: '={{ $json.q }}' }, { credentials: { databricksApi: { id: 'd', name: 'D' } } })],
    connections: chain('Start', 'Genie'),
  })
  const step = toolNode(result.graph.nodes, 'id-Genie')
  assert.equal(step.connectionId, 'native:databricks')
  assert.equal(step.toolName, '')
  assert.equal(step.parsed.spaceId, 'sp1')
  assert.equal(step.parsed.title, '{{trigger.input.q}}')
  const note = result.notes.find((entry) => entry.code === 'UNMAPPED_OPERATION')
  assert.equal(note?.severity, 'error')
  assert.match(note!.message, /Databricks genie\.renameSpace has no Backstory equivalent yet.*will not run/)
  assert.ok(!result.graph.nodes.some((node) => node.type === 'code'), 'no passthrough stub')
})

test('HTTP calls to either statements API rebind to the warehouse tool; a manual poll stays HTTP with a converter', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Submit', 'n8n-nodes-base.httpRequest', {
        method: 'POST',
        url: 'https://dbc-9.cloud.databricks.com/api/2.0/sql/statements',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'databricksApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={ \"warehouse_id\": \"w9\", \"statement\": \"SELECT * FROM t WHERE email = '{{ $json.email }}'\", \"wait_timeout\": \"30s\" }",
      }, { credentials: { databricksApi: { id: 'd', name: 'D' } } }),
      n8nNode('Poll', 'n8n-nodes-base.httpRequest', { method: 'GET', url: "=https://dbc-9.cloud.databricks.com/api/2.0/sql/statements/{{ $json.statement_id }}" }),
      n8nNode('SF', 'n8n-nodes-base.httpRequest', { method: 'POST', url: 'https://acme-prod.snowflakecomputing.com/api/v2/statements', sendBody: true, specifyBody: 'json', jsonBody: '{"statement": "select ?", "warehouse": "WH", "role": "R", "bindings": {"1": {"type": "TEXT", "value": "x"}}}' }),
    ],
    connections: chain('Start', 'Submit', 'Poll', 'SF'),
  })
  const submit = toolNode(result.graph.nodes, 'id-Submit')
  assert.equal(submit.toolName, 'databricks_sql_query')
  assert.deepEqual(submit.parsed, {
    statement: 'SELECT * FROM t WHERE email = :p1',
    warehouseId: 'w9',
    host: 'dbc-9.cloud.databricks.com',
    parameters: [{ name: 'p1', value: '{{trigger.input.email}}' }],
  })
  const sf = toolNode(result.graph.nodes, 'id-SF')
  assert.deepEqual(sf.parsed, { statement: 'select ?', warehouse: 'WH', role: 'R', bindings: [{ type: 'TEXT', value: 'x' }], host: 'acme-prod.snowflakecomputing.com' })
  assert.equal(result.graph.nodes.find((node) => node.id === 'id-Poll')?.type, 'http')
  const rows = result.graph.nodes.find((node) => node.id === 'id-Poll-rows')
  assert.equal((rows?.data as { op?: string }).op, 'columnarToRecords')
  assert.ok(result.notes.some((note) => note.code === 'DATABRICKS_SHAPE'))
})

test('steps after a warehouse query read its rows: per item when fed a list, else the first row', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Q', 'n8n-nodes-base.snowflake', { operation: 'executeQuery', query: 'SELECT ID, EMAIL FROM USERS' }, { credentials: { snowflake: { id: 'c', name: 's' } } }),
      n8nNode('Notify', 'n8n-nodes-base.httpRequest', { method: 'POST', url: 'https://hooks.example.com/x', sendBody: true, specifyBody: 'json', jsonBody: '={ "email": "{{ $json.EMAIL }}" }' }),
      n8nNode('Count', 'n8n-nodes-base.databricks', { query: 'SELECT count(*) AS N FROM t' }, { credentials: { databricksApi: { id: 'd', name: 'D' } } }),
      n8nNode('Say', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'total', value: '={{ $json.N }}', type: 'number' }] } }),
    ],
    connections: { ...chain('Start', 'Q', 'Notify'), ...chain('Start', 'Count', 'Say') },
    pinData: { Q: [{ json: { ID: 1, EMAIL: 'a@x.com' } }, { json: { ID: 2, EMAIL: 'b@x.com' } }] },
  })
  const graph = flowGraphSchema.parse(result.graph)
  const notify = graph.nodes.find((node) => node.id === 'id-Notify')!
  assert.match(JSON.stringify(notify.data), /\{\{step\.id-Q\.output\.rows\}\}/)
  assert.match(String((notify.data as { body?: string }).body), /\{\{item\.EMAIL\}\}/)
  const say = graph.nodes.find((node) => node.id === 'id-Say')!
  assert.match(JSON.stringify(say.data), /step\.id-Count\.output\.rows\.0\.N/)
  assert.deepEqual(graph.pinData?.['id-Q'], { rows: [{ ID: 1, EMAIL: 'a@x.com' }, { ID: 2, EMAIL: 'b@x.com' }], columns: ['ID', 'EMAIL'], rowCount: 2, truncated: false })
})

test('an agent\'s HTTP Request tools become real endpoints on the HTTP API plane; warehouse tools attach their planes', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Agent', '@n8n/n8n-nodes-langchain.agent', { options: { systemMessage: 'You research accounts.' } }),
      n8nNode('Model', '@n8n/n8n-nodes-langchain.lmChatOpenAi', { model: 'gpt-4o' }),
      n8nNode('Lookup', '@n8n/n8n-nodes-langchain.toolHttpRequest', {
        toolDescription: 'Look up a company by domain',
        method: 'GET',
        url: 'https://api.clearbit.example.com/v2/companies/find',
        sendQuery: true,
        parametersQuery: { values: [{ name: 'domain', valueProvider: 'modelRequired' }, { name: 'format', valueProvider: 'fieldValue', value: 'json' }] },
        sendHeaders: true,
        parametersHeaders: { values: [{ name: 'Authorization', valueProvider: 'fieldValue', value: 'Bearer sk-live-secret' }, { name: 'Accept', valueProvider: 'fieldValue', value: 'application/json' }] },
      }),
      n8nNode('Post', 'n8n-nodes-base.httpRequestTool', {
        method: 'POST',
        url: "=https://api.example.com/notes/{{ $fromAI('noteId', 'the note', 'string') }}",
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={ \"text\": \"{{ $fromAI('text') }}\" }",
      }),
      n8nNode('Warehouse', 'n8n-nodes-base.snowflakeTool', { operation: 'executeQuery', query: "={{ $fromAI('sql') }}" }, { credentials: { snowflake: { id: 'c', name: 's' } } }),
    ],
    connections: {
      ...chain('Start', 'Agent'),
      Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
      Lookup: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
      Post: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
      Warehouse: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
    },
  })
  const [spec] = result.agents
  assert.ok(spec.integrations.includes('HTTP API'))
  assert.ok(spec.integrations.includes('Snowflake'))
  assert.equal(spec.httpEndpoints.length, 2)
  const [lookup, post] = spec.httpEndpoints
  assert.equal(lookup.name, 'Lookup')
  assert.equal(lookup.description, 'Look up a company by domain')
  assert.deepEqual(lookup.query, { domain: '{{domain}}', format: 'json' })
  assert.deepEqual(lookup.headers, { Accept: 'application/json' }, 'a secret typed into a header never reaches agent metadata')
  assert.equal(post.method, 'POST')
  assert.equal(post.url, 'https://api.example.com/notes/{{noteId}}')
  assert.equal(post.body, '{ "text": "{{text}}" }')
  assert.ok(result.notes.some((note) => note.code === 'WAREHOUSE_CREDENTIAL' && /Snowflake tool “Warehouse”/.test(note.message)))
})

test('an unknown node carrying a warehouse credential binds to the native plane, not a Nango provider', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [manual(), n8nNode('Custom', 'n8n-nodes-community.snowflakeBulk', { operation: 'load' }, { credentials: { snowflake: { id: 'c', name: 's' } } })],
    connections: chain('Start', 'Custom'),
  })
  assert.equal(toolNode(result.graph.nodes, 'id-Custom').connectionId, 'native:snowflake')
  assert.ok(result.notes.some((note) => note.code === 'WAREHOUSE_CREDENTIAL'))
})

test('parameterizeN8nSql binds values, keeps literals and identifiers, and numbers after existing :N', () => {
  const token = (expression: string) => `{{${expression.replace('$json.', 'input.')}}}`
  assert.deepEqual(parameterizeN8nSql("SELECT * FROM {{ $json.table }} WHERE a = 'x' AND b = 'pre-{{ $json.b }}'", token, { style: 'positional' }), {
    statement: "SELECT * FROM {{input.table}} WHERE a = 'x' AND b = ?",
    bindings: ['pre-{{input.b}}'],
    spliced: ['$json.table'],
  })
  assert.deepEqual(parameterizeN8nSql("SELECT :1, :2 WHERE c = '{{ $json.c }}'", token, { style: 'positional', existing: ['A', 'B'] }).statement, 'SELECT :1, :2 WHERE c = :3')
  assert.equal(parameterizeN8nSql("WHERE name = 'O''Brien' AND x = '{{ $json.x }}'", token, { style: 'named' }).statement, "WHERE name = 'O''Brien' AND x = :p1")
  assert.deepEqual(splitQueryReplacement('{{a}}, b ,{{ c, d }}'), ['{{a}}', 'b', '{{ c, d }}'])
  assert.equal(escapeSnowflakeObjectIdentifier('db."My.Schema".t'), '"DB"."My.Schema"."T"')
})

test('the import route\'s binders attach agent endpoint auth by host and retire satisfied warehouse notes', () => {
  const credentials = [
    { id: 'cb', name: 'Clearbit', allowedHost: 'api.clearbit.example.com' },
    { id: 'sf', name: 'Snowflake prod', allowedHost: 'acme-prod.snowflakecomputing.com' },
  ]
  const endpoints = bindAgentEndpointAuth<{ name: string; url: string; credentialId?: string }>([{ name: 'Lookup', url: 'https://api.clearbit.example.com/v2/companies/{{domain}}' }, { name: 'Other', url: 'https://elsewhere.example.com/' }], credentials)
  assert.equal(endpoints.endpoints[0].credentialId, 'cb')
  assert.equal('credentialId' in endpoints.endpoints[1], false)
  const notes = [
    { code: 'WAREHOUSE_CREDENTIAL', message: '“Q”: its n8n Snowflake credential does not transfer — …' },
    { code: 'WAREHOUSE_CREDENTIAL', message: '“D”: its n8n Databricks credential does not transfer — …' },
    { code: 'INTEGRATION_BOUND', message: 'kept' },
  ]
  const resolved = resolveWarehouseCredentialNotes(notes, credentials)
  assert.deepEqual(resolved.notes.map((note) => note.message.slice(0, 5)), ['“D”: ', 'kept'])
  assert.deepEqual(resolved.satisfied, ['Snowflake steps run on your saved credential for acme-prod.snowflakecomputing.com.'])
})
