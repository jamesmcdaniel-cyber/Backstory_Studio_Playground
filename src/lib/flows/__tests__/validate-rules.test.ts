import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { validateFlowGraph, validationErrorMessage } from '../validate'
import { flowGraphSchema } from '../graph'

// Value-level checker rules (WS2 flow-gap-closure). Kept in their own file:
// validate.test.ts sits just under a tsx+node22 file-size cliff (~45KB) where
// module load spins forever in a regex split — do not grow that file.
test('PLACEHOLDER_VALUE flags skeleton URLs and imported TODO code stubs', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'h', type: 'http', data: { method: 'POST', url: 'https://YOUR_ACCOUNT.snowflakecomputing.com/api/v2/statements', credentialId: 'cred-1' } },
      { id: 'h2', type: 'http', data: { method: 'GET', url: 'https://api.example-corp.com/<your-tenant>/items', credentialId: 'cred-1' } },
      { id: 'c', type: 'code', data: { language: 'javascript', mode: 'all', code: '// TODO (imported from n8n n8n-nodes-base.foo)\nreturn input' } },
      { id: 'ok', type: 'http', data: { method: 'GET', url: 'https://api.stripe.com/v1/charges', credentialId: 'cred-1' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'h' },
      { id: 'e2', source: 'h', target: 'h2' },
      { id: 'e3', source: 'h2', target: 'c' },
      { id: 'e4', source: 'c', target: 'ok' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'PLACEHOLDER_VALUE' && issue.nodeId === 'h'))
  assert.ok(result.errors.some((issue) => issue.code === 'PLACEHOLDER_VALUE' && issue.nodeId === 'h2'))
  assert.ok(result.errors.some((issue) => issue.code === 'PLACEHOLDER_VALUE' && issue.nodeId === 'c'))
  assert.ok(!result.issues.some((issue) => issue.code === 'PLACEHOLDER_VALUE' && issue.nodeId === 'ok'))
})

test('SQL_TOKEN_IN_LITERAL warns when a token sits inside a quoted SQL string', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'h', type: 'http', data: { method: 'POST', url: 'https://acme.snowflakecomputing.com/api/v2/statements', credentialId: 'cred-1', bodyMode: 'json', body: '{"statement": "SELECT * FROM accounts WHERE SFDC_NAME ILIKE \'%{{item.accountName}}%\'"}' } },
      { id: 'h2', type: 'http', data: { method: 'POST', url: 'https://acme.snowflakecomputing.com/api/v2/statements', credentialId: 'cred-1', bodyMode: 'json', body: '{"statement": "SELECT 1", "bindings": {"1": {"type": "TEXT", "value": "{{item.accountName}}"}}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'h' },
      { id: 'e2', source: 'h', target: 'h2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.warnings.some((issue) => issue.code === 'SQL_TOKEN_IN_LITERAL' && issue.nodeId === 'h'))
  assert.ok(!result.issues.some((issue) => issue.code === 'SQL_TOKEN_IN_LITERAL' && issue.nodeId === 'h2'))
})

test('TOKEN_UNKNOWN_STEP flags references to steps that are not in the graph', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', input: 'Summarize {{step.ghost.output}}' } },
      { id: 'b', type: 'agent', data: { agentId: 'agent-1', input: 'Read {{step.a.output}} and {{trigger.input.name}} and {{item.x}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
    ],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.ok(result.errors.some((issue) => issue.code === 'TOKEN_UNKNOWN_STEP' && issue.nodeId === 'a'))
  assert.ok(!result.issues.some((issue) => issue.code === 'TOKEN_UNKNOWN_STEP' && issue.nodeId === 'b'))
})

test('TOKEN_UNKNOWN_VAR flags variables no step initializes', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', input: 'Count is {{var.count}} but typo is {{var.cuont}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'v' },
      { id: 'e2', source: 'v', target: 'a' },
    ],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.ok(result.errors.some((issue) => issue.code === 'TOKEN_UNKNOWN_VAR' && issue.nodeId === 'a' && /cuont/.test(issue.message)))
  assert.equal(result.errors.filter((issue) => issue.code === 'TOKEN_UNKNOWN_VAR').length, 1)
})

test('PER_ITEM_STATIC_ARGS warns when a per-item step never uses the current item', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'static', type: 'tool', data: { connectionId: 'c1', toolName: 'read_channel', args: '{"channel":"D095KBU0KNZ"}', perItem: { over: '{{trigger.input.accounts}}' } } },
      { id: 'mapped', type: 'tool', data: { connectionId: 'c1', toolName: 'read_channel', args: '{"channel":"{{item.slackChannelId}}"}', perItem: { over: '{{trigger.input.accounts}}' } } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'static' },
      { id: 'e2', source: 'static', target: 'mapped' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.warnings.some((issue) => issue.code === 'PER_ITEM_STATIC_ARGS' && issue.nodeId === 'static'))
  assert.ok(!result.issues.some((issue) => issue.code === 'PER_ITEM_STATIC_ARGS' && issue.nodeId === 'mapped'))
})

test('LIST_INTO_SINGLE warns when a list-producing step feeds a run-once http/tool step', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'files', type: 'code', data: { language: 'javascript', mode: 'all', code: 'return input', input: '{{item}}', perItem: { over: '{{trigger.input.accounts}}' } } },
      { id: 'upload', type: 'http', data: { method: 'POST', url: 'https://www.googleapis.com/upload/drive/v3/files', credentialId: 'cred-1', body: '{{step.files.output}}' } },
      { id: 'summarize', type: 'agent', data: { agentId: 'agent-1', input: 'Summarize {{step.files.output}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'files' },
      { id: 'e2', source: 'files', target: 'upload' },
      { id: 'e3', source: 'upload', target: 'summarize' },
    ],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.ok(result.warnings.some((issue) => issue.code === 'LIST_INTO_SINGLE' && issue.nodeId === 'upload'))
  // Agents aggregate deliberately (summaries over all items) — never flagged.
  assert.ok(!result.issues.some((issue) => issue.code === 'LIST_INTO_SINGLE' && issue.nodeId === 'summarize'))

  const fixed: FlowGraph = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === 'upload' ? { ...n, data: { ...n.data, perItem: { over: '{{step.files.output}}' } } } : n,
    ) as FlowGraph['nodes'],
  }
  const fixedResult = validateFlowGraph(fixed, { agents: [{ id: 'agent-1' }] })
  assert.ok(!fixedResult.issues.some((issue) => issue.code === 'LIST_INTO_SINGLE'))
})

test('agent toolConnectionIds validate against the catalog like tool steps do', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', input: 'Go', toolConnectionIds: ['nango:slack', 'mcp-dead'] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a' }],
  }
  const result = validateFlowGraph(graph, {
    agents: [{ id: 'agent-1' }],
    toolCatalog: [{ id: 'nango:slack', tools: [{ name: 'slack_send' }] }, { id: 'mcp-dead', toolsError: 'unreachable' }],
  })
  assert.ok(result.errors.some((issue) => issue.code === 'AGENT_TOOL_CONNECTION_UNAVAILABLE' && issue.nodeId === 'a'))
  assert.ok(!result.issues.some((issue) => issue.code === 'UNKNOWN_AGENT_TOOL_CONNECTION'))

  const missing = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }], toolCatalog: [{ id: 'nango:slack' }] })
  assert.ok(missing.errors.some((issue) => issue.code === 'UNKNOWN_AGENT_TOOL_CONNECTION' && issue.nodeId === 'a'))

  // No catalog in context (draft-time light validation): skipped entirely.
  const light = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.ok(!light.issues.some((issue) => issue.code.includes('AGENT_TOOL')))
})

// ── HTTP multipart file attachments ────────────────────────────────────────

function uploadGraph(httpData: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'download', type: 'http', data: { method: 'GET', url: 'https://api.example.com/doc', responseType: 'file', credentialId: 'cred-1' } },
      { id: 'upload', type: 'http', data: { method: 'POST', url: 'https://api.example.com/upload', credentialId: 'cred-1', ...httpData } } as FlowGraph['nodes'][number],
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'download' },
      { id: 'e2', source: 'download', target: 'upload' },
    ],
  }
}

const fileIssues = (graph: FlowGraph) =>
  validateFlowGraph(graph, { httpCredentials: [{ id: 'cred-1' }] }).issues.filter((issue) => issue.code.startsWith('FILE_FIELD_'))

test('a well-formed multipart file attachment validates clean', () => {
  const graph = uploadGraph({
    bodyMode: 'form-data',
    body: '{"title":"Q3"}',
    formFiles: [{ field: 'document', source: 'step.download.output' }],
  })
  assert.deepEqual(fileIssues(graph), [])
})

test('a file attachment outside a form-data body is rejected', () => {
  const issues = fileIssues(uploadGraph({ bodyMode: 'json', body: '{}', formFiles: [{ field: 'document', source: 'step.download.output' }] }))
  assert.ok(issues.some((issue) => issue.code === 'FILE_FIELD_NEEDS_FORM_DATA' && issue.nodeId === 'upload'))
})

test('a file attachment on a step that sends no body, or a GET, is rejected', () => {
  const off = fileIssues(uploadGraph({ bodyMode: 'form-data', sendBody: false, formFiles: [{ field: 'f', source: 'step.download.output' }] }))
  assert.ok(off.some((issue) => issue.code === 'FILE_FIELD_BODY_OFF'))

  const get = fileIssues(uploadGraph({ method: 'GET', bodyMode: 'form-data', formFiles: [{ field: 'f', source: 'step.download.output' }] }))
  assert.ok(get.some((issue) => issue.code === 'FILE_FIELD_NO_BODY_METHOD'))
})

test('malformed file bindings are rejected: no field name, duplicates, no source, typed tokens, dead steps', () => {
  const duplicate = fileIssues(uploadGraph({
    bodyMode: 'form-data',
    formFiles: [{ field: 'doc', source: 'step.download.output' }, { field: 'doc', source: 'step.download.output' }],
  }))
  assert.ok(duplicate.some((issue) => issue.code === 'FILE_FIELD_DUPLICATE'))

  const unnamed = fileIssues(uploadGraph({ bodyMode: 'form-data', formFiles: [{ field: '   ', source: 'step.download.output' }] }))
  assert.ok(unnamed.some((issue) => issue.code === 'FILE_FIELD_NO_NAME'))

  const noSource = fileIssues(uploadGraph({ bodyMode: 'form-data', formFiles: [{ field: 'doc', source: '   ' }] }))
  assert.ok(noSource.some((issue) => issue.code === 'FILE_FIELD_NO_SOURCE'))

  // Raw token syntax is never what the picker writes — it means hand-typing.
  const typed = fileIssues(uploadGraph({ bodyMode: 'form-data', formFiles: [{ field: 'doc', source: '{{step.download.output}}' }] }))
  assert.ok(typed.some((issue) => issue.code === 'FILE_FIELD_BAD_SOURCE'))

  const dead = fileIssues(uploadGraph({ bodyMode: 'form-data', formFiles: [{ field: 'doc', source: 'step.deleted.output' }] }))
  assert.ok(dead.some((issue) => issue.code === 'FILE_FIELD_UNKNOWN_STEP'))
})

test('the graph schema accepts formFiles and rejects an empty field or source', () => {
  const node = {
    id: 'upload',
    type: 'http',
    data: { method: 'POST', url: 'https://api.example.com/upload', bodyMode: 'form-data', formFiles: [{ field: 'doc', source: 'step.download.output' }] },
  }
  const graph = { nodes: [{ id: 'trigger', type: 'trigger', data: {} }, node], edges: [] }
  assert.equal(flowGraphSchema.safeParse(graph).success, true)

  const bad = { ...graph, nodes: [graph.nodes[0], { ...node, data: { ...node.data, formFiles: [{ field: '', source: 'step.download.output' }] } }] }
  assert.equal(flowGraphSchema.safeParse(bad).success, false)

  const noSource = { ...graph, nodes: [graph.nodes[0], { ...node, data: { ...node.data, formFiles: [{ field: 'doc', source: '' }] } }] }
  assert.equal(flowGraphSchema.safeParse(noSource).success, false)
})
