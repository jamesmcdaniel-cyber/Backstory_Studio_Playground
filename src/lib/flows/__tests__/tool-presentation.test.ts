import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  groupToolConnections,
  selectedToolPresentation,
  toolActionChoices,
  toolConnectionBrand,
} from '@/lib/flows/tool-presentation'

const catalog = [
  {
    id: 'nango:slack_user_post_message',
    name: 'Slack',
    tools: [{ name: 'slack_user_post_message', description: 'Post a message', inputSchema: { type: 'object', properties: { channel: { type: 'string' } } } }],
  },
  {
    id: 'nango:slack_list_channels',
    name: 'Slack',
    tools: [{ name: 'slack_list_channels', description: 'List channels', inputSchema: { type: 'object', properties: {} } }],
  },
  {
    id: 'native:slack',
    name: 'Slack',
    tools: [{ name: 'send_message', description: 'Send with the workspace bot', inputSchema: { type: 'object', properties: {} } }],
  },
  {
    id: 'backstory-mcp-id',
    name: 'Backstory MCP',
    tools: [{ name: 'search', description: 'Search Backstory' }],
  },
  {
    id: 'native:granola',
    name: 'Granola',
    tools: [{ name: 'get_meetings', description: 'Get meetings' }],
  },
]

test('synthetic Nango action connections resolve to their provider brand', () => {
  assert.deepEqual(toolConnectionBrand(catalog[0]), {
    key: 'slack',
    label: 'Slack',
    slug: 'slack',
  })
})

test('provider grouping coalesces Slack actions without mixing other integrations', () => {
  const groups = groupToolConnections(catalog)
  const slack = groups.find((group) => group.brand.key === 'slack')
  assert.ok(slack)
  assert.equal(slack.connections.length, 3)
  assert.equal(groups.length, 3)

  const actions = toolActionChoices(catalog, catalog[0])
  assert.deepEqual(actions.map((action) => action.connectionId), [
    'nango:slack_user_post_message',
    'nango:slack_list_channels',
    'native:slack',
  ])
  assert.equal(actions.some((action) => action.connectionId === 'backstory-mcp-id'), false)
  assert.equal(actions.some((action) => action.connectionId === 'native:granola'), false)
})

test('selected action presentation keeps provider logo and concrete schema together', () => {
  const selected = selectedToolPresentation(catalog, 'nango:slack_user_post_message', 'slack_user_post_message')
  assert.equal(selected.brand?.slug, 'slack')
  assert.equal(selected.brand?.label, 'Slack')
  assert.equal(selected.tool?.description, 'Post a message')
  assert.deepEqual(selected.tool?.inputSchema, {
    type: 'object',
    properties: { channel: { type: 'string' } },
  })
})
