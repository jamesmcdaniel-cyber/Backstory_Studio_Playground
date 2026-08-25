import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StepCard } from '@/components/flows/step-card'
import { StepDrawer } from '@/components/flows/step-drawer'
import { stepNoteLabel } from '@/components/flows/canvas/step-node'
import type { FlowNode } from '@/lib/flows/graph'
import { AGENT_RUN_MAX_DURATION_SECONDS } from '@/lib/agents/timeouts'

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
  // The selected tool's own arguments, under readable labels rather than the
  // raw schema keys (`channel`, `text`) the form used to print verbatim.
  assert.match(container.textContent ?? '', /Channel/)
  assert.match(container.textContent ?? '', /Text/)
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

test('HTTP card keeps request configuration in the full node workspace', () => {
  const node = {
    id: 'http1',
    type: 'http',
    data: {
      method: 'POST',
      url: 'https://api.example.com',
      bodyMode: 'none',
      body: '{"stale":true}',
    },
  } as FlowNode
  const { container, queryByLabelText } = renderCard(node)

  assert.match(container.textContent ?? '', /Open this node to configure authentication/)
  assert.equal(queryByLabelText('URI'), null)
  assert.equal(queryByLabelText('Body'), null)
  cleanup()
})

test('AI and subflow timeout controls use the runtime max-duration limit', () => {
  const node = {
    id: 'ai1',
    type: 'ai',
    data: { aiOp: 'ask', input: '', instructions: '' },
  } as FlowNode
  const { container } = renderCard(node)

  const showAll = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Show all'))
  assert.ok(showAll)
  fireEvent.click(showAll)

  // Derived from the runtime constant so the pin moves WITH the contract —
  // a hardcoded seconds value here just re-breaks every time the limit moves.
  const timeout = container.querySelector(`input[type="number"][max="${AGENT_RUN_MAX_DURATION_SECONDS}"]`)
  assert.ok(timeout, 'AI timeout accepts the same maximum as its graph/runtime contract')
  cleanup()
})

test('workspace node configuration uses the three-pane input, parameters, and output layout', () => {
  let closed = false
  const node = {
    id: 'http-workspace',
    type: 'http',
    data: {
      method: 'POST',
      url: 'https://api.example.com',
      sendQuery: true,
      sendHeaders: true,
      sendBody: true,
      bodyMode: 'json',
    },
  } as FlowNode
  const { container } = render(
    React.createElement(StepDrawer, {
      layout: 'workspace',
      node,
      flowId: 'flow1',
      agents: [],
      toolCatalog: [],
      dataFields: [{ label: 'Run input', token: '{{trigger.input}}', type: 'string' }],
      labelCtx: {} as never,
      onChange: () => {},
      onChangeType: () => {},
      onDelete: () => {},
      onClose: () => { closed = true },
      rawInput: { customerId: 'cus_123', plan: 'enterprise' },
      rawOutput: { status: 200, body: { ok: true } },
    }),
  )

  assert.ok(container.querySelector('[data-node-configuration="workspace"]'))
  // The Input panel opens on Schema, the way n8n's does: at this width the
  // configure column hides its inline data trees, so this pane is the only
  // click-to-insert surface there is. TokenTextEditor has no picker of its own,
  // so without it the widest layout could not put upstream data into a field.
  assert.ok(container.querySelector('[data-flow-data-tree]'))
  assert.match(container.textContent ?? '', /Run input/)
  // …and the run's raw data is one click away, still in this pane.
  fireEvent.click(screen.getByRole('tab', { name: 'json' }))
  assert.match(container.textContent ?? '', /"customerId": "cus_123"/)
  assert.match(container.textContent ?? '', /"status": 200/)
  assert.match(container.textContent ?? '', /Authentication/)
  assert.ok(container.querySelector('[aria-label="Send query parameters"]'))
  assert.ok(container.querySelector('[aria-label="Send headers"]'))
  assert.ok(container.querySelector('[aria-label="Send body"]'))
  assert.ok(container.querySelector('[aria-label="Query parameters input mode"]'))
  assert.ok(container.querySelector('[aria-label="Headers input mode"]'))
  assert.ok(container.querySelector('[aria-label="Request body"]'))
  assert.ok(container.querySelector('[aria-label="Request URL"]'))
  fireEvent.keyDown(window, { key: 'Escape' })
  assert.equal(closed, true)
  cleanup()
})

function renderDrawer(node: FlowNode, props: Record<string, unknown> = {}) {
  return render(
    React.createElement(StepDrawer, {
      layout: 'workspace',
      node,
      flowId: 'flow1',
      agents: [],
      toolCatalog: [],
      dataFields: [],
      labelCtx: {} as never,
      onChange: () => {},
      onDelete: () => {},
      onClose: () => {},
      ...props,
    }),
  )
}

test('a finding lands next to the control it is about, not in the step banner', () => {
  const node = { id: 'http1', type: 'http', data: { method: 'GET', url: '' } } as FlowNode
  const { container } = renderDrawer(node, {
    issues: [{ level: 'error', code: 'MISSING_HTTP_URL', message: 'HTTP request needs a URL.' }],
  })

  // Rendered once, at the field — not also in the "This step needs attention" list.
  assert.doesNotMatch(container.textContent ?? '', /This step needs attention/)
  const marked = container.querySelector('[data-field-issues]')
  assert.ok(marked, 'the finding renders at a field')
  assert.match(marked.textContent ?? '', /HTTP request needs a URL/)

  // The URL input is the control it sits under.
  const urlField = container.querySelector('[aria-label="Request URL"]')?.closest('div')
  assert.ok(urlField?.contains(marked), 'the finding sits with the URL input')
  cleanup()
})

test('a finding that belongs to no control keeps the step banner', () => {
  const node = { id: 'http1', type: 'http', data: { method: 'GET', url: 'https://x.test' } } as FlowNode
  const { container } = renderDrawer(node, {
    issues: [{ level: 'error', code: 'CYCLE', message: 'These steps form a loop.' }],
  })

  assert.match(container.textContent ?? '', /This step needs attention/)
  assert.match(container.textContent ?? '', /These steps form a loop/)
  assert.equal(container.querySelector('[data-field-issues]'), null)
  cleanup()
})

test('a step can be renamed from the panel that configures it', () => {
  let latest: FlowNode | null = null
  // HTTP specifically: it had no name field of its own at all.
  const node = { id: 'http1', type: 'http', data: { method: 'GET', url: 'https://x.test' } } as FlowNode
  const { getByLabelText } = renderDrawer(node, { onChange: (next: FlowNode) => { latest = next } })

  fireEvent.change(getByLabelText('Step name'), { target: { value: 'Fetch invoices' } })

  assert.equal(((latest as FlowNode | null)?.data as { label?: string }).label, 'Fetch invoices')
  cleanup()
})

test('a step can be taken out of the run without losing its configuration', () => {
  let latest: FlowNode | null = null
  const node = { id: 'http1', type: 'http', data: { method: 'GET', url: 'https://x.test' } } as FlowNode
  const { getByText } = renderDrawer(node, { onChange: (next: FlowNode) => { latest = next } })

  fireEvent.click(getByText('Disable step'))

  assert.equal((latest as FlowNode | null)?.disabled, true)
  assert.equal(((latest as FlowNode | null)?.data as { url?: string }).url, 'https://x.test', 'configuration survives')
  cleanup()
})

test('the settings in force are readable without expanding the advanced section', () => {
  const node = {
    id: 'http1',
    type: 'http',
    data: { method: 'GET', url: 'https://x.test', onError: 'continue', retries: 3 },
  } as FlowNode
  const { container } = renderDrawer(node)

  assert.match(container.textContent ?? '', /Continues on error/)
  assert.match(container.textContent ?? '', /3 retries/)
  cleanup()
})

test('a disabled step says so in the panel that configures it', () => {
  const node = {
    id: 'http1',
    type: 'http',
    disabled: true,
    data: { method: 'GET', url: 'https://x.test' },
  } as FlowNode
  const { container, getByText } = renderDrawer(node)

  assert.match(container.textContent ?? '', /This step is disabled/)
  // …and the toggle offers the way back.
  assert.ok(getByText('Enable step'))
  cleanup()
})

test('a condition offers the comparisons its field type supports, and no others', () => {
  const node = {
    id: 'condition1',
    type: 'condition',
    data: { match: 'all', clauses: [{ left: '{{steps.lookup.employees}}', op: 'gt', right: '100' }] },
  } as FlowNode
  const { getByLabelText } = render(
    React.createElement(StepCard, {
      node,
      title: 'Test step',
      selected: true,
      agents: [],
      toolCatalog,
      dataFields: [{ label: 'Employees', token: '{{steps.lookup.employees}}', type: 'number' }],
      labelCtx: {} as never,
      onChange: () => {},
      onClick: () => {},
    }),
  )

  const values = Array.from((getByLabelText('Condition 1 operator') as HTMLSelectElement).options).map((o) => o.value)
  assert.ok(values.includes('gt') && values.includes('lte'))
  // The evaluator would not fail on these — it would string-compare and answer
  // confidently wrong. Not offering them is what prevents that.
  assert.ok(!values.includes('startsWith'))
  assert.ok(!values.includes('before'))
  cleanup()
})

test('a condition never loses the operator it was saved with', () => {
  const node = {
    id: 'condition1',
    type: 'condition',
    data: { match: 'all', clauses: [{ left: '{{steps.lookup.employees}}', op: 'startsWith', right: '1' }] },
  } as FlowNode
  const { getByLabelText } = render(
    React.createElement(StepCard, {
      node,
      title: 'Test step',
      selected: true,
      agents: [],
      toolCatalog,
      dataFields: [{ label: 'Employees', token: '{{steps.lookup.employees}}', type: 'number' }],
      labelCtx: {} as never,
      onChange: () => {},
      onClick: () => {},
    }),
  )

  const select = getByLabelText('Condition 1 operator') as HTMLSelectElement
  assert.equal(select.value, 'startsWith', 'a flow saved before the narrowing still shows its choice')
  cleanup()
})

test("a step's note is what the canvas shows under it", () => {
  // The note explains why the step exists — what a reader six months later most
  // needs — and it reached nobody who did not already open that step.
  const note = 'Rate limited — 30 requests a minute'
  assert.equal(stepNoteLabel({ id: 'n', type: 'http', data: { note } } as FlowNode), note)
  assert.equal(stepNoteLabel({ id: 'n', type: 'http', data: { note: '   ' } } as FlowNode), '')
  assert.equal(stepNoteLabel({ id: 'n', type: 'http', data: {} } as FlowNode), '')
  // Free text, so a long one is clamped rather than pushing the node out of lane.
  assert.equal(stepNoteLabel({ id: 'n', type: 'http', data: { note: 'x'.repeat(400) } } as FlowNode).length, 120)
})
