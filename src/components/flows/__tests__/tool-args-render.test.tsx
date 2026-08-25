import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ToolArgsEditor } from '@/components/flows/tool-args-editor'

/**
 * The argument form is where every app integration in the product is
 * configured, so what it does with a schema is what the product does with an
 * integration. Each case here is something the schema stated and the form used
 * to ignore.
 */

const SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'What to search for.' },
    peopleai_object_id: { type: 'integer', minimum: 1 },
    object_type: { type: 'string', enum: ['account', 'opportunity'] },
    verbose: { type: 'boolean' },
  },
}

function renderEditor(props: Record<string, unknown> = {}) {
  return render(
    React.createElement(ToolArgsEditor, {
      inputSchema: SCHEMA,
      args: '{}',
      onChange: () => {},
      dataFields: [],
      labelCtx: {} as never,
      ...props,
    }),
  )
}

test('a required argument is shown and its optional siblings are folded away', () => {
  const { container, getByText } = renderEditor()

  assert.match(container.textContent ?? '', /Query/)
  // The three optional ones are behind a disclosure, not a wall of empty boxes.
  assert.doesNotMatch(container.textContent ?? '', /Object type/)
  assert.ok(getByText('3 optional settings'))
  cleanup()
})

test('an optional argument that already has a value is never hidden', () => {
  const { container } = renderEditor({ args: '{"object_type":"account"}' })
  // Folding away something the step actually sends would make the form lie.
  assert.match(container.textContent ?? '', /Object type/)
  cleanup()
})

test('expanding reveals the rest, each as the control its schema describes', () => {
  const { container, getByText, getByLabelText } = renderEditor()
  fireEvent.click(getByText('3 optional settings'))

  // An enum is a closed set, so it is a select — not a text box that accepts anything.
  const objectType = getByLabelText('Argument Object type') as HTMLSelectElement
  assert.equal(objectType.tagName, 'SELECT')
  assert.deepEqual(
    Array.from(objectType.options).map((option) => option.value),
    ['', 'account', 'opportunity'],
  )
  // The wire key stays on screen next to the readable label.
  assert.match(container.textContent ?? '', /peopleai_object_id/)
  cleanup()
})

test('a closed set can still be bound to flow data', () => {
  // Binding an argument to an earlier step is the point of the builder; a
  // select alone would make enum arguments the one kind you cannot wire.
  const { getByText, getAllByText, getByLabelText } = renderEditor()
  fireEvent.click(getByText('3 optional settings'))
  // Both closed-set fields offer the escape; take the enum's.
  fireEvent.click(getAllByText('Use flow data')[0])

  const control = getByLabelText('Argument Object type') as HTMLElement
  assert.notEqual(control.tagName, 'SELECT', 'the select gives way to the token editor')
  // jsdom does not implement isContentEditable, so read the attribute.
  assert.equal(control.getAttribute('contenteditable'), 'true')
  cleanup()
})

test('a bound value is reported out of range only when it is a literal number', () => {
  const { container } = renderEditor({ args: '{"peopleai_object_id":"0"}' })
  assert.match(container.textContent ?? '', /accepts 1 or more/)
  cleanup()

  const bound = renderEditor({ args: '{"peopleai_object_id":"{{trigger.input.id}}"}' })
  assert.doesNotMatch(bound.container.textContent ?? '', /accepts 1 or more/)
  cleanup()
})

test('pick-from-a-list is not offered where the endpoint refuses to serve it', () => {
  // MCP executors cannot classify a tool as read or write, so the endpoint
  // will not run one for a picker. Rendering the control anyway was a dead end.
  const mcp = renderEditor({ connectionId: 'mcp:abc123', pickerTools: ['find_account'] })
  assert.doesNotMatch(mcp.container.textContent ?? '', /Pick from a list/)
  cleanup()

  const nango = renderEditor({ connectionId: 'nango:slack_list_channels', pickerTools: ['slack_list_channels'] })
  assert.match(nango.container.textContent ?? '', /Pick from a list/)
  cleanup()
})
