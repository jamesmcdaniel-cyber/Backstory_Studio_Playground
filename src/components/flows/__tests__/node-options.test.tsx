import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { NodeOptions } from '@/components/flows/node-options'
import type { FlowNode } from '@/lib/flows/graph'

const http = (data: Record<string, unknown> = {}) =>
  ({ id: 'n1', type: 'http', data: { method: 'GET', url: 'https://x.test', ...data } }) as unknown as FlowNode

function renderOptions(node: FlowNode, onChange: (next: FlowNode) => void = () => {}) {
  return render(React.createElement(NodeOptions, { node, onChange }))
}

/** The captured node, read back. TS narrows the closure variable to never. */
const dataOf = (node: unknown) => (node as FlowNode).data as Record<string, unknown>

/**
 * The rule this implements is n8n's: a parameter does not exist on screen until
 * you add it. Ours declared a quarter of n8n's configuration and read as the
 * busier panel because every optional setting was already on the page, behind
 * one of four differently-named lids.
 */

test('a fresh step shows one control, not a wall of settings', () => {
  const { container, getByText } = renderOptions(http())
  assert.ok(getByText('Add option'))
  // Nothing added, so no option control is rendered at all.
  assert.equal(container.querySelectorAll('select, input').length, 0)
  cleanup()
})

test('adding an option makes it exist, at a meaningful value', () => {
  let latest: FlowNode | null = null
  const { getByText, getByLabelText } = renderOptions(http(), (next) => { latest = next })

  fireEvent.click(getByText('Add option'))
  fireEvent.change(getByLabelText('Add an option'), { target: { value: 'retries' } })

  // Not an empty control the user then has to fill.
  assert.equal(dataOf(latest).retries, 2)
  cleanup()
})

test('an added option renders, and can be removed again', () => {
  let latest: FlowNode | null = null
  const { getByLabelText } = renderOptions(http({ retries: 3 }), (next) => { latest = next })

  assert.equal((getByLabelText('Max Tries') as HTMLInputElement).value, '3')
  fireEvent.click(getByLabelText('Remove Max Tries'))
  assert.equal(dataOf(latest).retries, undefined)
  cleanup()
})

test('a duration is shown in seconds, and stored in milliseconds', () => {
  // Nobody reasons about a timeout in milliseconds.
  let latest: FlowNode | null = null
  const { getByLabelText } = renderOptions(http({ timeoutMs: 30_000 }), (next) => { latest = next })

  const input = getByLabelText('Timeout') as HTMLInputElement
  assert.equal(input.value, '30')
  fireEvent.change(input, { target: { value: '45' } })
  assert.equal(dataOf(latest).timeoutMs, 45_000)
  cleanup()
})

test('an option that cannot do anything is not offered', () => {
  const { getByText, getByLabelText } = renderOptions(http())
  fireEvent.click(getByText('Add option'))
  const choices = Array.from((getByLabelText('Add an option') as HTMLSelectElement).options).map((o) => o.value)
  assert.ok(!choices.includes('bodyMode'), 'body format on a request that sends no body')
  cleanup()

  const withBody = renderOptions(http({ sendBody: true }))
  fireEvent.click(withBody.getByText('Add option'))
  const withChoices = Array.from((withBody.getByLabelText('Add an option') as HTMLSelectElement).options).map((o) => o.value)
  assert.ok(withChoices.includes('bodyMode'))
  cleanup()
})

test('a value stranded by a later edit says so instead of acting invisibly', () => {
  // Set a body format, then turn the body off. n8n hides the control and keeps
  // the value, so a setting is in force that the panel does not show.
  let latest: FlowNode | null = null
  const { container, getByText } = renderOptions(
    http({ sendBody: false, bodyMode: 'form-data' }),
    (next) => { latest = next },
  )
  assert.match(container.textContent ?? '', /no longer applies to this step/)

  fireEvent.click(getByText('Clear it'))
  assert.equal(dataOf(latest).bodyMode, undefined)
  cleanup()
})
