import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { CanvasActionsContext, StepNode, type StepNodeData } from '@/components/flows/canvas/step-node'
import { sourceHandlesFor, hasTargetHandle } from '@/lib/flows/canvas-model'
import type { FlowNode } from '@/lib/flows/graph'

/** Render the chip the way the canvas does, with real derived handle data. */
function renderNode(node: FlowNode, overrides: Partial<StepNodeData> = {}) {
  const data: StepNodeData = {
    node,
    title: 'Post to Slack',
    handles: sourceHandlesFor(node),
    hasTarget: hasTargetHandle(node),
    connected: [],
    ...overrides,
  }
  return render(
    React.createElement(
      ReactFlowProvider,
      null,
      React.createElement(StepNode, {
        id: node.id,
        type: 'step',
        data,
        selected: false,
        dragging: false,
        zIndex: 0,
        isConnectable: true,
        positionAbsoluteX: 0,
        positionAbsoluteY: 0,
        deletable: true,
        selectable: true,
        draggable: true,
      } as never),
    ),
  )
}

test('the chip shows the step name and its subtitle', (t) => {
  t.after(cleanup)
  const node: FlowNode = { id: 'a', type: 'agent', data: { agentId: 'x', input: '' } }
  const { container } = renderNode(node, { subtitle: 'Research agent' })
  assert.match(container.textContent ?? '', /Post to Slack/)
  assert.match(container.textContent ?? '', /Research agent/)
})

test('a plain step offers one add-step stub, and none once connected', (t) => {
  t.after(cleanup)
  const node: FlowNode = { id: 'a', type: 'agent', data: { agentId: 'x', input: '' } }
  const open = renderNode(node)
  assert.equal(open.container.querySelectorAll('button[aria-label="Add step"]').length, 1)
  cleanup()
  const wired = renderNode(node, { connected: ['out'] })
  assert.equal(wired.container.querySelectorAll('button[aria-label="Add step"]').length, 0)
})

test('a condition renders a labeled stub per branch', (t) => {
  t.after(cleanup)
  const node: FlowNode = { id: 'c', type: 'condition', data: { match: 'all', clauses: [] } }
  const { container } = renderNode(node)
  assert.ok(container.querySelector('button[aria-label="Add step on Then"]'))
  assert.ok(container.querySelector('button[aria-label="Add step on Otherwise"]'))
})

test('a step routing on failure renders an On error stub alongside its normal one', (t) => {
  t.after(cleanup)
  const node: FlowNode = { id: 'h', type: 'http', data: { method: 'GET', url: 'https://x', onError: 'route' } }
  const { container } = renderNode(node)
  assert.ok(container.querySelector('button[aria-label="Add step"]'))
  assert.ok(container.querySelector('button[aria-label="Add step on On error"]'))
})

test('a read-only canvas offers no add-step stubs', (t) => {
  t.after(cleanup)
  const node: FlowNode = { id: 'a', type: 'agent', data: { agentId: 'x', input: '' } }
  const { container } = render(
    React.createElement(
      ReactFlowProvider,
      null,
      React.createElement(
        CanvasActionsContext.Provider,
        { value: { onAddFrom: () => {}, onInsertOnEdge: () => {}, onDeleteEdge: () => {}, readOnly: true } },
        React.createElement(StepNode, {
          id: node.id,
          type: 'step',
          data: { node, title: 'X', handles: sourceHandlesFor(node), hasTarget: true, connected: [] },
          selected: false,
          dragging: false,
          zIndex: 0,
          isConnectable: false,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
          deletable: false,
          selectable: false,
          draggable: false,
        } as never),
      ),
    ),
  )
  assert.equal(container.querySelectorAll('button[aria-label^="Add step"]').length, 0)
})

test('validation problems surface as a badge on the chip', (t) => {
  t.after(cleanup)
  const node: FlowNode = { id: 'a', type: 'agent', data: { agentId: '', input: '' } }
  const { container } = renderNode(node, { issues: { errors: 2, warnings: 1 } })
  const badge = container.querySelector('[title*="2 errors"]')
  assert.ok(badge, 'error count is shown')
  assert.match(badge?.textContent ?? '', /2/)
})

test('a container chip reports how many steps its body holds', (t) => {
  t.after(cleanup)
  const node: FlowNode = { id: 'l', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 3, body: ['b1', 'b2'] } }
  const { container } = renderNode(node, { bodyCount: 2 })
  assert.match(container.textContent ?? '', /2 steps/)
})
