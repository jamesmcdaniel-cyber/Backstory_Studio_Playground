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
import { fakeWarehouse } from '@/lib/warehouse/__tests__/fake-warehouse'

/**
 * End to end, minus the network and the database: a realistic n8n workflow
 * using a Snowflake query, a Databricks query, a raw HTTP call to the
 * Databricks statements API and an AI agent with an HTTP Request tool is
 * imported, validated the way a run validates it (catalog loaded for the
 * graph's connection ids), and every tool step is resolved and executed
 * through resolveFlowToolExecutor against scripted warehouses.
 */

const node = (name: string, type: string, parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, type, typeVersion: 1, position: [0, 0], parameters, ...extra })

const WORKFLOW = {
  name: 'Account health digest',
  nodes: [
    node('Every morning', 'n8n-nodes-base.scheduleTrigger', { rule: { interval: [{ field: 'days', triggerAtHour: 8 }] } }),
    node('Top accounts', 'n8n-nodes-base.snowflake', {
      operation: 'executeQuery',
      query: "SELECT ACCOUNT_ID, NAME FROM ANALYTICS.PUBLIC.ACCOUNTS WHERE SEGMENT = 'enterprise' ORDER BY ARR DESC LIMIT 20",
    }, { credentials: { snowflake: { id: '7', name: 'Snowflake account' } } }),
    node('Usage', 'n8n-nodes-base.databricks', {
      resource: 'databricksSql',
      operation: 'executeQuery',
      warehouseId: { __rl: true, mode: 'list', value: 'a1b2c3d4e5f6', cachedResultName: 'Shared' },
      query: '=SELECT account_id, active_users FROM main.product.usage_daily WHERE day = current_date() - 1',
    }, { credentials: { databricksApi: { id: '8', name: 'Databricks account' } } }),
    node('Churn scores', 'n8n-nodes-base.httpRequest', {
      method: 'POST',
      url: 'https://dbc-5f3e.cloud.databricks.com/api/2.0/sql/statements',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'databricksApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '{ "warehouse_id": "a1b2c3d4e5f6", "statement": "SELECT account_id, churn_risk FROM main.ml.churn_scores", "wait_timeout": "30s" }',
    }, { credentials: { databricksApi: { id: '8', name: 'Databricks account' } } }),
    node('Analyst', '@n8n/n8n-nodes-langchain.agent', {
      promptType: 'define',
      text: '=Summarize account health for {{ $json.rows }}',
      options: { systemMessage: 'You are a customer success analyst.' },
    }),
    node('Claude', '@n8n/n8n-nodes-langchain.lmChatAnthropic', { model: 'claude-sonnet' }),
    node('CRM lookup', '@n8n/n8n-nodes-langchain.toolHttpRequest', {
      toolDescription: 'Fetch the CRM record for an account id',
      url: 'https://crm.example.com/api/accounts/{accountId}',
      placeholderDefinitions: { values: [{ name: 'accountId', description: 'CRM account id', type: 'string' }] },
    }),
  ],
  connections: {
    'Every morning': { main: [[{ node: 'Top accounts', type: 'main', index: 0 }]] },
    'Top accounts': { main: [[{ node: 'Usage', type: 'main', index: 0 }]] },
    Usage: { main: [[{ node: 'Churn scores', type: 'main', index: 0 }]] },
    'Churn scores': { main: [[{ node: 'Analyst', type: 'main', index: 0 }]] },
    Claude: { ai_languageModel: [[{ node: 'Analyst', type: 'ai_languageModel', index: 0 }]] },
    'CRM lookup': { ai_tool: [[{ node: 'Analyst', type: 'ai_tool', index: 0 }]] },
  },
}

type Row = { id: string; allowedHost: string; userId: string | null; status: string; lastVerifiedAt: Date | null }

function withCredentials(rows: Row[]) {
  const original = { rows: warehouseCredentialStore.rows, resolve: warehouseCredentialStore.resolve, ...warehouseRequests }
  warehouseCredentialStore.rows = async (_org, where) => rows.filter((row) =>
    where.host ? row.allowedHost === where.host : !where.kind || row.allowedHost.includes(where.kind === 'snowflake' ? 'snowflake' : 'databricks'))
  warehouseCredentialStore.resolve = async (id) => ({ id, name: id, authType: 'bearer', allowedHost: rows.find((row) => row.id === id)!.allowedHost, config: { token: 't' } })
  return () => {
    warehouseCredentialStore.rows = original.rows
    warehouseCredentialStore.resolve = original.resolve
    warehouseRequests.databricks = original.databricks
    warehouseRequests.snowflake = original.snowflake
  }
}

/** The catalog a run validates against: only the planes the graph references (as loadFlowToolCatalog does). */
async function catalogFor(connectionIds: string[]) {
  const refs = connectionIds.map(parseFlowToolConnectionId).filter((id) => id.plane === 'native').map((id) => id.ref)
  return (await loadWarehousePlaneGroups('org', { providers: refs, userId: 'u1' })).map((group) => ({
    id: group.id,
    name: group.name,
    ...(group.toolsError ? { toolsError: group.toolsError } : {}),
    tools: group.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
  }))
}

test('the imported workflow converts to warehouse tool steps, an agent with a real HTTP tool, and validates once credentials exist', async () => {
  const result = n8nToFlow(WORKFLOW)
  const graph = flowGraphSchema.parse(result.graph)
  const tools = graph.nodes.filter((entry) => entry.type === 'tool') as Array<{ id: string; data: { connectionId: string; toolName: string; args: string } }>
  assert.deepEqual(tools.map((entry) => [entry.id, entry.data.connectionId, entry.data.toolName]), [
    ['top-accounts', 'native:snowflake', 'snowflake_sql_query'],
    ['usage', 'native:databricks', 'databricks_sql_query'],
    ['churn-scores', 'native:databricks', 'databricks_sql_query'],
  ])
  assert.ok(!graph.nodes.some((entry) => entry.type === 'http'), 'no hand-auth HTTP skeletons left')

  const [agent] = result.agents
  assert.ok(agent.integrations.includes('HTTP API'))
  assert.deepEqual(agent.httpEndpoints.map((endpoint) => [endpoint.name, endpoint.method, endpoint.url]), [['CRM lookup', 'GET', 'https://crm.example.com/api/accounts/{{accountId}}']])
  const agentStep = graph.nodes.find((entry) => entry.type === 'agent')!
  const agents = [{ id: (agentStep.data as { agentId: string }).agentId }]

  const connectionIds = tools.map((entry) => entry.data.connectionId)
  // Before any credential is saved: blocked, with the fix named.
  let restore = withCredentials([])
  try {
    const blocked = validateFlowGraph(graph, { toolCatalog: await catalogFor(connectionIds), agents })
    const unavailable = blocked.errors.filter((issue) => issue.code === 'TOOL_CONNECTION_UNAVAILABLE')
    assert.equal(unavailable.length, 3, JSON.stringify(blocked.errors))
    const catalog = await catalogFor(connectionIds)
    assert.match(catalog.find((entry) => entry.id === 'native:snowflake')!.toolsError!, /Save a credential for <account>\.snowflakecomputing\.com in Integrations/)
  } finally {
    restore()
  }

  // With a Snowflake and a Databricks credential: no errors at all.
  restore = withCredentials([
    { id: 'sf', allowedHost: 'acme-prod.snowflakecomputing.com', userId: 'u1', status: 'verified', lastVerifiedAt: null },
    { id: 'db', allowedHost: 'dbc-5f3e.cloud.databricks.com', userId: null, status: 'verified', lastVerifiedAt: null },
  ])
  try {
    const validation = validateFlowGraph(graph, { toolCatalog: await catalogFor(connectionIds), agents })
    assert.deepEqual(validation.errors, [])
  } finally {
    restore()
  }
})

test('every imported tool step resolves to an executable warehouse tool and runs', async () => {
  const graph = flowGraphSchema.parse(n8nToFlow(WORKFLOW).graph)
  const restore = withCredentials([
    { id: 'sf', allowedHost: 'acme-prod.snowflakecomputing.com', userId: 'u1', status: 'verified', lastVerifiedAt: null },
    { id: 'db', allowedHost: 'dbc-5f3e.cloud.databricks.com', userId: null, status: 'verified', lastVerifiedAt: null },
  ])
  const snowflake = fakeWarehouse([
    { match: /^\/api\/v2\/statements\?/, method: 'POST', status: 202, body: { statementHandle: 'h1' } },
    { match: /^\/api\/v2\/statements\/h1$/, body: { statementHandle: 'h1', resultSetMetaData: { numRows: 1, rowType: [{ name: 'ACCOUNT_ID', type: 'text' }, { name: 'NAME', type: 'text' }] }, data: [['001', 'Acme']] } },
  ])
  const databricks = fakeWarehouse([
    { match: /^\/api\/2\.0\/sql\/statements$/, body: { statement_id: 'u', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'account_id' }, { name: 'active_users' }] } }, result: { data_array: [['001', '42']] } } },
    { match: /^\/api\/2\.0\/sql\/statements$/, body: { statement_id: 'c', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'account_id' }, { name: 'churn_risk' }] } }, result: { data_array: [['001', '0.2']] } } },
  ])
  const hosts: string[] = []
  warehouseRequests.snowflake = (host) => { hosts.push(host); return snowflake.request }
  warehouseRequests.databricks = (host) => { hosts.push(host); return databricks.request }
  try {
    const ctx: FlowContext = { trigger: { input: {} }, step: {} }
    const outputs: Record<string, unknown> = {}
    for (const entry of graph.nodes) {
      if (entry.type !== 'tool') continue
      const data = entry.data as { connectionId: string; toolName: string; args: string }
      const args = prepareToolArgs(resolveTemplateValue(JSON.parse(data.args), ctx))
      const { plane, ref } = parseFlowToolConnectionId(data.connectionId)
      const executor = await resolveFlowToolExecutor({ organizationId: 'org', userId: 'u1', plane, ref, toolName: data.toolName, args })
      assert.equal(executor.isWrite, false, `${entry.id} is a read`)
      outputs[entry.id] = await executor.execute(data.toolName, args)
      ctx.step[entry.id] = { output: outputs[entry.id] }
    }
    assert.deepEqual((outputs['top-accounts'] as { rows: unknown[] }).rows, [{ ACCOUNT_ID: '001', NAME: 'Acme' }])
    assert.deepEqual((outputs.usage as { rows: unknown[] }).rows, [{ account_id: '001', active_users: '42' }])
    assert.deepEqual((outputs['churn-scores'] as { rows: unknown[] }).rows, [{ account_id: '001', churn_risk: '0.2' }])
    assert.deepEqual(hosts, ['acme-prod.snowflakecomputing.com', 'dbc-5f3e.cloud.databricks.com', 'dbc-5f3e.cloud.databricks.com'])
    assert.equal(JSON.parse(databricks.calls[0].body!).warehouse_id, 'a1b2c3d4e5f6')
  } finally {
    restore()
  }
})
