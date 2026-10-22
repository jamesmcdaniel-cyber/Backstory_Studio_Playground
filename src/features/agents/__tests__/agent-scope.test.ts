/**
 * The scope card and the runtime must agree, tool for tool.
 *
 * Both read the same groups through the same functions (agent-tool-resolution);
 * this pins that they reach the same answers, so the card can never say a tool
 * is blocked while a run still gets it, or claim approval the gate won't ask
 * for. The DB-backed twin (agent-scope.db.test.ts) does the same through the
 * real loaders.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoveredToolsFromGroups } from '../agent-tool-resolution'
import { scopeConnectionsFromGroups } from '../agent-scope'
import { requiresApproval } from '@/lib/agents/approval'
import { countScope } from '@/lib/agents/scope-types'
import type { ToolPlaneGroup } from '../tool-planes'

const client = { executeTool: async () => ({}) }
const schema = { type: 'object', properties: {} }

const groups: ToolPlaneGroup[] = [
  {
    id: 'conn-crm', plane: 'mcp', name: 'Acme CRM', provider: 'acme_crm', serverUrl: 'https://crm.invalid/mcp', isWrite: false, client,
    credential: { actsAs: 'workspace' },
    tools: [
      { name: 'lookup', description: 'Look up', inputSchema: schema, annotations: { readOnlyHint: true } },
      { name: 'update_account', description: 'Change', inputSchema: schema, policy: 'approve', annotations: { readOnlyHint: false } },
      { name: 'export_all', description: 'Export', inputSchema: schema },
    ],
    blockedTools: ['delete_everything'],
  },
  {
    id: 'nango:slack', plane: 'nango', name: 'Slack (send)', provider: 'nango:slack', serverUrl: 'nango', isWrite: true, client,
    credential: { actsAs: 'user', nango: { connectionId: 'c1', providerConfigKey: 'slack', scope: 'user' } },
    tools: [{ name: 'slack_post_message', description: 'Post', inputSchema: schema }],
  },
  {
    id: 'nango:slack_list_channels', plane: 'nango', name: 'Slack', provider: 'nango:slack', serverUrl: 'nango', isWrite: false, client,
    credential: { actsAs: 'user' },
    tools: [{ name: 'slack_list_channels', description: 'List', inputSchema: schema }],
  },
  {
    id: 'native:email', plane: 'native', name: 'Email', provider: 'email', serverUrl: 'https://api.resend.com', isWrite: true, client,
    credential: { actsAs: 'workspace' },
    tools: [{ name: 'send_email', description: 'Send', inputSchema: schema }],
  },
  {
    id: 'native:snowflake', plane: 'native', name: 'Snowflake', provider: 'snowflake', serverUrl: 'https://x', isWrite: true, client,
    isWriteFor: (_tool, args) => !/^select/i.test(String(args.statement ?? '')),
    credential: { actsAs: 'workspace' },
    tools: [{ name: 'snowflake_sql_query', description: 'SQL', inputSchema: schema }],
  },
  {
    id: 'nango:gmail', plane: 'nango', name: 'Gmail', provider: 'nango:gmail', serverUrl: '', isWrite: true, tools: [],
    toolsError: 'No connected Gmail account resolved for this workspace — reconnect it in Integrations.',
  },
]

// The agent's allowlist for the CRM server leaves export_all off.
const toolSettings = { 'mcp:conn-crm': [{ id: 'lookup', label: 'lookup' }, { id: 'update_account', label: 'update_account' }] }
const metadata = { requireApproval: true }

const runtime = discoveredToolsFromGroups(groups, toolSettings)
const connections = scopeConnectionsFromGroups(groups, toolSettings, metadata)
const scopeTool = (connection: string, tool: string) => connections.find((c) => c.name === connection)?.tools.find((t) => t.name === tool)
const runtimeBinding = (tool: string) => runtime.discovered.find((d) => d.binding.toolName === tool)?.binding

test('a tool blocked in Integrations is shown blocked and is absent from the runtime tool list', () => {
  assert.deepEqual(scopeTool('Acme CRM', 'delete_everything'), { name: 'delete_everything', label: 'Delete everything', access: 'unclassified', status: 'blocked', blockedBy: 'integration' })
  assert.equal(runtimeBinding('delete_everything'), undefined)
})

test("a tool left off the agent's allowlist is shown blocked by the agent and the run never gets it", () => {
  assert.equal(scopeTool('Acme CRM', 'export_all')?.status, 'blocked')
  assert.equal(scopeTool('Acme CRM', 'export_all')?.blockedBy, 'agent')
  assert.equal(runtimeBinding('export_all'), undefined)
})

test('"Needs approval" in Integrations shows as approval by the integration, and the binding carries the gate', () => {
  assert.equal(scopeTool('Acme CRM', 'update_account')?.status, 'needs_approval')
  assert.equal(scopeTool('Acme CRM', 'update_account')?.approvalBy, 'integration')
  assert.equal(runtimeBinding('update_account')?.needsApproval, true)
})

test("the agent's own approval shows exactly where the gate applies it — and says where it does not", () => {
  assert.equal(scopeTool('Slack', 'slack_post_message')?.status, 'needs_approval')
  assert.equal(scopeTool('Slack', 'slack_post_message')?.approvalBy, 'agent')
  // Resend email is a write the agent-level gate does not hold back.
  assert.equal(scopeTool('Email', 'send_email')?.status, 'allowed')
  assert.equal(requiresApproval(metadata, 'email', true), false)
  // Reads are never gated.
  assert.equal(scopeTool('Slack', 'slack_list_channels')?.status, 'allowed')
  assert.equal(scopeTool('Slack', 'slack_list_channels')?.access, 'read')
})

test('every tool the card offers is a tool the runtime binds, with the same approval answer', () => {
  for (const connection of connections) {
    for (const tool of connection.tools) {
      const binding = runtimeBinding(tool.name)
      if (tool.status === 'blocked') {
        assert.equal(binding, undefined, `${tool.name} is shown blocked but the run gets it`)
        continue
      }
      assert.ok(binding, `${tool.name} is shown available but the run does not get it`)
      const gated = binding.needsApproval === true || ((tool.access === 'write' || tool.access === 'depends') && requiresApproval(metadata, binding.provider, true))
      assert.equal(tool.status === 'needs_approval', gated, `${tool.name}: card and gate disagree`)
    }
  }
  // …and nothing the runtime binds is missing from the card.
  for (const discovered of runtime.discovered) {
    assert.ok(connections.some((c) => c.tools.some((t) => t.name === discovered.binding.toolName && t.status !== 'blocked')), `${discovered.name} is bound but not on the card`)
  }
})

test('per-call write tools read as "depends"; Nango provider groups fold into one connection', () => {
  assert.equal(scopeTool('Snowflake', 'snowflake_sql_query')?.access, 'depends')
  assert.equal(connections.filter((c) => c.name === 'Slack').length, 1)
  assert.equal(connections.find((c) => c.name === 'Slack')?.actsAs, 'user')
})

test('an attached connection that did not resolve is shown unavailable, as the run reports it', () => {
  const gmail = connections.find((c) => c.name === 'Gmail')
  assert.match(gmail?.unavailable ?? '', /No connected Gmail account/)
  assert.ok(runtime.unavailable.some((entry) => entry.name === 'Gmail'))
})

test('write tools carry their undo verdict from the compensator registry', () => {
  assert.deepEqual(scopeTool('Slack', 'slack_post_message')?.undo, { undoable: true, note: 'Deletes the message.' })
  assert.equal(scopeTool('Email', 'send_email')?.undo?.undoable, false)
  assert.equal(scopeTool('Slack', 'slack_list_channels')?.undo, undefined)
})

test('counts add up from the same tools', () => {
  const counts = countScope(connections)
  assert.equal(counts.blocked, 2)
  assert.equal(counts.tools, runtime.discovered.length)
  assert.equal(counts.needsApproval, 3) // update_account, slack_post_message, snowflake (warehouse writes are gated)
})
