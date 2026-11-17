import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { validateFlowGraph, type FlowValidationContext } from '@/lib/flows/validate'
import { pollFailure } from '@/lib/flows/poll'
import { flowToolWriteClass } from '@/features/agents/tool-planes'
import { pollableTool } from '@/components/flows/trigger-editor'

/**
 * The poller calls its tool every check with no person to approve anything, so
 * it refuses write tools and tools held for approval, and a tool missing a
 * required input just fails. Each used to publish fine and then never fire.
 * Publish (and the builder's checker) now say so up front.
 */

const graphWith = (trigger: Record<string, unknown>): FlowGraph =>
  ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger } },
      { id: 'note', type: 'note', data: { text: 'x', color: 'yellow' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'note' }],
  }) as unknown as FlowGraph

const poll = (overrides: Record<string, unknown> = {}) => ({
  type: 'poll',
  connectionId: 'conn-1',
  toolName: 'list_issues',
  schedule: { type: 'hourly', isActive: true },
  ...overrides,
})

const catalog: NonNullable<FlowValidationContext['toolCatalog']> = [
  {
    id: 'conn-1',
    name: 'Tracker',
    tools: [
      { name: 'list_issues', inputSchema: { type: 'object', properties: {} } },
      { name: 'search_issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      { name: 'create_issue', isWrite: true },
      { name: 'list_secrets', needsApproval: true },
    ],
    blockedTools: ['delete_everything'],
  },
  { id: 'native:snowflake', name: 'Snowflake', tools: [{ name: 'snowflake_sql_query', writeDependsOnArgs: true, isWrite: undefined }] },
  { id: 'conn-down', name: 'Down', tools: [], toolsError: 'reconnect' },
]

const codes = (trigger: Record<string, unknown>, context: FlowValidationContext = { toolCatalog: catalog, checkPollTool: true }) =>
  validateFlowGraph(graphWith(trigger), context).errors.map((issue) => issue.code).filter((code) => /POLL/.test(code))

test('a read tool with its inputs passes', () => {
  assert.deepEqual(codes(poll()), [])
  assert.deepEqual(codes(poll({ toolName: 'search_issues', args: '{"q":"bug"}' })), [])
})

test('write, approval-gated, blocked and unknown tools are blocking errors', () => {
  assert.deepEqual(codes(poll({ toolName: 'create_issue' })), ['POLL_TOOL_WRITES'])
  assert.deepEqual(codes(poll({ toolName: 'list_secrets' })), ['POLL_TOOL_NEEDS_APPROVAL'])
  assert.deepEqual(codes(poll({ toolName: 'delete_everything' })), ['POLL_TOOL_BLOCKED'])
  assert.deepEqual(codes(poll({ toolName: 'nope' })), ['UNKNOWN_POLL_TOOL'])
  assert.deepEqual(codes(poll({ connectionId: 'gone' })), ['UNKNOWN_POLL_CONNECTION'])
  assert.deepEqual(codes(poll({ connectionId: 'conn-down' })), ['POLL_CONNECTION_UNAVAILABLE'])
})

test('a required input with no value, or inputs that are not an object, block', () => {
  assert.deepEqual(codes(poll({ toolName: 'search_issues' })), ['MISSING_POLL_TOOL_ARG'])
  assert.deepEqual(codes(poll({ toolName: 'search_issues', args: '{"q":""}' })), ['MISSING_POLL_TOOL_ARG'])
  assert.deepEqual(codes(poll({ args: '[1]' })), ['INVALID_POLL_ARGS'])
})

test('a per-call-classified tool is judged by its inputs', () => {
  const sql = (statement?: string) =>
    poll({ connectionId: 'native:snowflake', toolName: 'snowflake_sql_query', ...(statement ? { args: JSON.stringify({ statement }) } : {}) })
  assert.deepEqual(codes(sql('SELECT id FROM accounts')), [])
  assert.deepEqual(codes(sql('DELETE FROM accounts')), ['POLL_TOOL_WRITES'])
  assert.deepEqual(codes(sql()), ['POLL_TOOL_WRITES'], 'no statement → it CAN write')
})

test('runs and resumes do not check the poll tool (they never poll)', () => {
  assert.deepEqual(codes(poll({ toolName: 'create_issue' }), { toolCatalog: catalog }), [])
  assert.deepEqual(codes(poll({ connectionId: 'gone' }), { toolCatalog: [] }), [])
})

test('flowToolWriteClass mirrors the executor per plane', () => {
  assert.equal(flowToolWriteClass('mcp', 'conn', 'anything'), 'read')
  assert.equal(flowToolWriteClass('people_ai', 'backstory', 'get_account_status'), 'read')
  assert.equal(flowToolWriteClass('native', 'research', 'web_search'), 'read')
  assert.equal(flowToolWriteClass('native', 'snowflake', 'snowflake_sql_query'), 'args')
  assert.equal(flowToolWriteClass('native', 'databricks', 'databricks_files_list'), 'read')
  assert.equal(flowToolWriteClass('native', 'databricks', 'databricks_files_delete'), 'write')
  assert.equal(flowToolWriteClass('native', 'email', 'send_email'), 'write')
  assert.equal(flowToolWriteClass('native', 'no_such_builtin', 'x'), 'write', 'unknown is never a read')
  assert.equal(flowToolWriteClass('nango', 'gmail', 'send'), 'write', 'delivery capabilities always write')
})

test('the poll picker offers reads and per-call tools, never writes or approval-gated tools', () => {
  assert.ok(pollableTool({ name: 'list' }))
  assert.ok(pollableTool({ name: 'sql', isWrite: true, writeDependsOnArgs: true }))
  assert.ok(!pollableTool({ name: 'create', isWrite: true }))
  assert.ok(!pollableTool({ name: 'secret', needsApproval: true }))
})

test('pollFailure reads the failure marker a failed poll leaves on the cursor', () => {
  assert.equal(pollFailure(null), null)
  assert.equal(pollFailure({ seen: ['a'], lastPolledAt: 'x' }), null)
  assert.deepEqual(pollFailure({ lastError: { message: 'boom', at: '2026-01-01T00:00:00.000Z' } }), {
    message: 'boom',
    at: '2026-01-01T00:00:00.000Z',
  })
})
