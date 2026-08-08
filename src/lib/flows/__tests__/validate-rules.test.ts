import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { validateFlowGraph, validationErrorMessage } from '../validate'

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
