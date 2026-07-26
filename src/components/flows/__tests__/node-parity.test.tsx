import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { StepCard } from '@/components/flows/step-card'
import type { FlowNode } from '@/lib/flows/graph'

const toolCatalog = [
  {
    id: 'nango:slack_user_post_message',
    name: 'Slack',
    tools: [
      {
        name: 'slack_user_post_message',
        description: 'Post a message',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Slack channel' },
            text: { type: 'string', description: 'Slack message' },
          },
          required: ['channel', 'text'],
        },
      },
    ],
  },
  {
    id: 'nango:slack_list_channels',
    name: 'Slack',
    tools: [{ name: 'slack_list_channels', description: 'List Slack channels', inputSchema: { type: 'object', properties: {} } }],
  },
  {
    id: 'backstory-mcp-id',
    name: 'Backstory MCP',
    tools: [
      {
        name: 'search_backstory',
        description: 'Search Backstory',
        inputSchema: { type: 'object', properties: { backstoryQuery: { type: 'string' } } },
      },
    ],
  },
]

function renderCard(node: FlowNode, onChange: (next: FlowNode) => void = () => {}) {
  return render(
    React.createElement(StepCard, {
      node,
      title: 'Test step',
      selected: true,
      agents: [],
      toolCatalog,
      dataFields: [],
      labelCtx: {} as never,
      onChange,
      onClick: () => {},
    }),
  )
}

test('configured Slack node shows Slack branding, Slack actions, and only the selected Slack schema', () => {
  const node = {
    id: 'tool1',
    type: 'tool',
    data: {
      connectionId: 'nango:slack_user_post_message',
      toolName: 'slack_user_post_message',
      args: '{}',
    },
  } as FlowNode
  const { container } = renderCard(node)

  assert.ok(container.querySelector('img[src="/logos/slack.png"]'), 'Slack logo renders')
  assert.match(container.textContent ?? '', /Slack/)
  assert.match(container.textContent ?? '', /channel/)
  assert.match(container.textContent ?? '', /text/)
  assert.doesNotMatch(container.textContent ?? '', /Backstory MCP/)
  assert.doesNotMatch(container.textContent ?? '', /backstoryQuery/)

  const optionLabels = Array.from(container.querySelectorAll('option')).map((option) => option.textContent)
  assert.ok(optionLabels.some((label) => label?.includes('User post message')))
  assert.ok(optionLabels.some((label) => label?.includes('List channels')))
  assert.equal(optionLabels.some((label) => label?.includes('Search Backstory')), false)
  cleanup()
})

test('editing one inline condition preserves every other clause', () => {
  let latest: FlowNode | null = null
  const node = {
    id: 'condition1',
    type: 'condition',
    data: {
      match: 'all',
      clauses: [
        { left: 'account.tier', op: 'eq', right: 'enterprise' },
        { left: 'account.active', op: 'eq', right: 'true' },
      ],
    },
  } as FlowNode
  const { getByLabelText } = renderCard(node, (next) => { latest = next })

  fireEvent.change(getByLabelText('Condition 1 operator'), { target: { value: 'contains' } })

  const clauses = (latest as Extract<FlowNode, { type: 'condition' }> | null)?.data.clauses
  assert.equal(clauses?.length, 2)
  assert.deepEqual(clauses?.[1], { left: 'account.active', op: 'eq', right: 'true' })
  cleanup()
})

test('editing one inline switch case preserves every other case', () => {
  let latest: FlowNode | null = null
  const node = {
    id: 'switch1',
    type: 'switch',
    data: {
      cases: [
        { id: 'case1', label: 'Enterprise', left: 'account.tier', op: 'eq', right: 'enterprise' },
        { id: 'case2', label: 'SMB', left: 'account.tier', op: 'eq', right: 'smb' },
      ],
    },
  } as FlowNode
  const { getByLabelText } = renderCard(node, (next) => { latest = next })

  fireEvent.change(getByLabelText('Case 1 label'), { target: { value: 'Strategic' } })

  const cases = (latest as Extract<FlowNode, { type: 'switch' }> | null)?.data.cases
  assert.equal(cases?.length, 2)
  assert.deepEqual(cases?.[1], { id: 'case2', label: 'SMB', left: 'account.tier', op: 'eq', right: 'smb' })
  cleanup()
})
