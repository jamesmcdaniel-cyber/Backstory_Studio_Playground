import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { validateFlowGraph, validationErrorMessage } from '../validate'

test('validateFlowGraph accepts a runnable agent flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', input: 'Use {{trigger.input}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a' }],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1', title: 'Agent' }] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph rejects a node implementation newer than this deployment', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', typeVersion: 999, data: { agentId: 'agent-1', input: 'hello' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a' }],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.equal(result.errors.some((issue) => issue.code === 'UNSUPPORTED_NODE_VERSION'), true)
})

test('validateFlowGraph reports missing agents and dangling edges', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'missing', input: 'x' } },
    ],
    edges: [{ id: 'bad', source: 'trigger', target: 'nope' }],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_AGENT'))
  assert.ok(result.errors.some((issue) => issue.code === 'DANGLING_EDGE'))
  assert.match(validationErrorMessage(result), /agent|edge|missing/i)
})

test('validateFlowGraph checks tool connection, tool name, and object-shaped JSON args', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'missing_tool', args: '{"broken":' } },
      { id: 'arr', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '[]' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }, { id: 'e2', source: 't', target: 'arr' }],
  }
  const result = validateFlowGraph(graph, { toolCatalog: [{ id: 'c1', tools: [{ name: 'send' }] }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_TOOL'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.nodeId === 't'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.nodeId === 'arr'))
})

test('validateFlowGraph checks required tool arguments from input schema', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{"channel":"{{trigger.input.channel}}"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }],
  }
  const result = validateFlowGraph(graph, {
    toolCatalog: [
      {
        id: 'c1',
        tools: [
          {
            name: 'send',
            inputSchema: { type: 'object', required: ['channel', 'message'], properties: { channel: { type: 'string' }, message: { type: 'string' } } },
          },
        ],
      },
    ],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_TOOL_ARG' && issue.message.includes('message')))
  assert.ok(!result.errors.some((issue) => issue.code === 'MISSING_TOOL_ARG' && issue.message.includes('channel')))
})

test('validateFlowGraph accepts required object tool args supplied by exact data tokens', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'upsert', args: '{"record":"{{trigger.input.record}}"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }],
  }
  const result = validateFlowGraph(graph, {
    toolCatalog: [{ id: 'c1', tools: [{ name: 'upsert', inputSchema: { type: 'object', required: ['record'] } }] }],
  })
  assert.equal(result.ok, true)
})

test('validateFlowGraph checks HTTP request configuration', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'bad-url', type: 'http', data: { method: 'POST', url: 'ftp://example.com', headers: '[]', query: '"bad"', bodyMode: 'json', body: '{broken' } },
      { id: 'insecure-url', type: 'http', data: { method: 'POST', url: 'http://api.example.com' } },
      { id: 'get-body', type: 'http', data: { method: 'GET', url: 'https://api.example.com', body: '{"ignored":true}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'bad-url' },
      { id: 'e2', source: 'bad-url', target: 'insecure-url' },
      { id: 'e3', source: 'insecure-url', target: 'get-body' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_HTTP_URL'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_HTTP_URL' && issue.message.includes('https://') && issue.nodeId === 'insecure-url'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.message.includes('headers')))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.message.includes('query')))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON' && issue.message.includes('body')))
  assert.ok(result.warnings.some((issue) => issue.code === 'HTTP_BODY_IGNORED'))
})

test('an http step with no authentication is an error — zero-auth requests are never allowed', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://api.example.com/v1/thing' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'h1' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  const issue = result.errors.find((entry) => entry.code === 'HTTP_NO_AUTH')
  assert.equal(issue?.nodeId, 'h1')
  assert.match(issue?.message ?? '', /without authentication/)
})

test('the no-auth error names the provider and whether it is connected', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://acct.snowflakecomputing.com/api/v2/statements' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'h1' }],
  }
  // Provider recognized from the host, not connected on the platform yet.
  const unconnected = validateFlowGraph(graph)
  assert.match(unconnected.errors.find((entry) => entry.code === 'HTTP_NO_AUTH')?.message ?? '', /connect Snowflake in Integrations/)
  // Same host with a connected Snowflake integration: steer to reusing it.
  const connected = validateFlowGraph(graph, { toolCatalog: [{ id: 'mcp-snowflake-1', name: 'Snowflake', tools: [] }] })
  assert.match(connected.errors.find((entry) => entry.code === 'HTTP_NO_AUTH')?.message ?? '', /reuse your connected Snowflake integration/)
})

test('validateFlowGraph blocks an http step that authenticates with an unavailable connection', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://api.example.com', connectionId: 'gone' } },
      { id: 'h2', type: 'http', data: { method: 'POST', url: 'https://api.example.com', connectionId: 'c1' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'h1' }, { id: 'e2', source: 'h1', target: 'h2' }],
  }
  const result = validateFlowGraph(graph, { toolCatalog: [{ id: 'c1', tools: [] }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION' && issue.nodeId === 'h1'))
  assert.ok(!result.errors.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION' && issue.nodeId === 'h2'))
  // No catalog context (e.g. plain graph checks): no warning either
  const noContext = validateFlowGraph(graph)
  assert.ok(!noContext.warnings.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION'))
})

test('mixed webhook, HTTP, agent, integration, and MCP flow has every runnable dependency', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
      { id: 'agent', type: 'agent', data: { agentId: 'agent-1', input: 'Triage {{trigger.input}}' } },
      { id: 'webhook', type: 'http', data: { label: 'Webhook', method: 'POST', url: 'https://hooks.example.com/events', body: '{"summary":"{{step.agent.output}}"}', bodyMode: 'json', credentialId: 'http-credential-1' } },
      { id: 'http', type: 'http', data: { method: 'GET', url: 'https://api.example.com/status', credentialId: 'http-credential-1' } },
      { id: 'integration', type: 'tool', data: { connectionId: 'native:http', toolName: 'http_request', args: '{"url":"https://api.example.com/finalize"}' } },
      { id: 'mcp', type: 'tool', data: { connectionId: 'mcp-connection-1', toolName: 'lookup_record', args: '{"id":"{{trigger.input.id}}"}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'agent' },
      { id: 'e2', source: 'agent', target: 'webhook' },
      { id: 'e3', source: 'webhook', target: 'http' },
      { id: 'e4', source: 'http', target: 'integration' },
      { id: 'e5', source: 'integration', target: 'mcp' },
    ],
  }
  const result = validateFlowGraph(graph, {
    agents: [{ id: 'agent-1' }],
    toolCatalog: [
      { id: 'native:http', tools: [{ name: 'http_request', inputSchema: { type: 'object', required: ['url'] } }] },
      { id: 'mcp-connection-1', tools: [{ name: 'lookup_record', inputSchema: { type: 'object', required: ['id'] } }] },
    ],
    httpCredentials: [{ id: 'http-credential-1' }],
    webhookSecretConfigured: true,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('runnable dependency checks catch unavailable tools, credentials, and webhook settings', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
      { id: 'http', type: 'http', data: { method: 'GET', url: 'https://api.example.com', credentialId: 'gone' } },
      { id: 'tool', type: 'tool', data: { connectionId: 'mcp-1', toolName: 'read', args: '{}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'http' },
      { id: 'e2', source: 'http', target: 'tool' },
    ],
  }
  const result = validateFlowGraph(graph, {
    toolCatalog: [{ id: 'mcp-1', tools: [], toolsError: 'offline' }],
    httpCredentials: [],
    webhookSecretConfigured: false,
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_WEBHOOK_SECRET'))
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_HTTP_CREDENTIAL'))
  assert.ok(result.errors.some((issue) => issue.code === 'TOOL_CONNECTION_UNAVAILABLE'))
})

test('signal triggers require a signal name and HTTP predefined auth requires MCP', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'signal' } } },
      { id: 'http', type: 'http', data: { method: 'GET', url: 'https://api.example.com', connectionId: 'native:slack' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'http' }],
  }
  const result = validateFlowGraph(graph, { toolCatalog: [{ id: 'native:slack', tools: [] }] })
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_SIGNAL'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_HTTP_AUTH_CONNECTION'))
})

test('validateFlowGraph warns about a join with no incoming branch, not a wired one', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', input: 'x' } },
      { id: 'j', type: 'join', data: {} }, // wired: reached from `a`
      { id: 'orphan', type: 'join', data: { label: 'Merge' } }, // no incoming edge
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a' },
      { id: 'e2', source: 'a', target: 'j' },
    ],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1', title: 'Agent' }] })
  assert.ok(result.warnings.some((issue) => issue.code === 'JOIN_NO_INCOMING' && issue.nodeId === 'orphan'))
  assert.equal(result.warnings.some((issue) => issue.code === 'JOIN_NO_INCOMING' && issue.nodeId === 'j'), false)
  assert.match(result.warnings.find((issue) => issue.code === 'JOIN_NO_INCOMING')?.message ?? '', /Merge isn't reached by any branch\./)
})

test('validateFlowGraph warns when a route-on-error step has no error path', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'nopath', type: 'tool', data: { connectionId: 'c1', toolName: 't', label: 'Send', onError: 'route' } },
      { id: 'wired', type: 'tool', data: { connectionId: 'c1', toolName: 't', onError: 'route' } },
      { id: 'handler', type: 'agent', data: { agentId: 'agent-1', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'nopath' },
      { id: 'e1', source: 'nopath', target: 'wired' },
      { id: 'e2', source: 'wired', target: 'handler', branch: 'error' }, // has an error path
    ],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1', title: 'Agent' }] })
  assert.ok(result.warnings.some((issue) => issue.code === 'ROUTE_NO_ERROR_PATH' && issue.nodeId === 'nopath'))
  assert.equal(result.warnings.some((issue) => issue.code === 'ROUTE_NO_ERROR_PATH' && issue.nodeId === 'wired'), false)
  assert.match(result.warnings.find((issue) => issue.code === 'ROUTE_NO_ERROR_PATH')?.message ?? '', /Send routes on error but has no error path — failures continue on the normal path\./)
})

test('validateFlowGraph checks loop bodies and switch defaults', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: [] } },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'c1', left: '{{trigger.input}}', op: 'eq', right: 'x' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }, { id: 'e2', source: 'loop', target: 'sw' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'EMPTY_LOOP_BODY'))
  assert.ok(result.warnings.some((issue) => issue.code === 'MISSING_SWITCH_DEFAULT'))
})

test('validateFlowGraph allows saving an empty draft when runnable checks are disabled', () => {
  const graph: FlowGraph = { nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }
  assert.equal(validateFlowGraph(graph).ok, false)
  assert.equal(validateFlowGraph(graph, { requireRunnable: false }).ok, true)
})

test('validateFlowGraph checks trigger configuration', () => {
  const invalidType: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'mystery' } } }],
    edges: [],
  }
  assert.ok(validateFlowGraph(invalidType, { requireRunnable: false }).errors.some((issue) => issue.code === 'INVALID_TRIGGER_TYPE'))

  const missingCron: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'schedule', schedule: { type: 'cron' } } } }],
    edges: [],
  }
  assert.ok(validateFlowGraph(missingCron, { requireRunnable: false }).errors.some((issue) => issue.code === 'MISSING_CRON'))

  const duplicateInputFields: FlowGraph = {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'manual', inputFields: [{ name: 'account', type: 'string' }, { name: 'account', type: 'number' }] } },
      },
    ],
    edges: [],
  }
  assert.ok(validateFlowGraph(duplicateInputFields, { requireRunnable: false }).errors.some((issue) => issue.code === 'DUPLICATE_INPUT_FIELD'))
})

test('warns when a step maps fields from a text-only agent', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'agentA' } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.test', body: 'score: {{step.a1.output.score}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'h1' },
    ],
  } as FlowGraph
  const result = validateFlowGraph(graph, { agents: [{ id: 'agentA', title: 'A' }] })
  assert.ok(result.warnings.some((w) => w.code === 'TEXT_AGENT_FIELD_REF' && w.nodeId === 'h1'))
})

test('no field-ref warning for structured agents or whole-output references', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'agentA', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }] } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.test', body: '{{step.a1.output.score}} and {{step.a1.output}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'h1' },
    ],
  } as FlowGraph
  const result = validateFlowGraph(graph, { agents: [{ id: 'agentA', title: 'A' }] })
  assert.equal(result.warnings.some((w) => w.code === 'TEXT_AGENT_FIELD_REF'), false)
})

// Flow steps no longer pause on approvals — a delivery-plane (nango) write
// runs inline anywhere in the graph, including loop bodies and parallel
// branches, so the flow executes end to end.
test('allows an approval-free (nango) tool inside a loop body', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['send'] } },
      { id: 'send', type: 'tool', data: { label: 'Post message', connectionId: 'nango:slack', toolName: 'slack_post_message', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.equal(result.errors.some((entry) => entry.code === 'APPROVAL_IN_CONTAINER'), false)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

test('allows a nango tool inside a parallel branch', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'par', type: 'parallel', data: { branches: [['send'], ['other']] } },
      { id: 'send', type: 'tool', data: { connectionId: 'nango:gmail', toolName: 'gmail_send_email', args: '{}' } },
      { id: 'other', type: 'tool', data: { connectionId: 'mcp-row-2', toolName: 'search_things', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'par' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.equal(result.errors.some((entry) => entry.code === 'APPROVAL_IN_CONTAINER'), false)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

test('allows the same nango tool on the spine, outside any container', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'send', type: 'tool', data: { connectionId: 'nango:slack', toolName: 'slack_post_message', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'send' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.equal(result.errors.some((entry) => entry.code === 'APPROVAL_IN_CONTAINER'), false)
  assert.equal(result.ok, true)
})

test('allows a non-approval (mcp) tool inside a loop body', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['read'] } },
      { id: 'read', type: 'tool', data: { connectionId: 'mcp-row-1', toolName: 'search_things', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.equal(result.errors.some((entry) => entry.code === 'APPROVAL_IN_CONTAINER'), false)
  assert.equal(result.ok, true)
})

test('validateFlowGraph accepts a well-formed variable flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'count' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph requires a variable name and values for set/append', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: '' } },
      { id: 'v2', type: 'variable', data: { op: 'initialize', name: 'log' } },
      { id: 'v3', type: 'variable', data: { op: 'appendString', name: 'log', value: '' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_VARIABLE_NAME' && issue.nodeId === 'v1'))
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_VARIABLE_VALUE' && issue.nodeId === 'v3'))
})

test('validateFlowGraph rejects duplicate variable initializations', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count' } },
      { id: 'v2', type: 'variable', data: { op: 'initialize', name: 'count' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'DUPLICATE_VARIABLE'))
})

test('validateFlowGraph rejects mutations of variables that are never or only later initialized', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'set', name: 'ghost', value: 'x' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'late' } },
      { id: 'v3', type: 'variable', data: { op: 'initialize', name: 'late', varType: 'integer' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'UNINITIALIZED_VARIABLE' && issue.nodeId === 'v1'))
  assert.ok(result.errors.some((issue) => issue.code === 'UNINITIALIZED_VARIABLE' && issue.nodeId === 'v2'))
})

test('validateFlowGraph rejects increment/decrement on non-numeric variables', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'greeting' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'VARIABLE_NOT_NUMERIC' && issue.nodeId === 'v2'))
})

test('validateFlowGraph accepts a well-formed data operation flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'join', input: '{{trigger.input}}', separator: ', ' } },
      { id: 'd2', type: 'data', data: { op: 'select', input: '{{step.d1.output}}', fields: [{ name: 'x', value: '{{item}}' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'd2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph requires an input on every data operation', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'compose', input: '' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'd1' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_DATA_INPUT' && issue.nodeId === 'd1'))
})

test('validateFlowGraph requires clauses on filter array and fields on select', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'filterArray', input: '{{trigger.input}}' } },
      { id: 'd2', type: 'data', data: { op: 'select', input: '{{trigger.input}}', fields: [] } },
      { id: 'd3', type: 'data', data: { op: 'select', input: '{{trigger.input}}', fields: [{ name: '', value: '{{item}}' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'd2' },
      { id: 'e2', source: 'd2', target: 'd3' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'EMPTY_DATA_CLAUSES' && issue.nodeId === 'd1'))
  assert.ok(result.errors.some((issue) => issue.code === 'EMPTY_DATA_FIELDS' && issue.nodeId === 'd2'))
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_DATA_FIELD_NAME' && issue.nodeId === 'd3'))
})

test('validateFlowGraph requires a reviewer message on humanReview steps', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'hr', type: 'humanReview', data: { message: '   ' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'hr' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(
    result.errors.some(
      (issue) =>
        issue.code === 'MISSING_REVIEW_MESSAGE' &&
        issue.nodeId === 'hr' &&
        issue.message === 'Request information needs a message for the reviewer.',
    ),
  )
})

test('validateFlowGraph accepts a humanReview step with a message and optional assignee', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'hr', type: 'humanReview', data: { message: 'What segment should we target?', assigneeUserId: 'user-1' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'hr' }],
  }
  const result = validateFlowGraph(graph)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph warns (not errors) on a humanReview step inside a loop or parallel branch', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'l1', type: 'loop', data: { over: '{{trigger.input}}', body: ['hr1'] } },
      { id: 'hr1', type: 'humanReview', data: { message: 'Approve this item?' } },
      { id: 'p1', type: 'parallel', data: { branches: [['hr2']] } },
      { id: 'hr2', type: 'humanReview', data: { message: 'Anything to add?' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'l1' },
      { id: 'e1', source: 'l1', target: 'p1' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, true) // warning only — the flow stays runnable
  for (const nodeId of ['hr1', 'hr2']) {
    const issue = result.warnings.find((entry) => entry.code === 'HUMAN_REVIEW_IN_CONTAINER' && entry.nodeId === nodeId)
    assert.ok(issue, `expected a container warning for ${nodeId}`)
    assert.match(issue!.message, /one at a time/)
  }
})

test('validateFlowGraph does not warn on a humanReview step in the main flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'hr', type: 'humanReview', data: { message: 'What segment should we target?' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'hr' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(!result.warnings.some((entry) => entry.code === 'HUMAN_REVIEW_IN_CONTAINER'))
})

test('condition inside a loop body is flagged, not silently skipped', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'c1', type: 'condition', data: { left: '{{item}}', op: 'eq', right: 'x' } },
      { id: 'lp', type: 'loop', data: { over: '{{trigger.input}}', body: ['c1'] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'lp' }],
  }
  const { issues } = validateFlowGraph(graph)
  const hit = issues.find((i) => i.code === 'CONTAINER_BRANCHING_UNSUPPORTED')
  assert.ok(hit, 'expected CONTAINER_BRANCHING_UNSUPPORTED')
  assert.equal(hit?.level, 'error')
  assert.equal(hit?.nodeId, 'c1')
})

test('switch inside a parallel branch is flagged too', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's1', type: 'switch', data: { cases: [] } },
      { id: 'par', type: 'parallel', data: { branches: [['s1']] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'par' }],
  }
  const { issues } = validateFlowGraph(graph)
  const hit = issues.find((i) => i.code === 'CONTAINER_BRANCHING_UNSUPPORTED')
  assert.ok(hit, 'expected CONTAINER_BRANCHING_UNSUPPORTED for switch-in-parallel')
  assert.equal(hit?.nodeId, 's1')
})

test('a node id containing # is rejected (reserved for per-iteration keys)', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'bad#id', type: 'stop', data: {} },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'bad#id' }],
  }
  const { issues } = validateFlowGraph(graph)
  assert.ok(issues.find((i) => i.code === 'INVALID_NODE_ID'), 'expected INVALID_NODE_ID')
})

test('a switch on the main chain is NOT flagged', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's1', type: 'switch', data: { cases: [] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 's1' }],
  }
  const { issues } = validateFlowGraph(graph)
  assert.equal(issues.find((i) => i.code === 'CONTAINER_BRANCHING_UNSUPPORTED'), undefined)
})

test('join inside a loop body is flagged, not silently corrupting the merge', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'j1', type: 'join', data: {} },
      { id: 'lp', type: 'loop', data: { over: '{{trigger.input}}', body: ['j1'] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'lp' }],
  }
  const { issues } = validateFlowGraph(graph)
  const hit = issues.find((i) => i.code === 'CONTAINER_JOIN_UNSUPPORTED')
  assert.ok(hit, 'expected CONTAINER_JOIN_UNSUPPORTED')
  assert.equal(hit?.level, 'error')
  assert.equal(hit?.nodeId, 'j1')
})

test('a join on the main chain is NOT flagged', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'j1', type: 'join', data: {} },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'j1' }],
  }
  const { issues } = validateFlowGraph(graph)
  assert.equal(issues.find((i) => i.code === 'CONTAINER_JOIN_UNSUPPORTED'), undefined)
})

test('output node with a valid named output passes', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { outputs: [{ name: 'summary', value: '{{trigger.input}}', type: 'text' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'out' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('output node with an empty output name is an error', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { outputs: [{ name: '', value: 'x' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'out' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  const issue = result.errors.find((i) => i.code === 'MISSING_OUTPUT_NAME')
  assert.ok(issue, 'expected MISSING_OUTPUT_NAME')
  assert.match(issue!.message, /needs a name/)
})

test('output node with duplicate output names is an error', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { outputs: [{ name: 'dupe', value: '1' }, { name: 'dupe', value: '2' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'out' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((i) => i.code === 'DUPLICATE_OUTPUT_NAME' && i.message.includes('dupe')))
})

test('output node with an empty outputs array is an error', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { outputs: [] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'out' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  const issue = result.errors.find((i) => i.code === 'EMPTY_OUTPUT')
  assert.ok(issue, 'expected EMPTY_OUTPUT')
  assert.match(issue!.message, /needs at least one output/)
})

test('output node with a blank value warns but does not error', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { outputs: [{ name: 'summary', value: '' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'out' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, true) // a blank value is a nudge, not a blocker
  assert.ok(result.warnings.some((i) => i.code === 'EMPTY_OUTPUT_VALUE' && i.message.includes('summary')))
})

test('two empty output names read distinctly (indexed message)', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { outputs: [{ name: '', value: '1' }, { name: '', value: '2' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'out' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  const missing = result.errors.filter((i) => i.code === 'MISSING_OUTPUT_NAME')
  assert.equal(missing.length, 2)
  assert.notEqual(missing[0].message, missing[1].message) // indexed — the two reads differ
})

test('validateFlowGraph accepts a well-formed ask step with no findings', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'ai1', type: 'ai', data: { aiOp: 'ask', input: 'What is the sentiment of {{trigger.input}}?' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'ai1' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('validateFlowGraph warns (not errors) on a blank ai input', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'ai1', type: 'ai', data: { aiOp: 'ask', input: '   ' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'ai1' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, true) // a nudge, not a blocker — mirrors EMPTY_AGENT_INPUT
  assert.ok(result.warnings.some((issue) => issue.code === 'AI_EMPTY_INPUT' && issue.nodeId === 'ai1'))
  assert.match(result.warnings.find((issue) => issue.code === 'AI_EMPTY_INPUT')?.message ?? '', /Ask AI has an empty input\./)
})

test('validateFlowGraph requires a named output field on an extract step', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'ai1', type: 'ai', data: { aiOp: 'extract', input: '{{trigger.input}}', label: 'Pull fields' } },
      { id: 'ai2', type: 'ai', data: { aiOp: 'extract', input: '{{trigger.input}}', outputFields: [{ name: '  ', type: 'any' }] } },
      { id: 'ai3', type: 'ai', data: { aiOp: 'extract', input: '{{trigger.input}}', outputFields: [{ name: 'amount', type: 'number' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'ai1' },
      { id: 'e2', source: 'ai1', target: 'ai2' },
      { id: 'e3', source: 'ai2', target: 'ai3' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  const issue = result.errors.find((entry) => entry.code === 'AI_EXTRACT_NO_FIELDS' && entry.nodeId === 'ai1')
  assert.ok(issue, 'expected AI_EXTRACT_NO_FIELDS for a node with no output fields at all')
  assert.equal(issue?.message, 'Pull fields needs at least one field to extract.')
  assert.ok(
    result.errors.some((entry) => entry.code === 'AI_EXTRACT_NO_FIELDS' && entry.nodeId === 'ai2'),
    'expected AI_EXTRACT_NO_FIELDS for a node whose only field has a blank name',
  )
  assert.equal(result.errors.some((entry) => entry.code === 'AI_EXTRACT_NO_FIELDS' && entry.nodeId === 'ai3'), false)
})

test('validateFlowGraph requires at least two non-blank categories on a categorize step', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'ai1', type: 'ai', data: { aiOp: 'categorize', input: '{{trigger.input}}' } },
      { id: 'ai2', type: 'ai', data: { aiOp: 'categorize', input: '{{trigger.input}}', categories: ['Urgent', '  '] } },
      { id: 'ai3', type: 'ai', data: { aiOp: 'categorize', input: '{{trigger.input}}', categories: ['Urgent', 'Later'] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'ai1' },
      { id: 'e2', source: 'ai1', target: 'ai2' },
      { id: 'e3', source: 'ai2', target: 'ai3' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  const issue = result.errors.find((entry) => entry.code === 'AI_CATEGORIZE_TOO_FEW' && entry.nodeId === 'ai1')
  assert.ok(issue, 'expected AI_CATEGORIZE_TOO_FEW when categories is unset')
  assert.equal(issue?.message, 'Categorize needs at least two categories.')
  assert.ok(
    result.errors.some((entry) => entry.code === 'AI_CATEGORIZE_TOO_FEW' && entry.nodeId === 'ai2'),
    'expected AI_CATEGORIZE_TOO_FEW when only one category is non-blank',
  )
  assert.equal(result.errors.some((entry) => entry.code === 'AI_CATEGORIZE_TOO_FEW' && entry.nodeId === 'ai3'), false)
})

test('validateFlowGraph rejects a score step whose minimum is not below its maximum', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'ai1', type: 'ai', data: { aiOp: 'score', input: '{{trigger.input}}', scoreMin: 10, scoreMax: 1 } },
      { id: 'ai2', type: 'ai', data: { aiOp: 'score', input: '{{trigger.input}}', scoreMin: 5, scoreMax: 5 } },
      { id: 'ai3', type: 'ai', data: { aiOp: 'score', input: '{{trigger.input}}', scoreMin: 1, scoreMax: 10 } },
      { id: 'ai4', type: 'ai', data: { aiOp: 'score', input: '{{trigger.input}}', scoreMin: 1 } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'ai1' },
      { id: 'e2', source: 'ai1', target: 'ai2' },
      { id: 'e3', source: 'ai2', target: 'ai3' },
      { id: 'e4', source: 'ai3', target: 'ai4' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((entry) => entry.code === 'AI_SCORE_BAD_RANGE' && entry.nodeId === 'ai1'))
  assert.ok(
    result.errors.some((entry) => entry.code === 'AI_SCORE_BAD_RANGE' && entry.nodeId === 'ai2'),
    'equal bounds are also an invalid range',
  )
  assert.equal(result.errors.some((entry) => entry.code === 'AI_SCORE_BAD_RANGE' && entry.nodeId === 'ai3'), false)
  assert.equal(
    result.errors.some((entry) => entry.code === 'AI_SCORE_BAD_RANGE' && entry.nodeId === 'ai4'),
    false,
    'a lone bound with nothing to compare against is not yet a bad range',
  )
})

test('a graph with a cycle is rejected with CYCLE', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'x' } },
      { id: 'b', type: 'agent', data: { agentId: 'x', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' }, // back-edge → cycle
    ],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'x', title: 'X' }] })
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.code === 'CYCLE'))
})

test('a multi-incoming (fan-in) graph is valid', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'x' } },
      { id: 'b', type: 'agent', data: { agentId: 'x', input: 'x' } },
      { id: 'j', type: 'agent', data: { agentId: 'x', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'a', target: 'j' },
      { id: 'e3', source: 'b', target: 'j' },
    ],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'x', title: 'X' }] })
  assert.ok(result.ok, JSON.stringify(result.issues))
})

test('a perItem step with no list source is flagged', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'ai', data: { aiOp: 'summarize', input: '{{item}}', perItem: { over: '' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_PERITEM_SOURCE'))
})

test('a perItem step with a list source is valid', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'ai', data: { aiOp: 'summarize', input: '{{item}}', perItem: { over: '{{trigger.input}}' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.ok, JSON.stringify(result.issues))
})

test('a nango tool fans out per item without an approval gate', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'nango:slack_post_message', toolName: 'slack_post_message', args: '{}', perItem: { over: '{{trigger.input}}' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 't' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.errors.some((issue) => issue.code === 'APPROVAL_IN_PERITEM'), false)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

test('an HTTP step accepts one available per-user credential resolver', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'http', type: 'http', data: { method: 'GET', url: 'https://api.example.com', credentialResolverId: 'resolver-1' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'http' }],
  }
  const valid = validateFlowGraph(graph, { credentialResolvers: [{ id: 'resolver-1' }] })
  assert.equal(valid.ok, true, JSON.stringify(valid.issues))
  const missing = validateFlowGraph(graph, { credentialResolvers: [] })
  assert.ok(missing.errors.some((issue) => issue.code === 'UNKNOWN_CREDENTIAL_RESOLVER'))
})

test('an HTTP step rejects concrete and per-user credentials together', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'http', type: 'http', data: { method: 'GET', url: 'https://api.example.com', credentialId: 'credential-1', credentialResolverId: 'resolver-1' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'http' }],
  }
  const result = validateFlowGraph(graph, {
    httpCredentials: [{ id: 'credential-1' }],
    credentialResolvers: [{ id: 'resolver-1' }],
  })
  assert.ok(result.errors.some((issue) => issue.code === 'AMBIGUOUS_HTTP_AUTH'))
})
