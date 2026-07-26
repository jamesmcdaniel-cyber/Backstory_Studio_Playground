/**
 * Characterization tests for the HTTP step's URL field, driven through the
 * REAL controlled loop the flow builder uses (value down, onChange ->
 * updateNode -> re-render). These pin that the URL editor accepts and retains
 * typed input in the full node workspace. HTTP configuration intentionally no
 * longer renders on the compact canvas card.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useState } from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { StepDrawer } from '../step-drawer'
import { updateNode } from '@/lib/flows/mutate'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

const httpNode = (): FlowNode => ({ id: 'h1', type: 'http', data: { method: 'POST', url: '', bodyMode: 'json', body: '' } }) as FlowNode
const dataFields = [{ label: 'Run input', token: '{{trigger.input}}', type: 'string' }]

function typeInto(editor: HTMLInputElement, url: string) {
  fireEvent.focus(editor)
  fireEvent.change(editor, { target: { value: url } })
}

function DrawerHarness({ capture }: { capture: (n: FlowNode) => void }) {
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [httpNode()], edges: [] } as FlowGraph)
  const node = graph.nodes.find((n) => n.id === 'h1') as FlowNode
  capture(node)
  return React.createElement(StepDrawer, {
    node, flowId: 'f1', agents: [], toolCatalog: [], dataFields, labelCtx: {} as never,
    onChange: (n: FlowNode) => setGraph((g) => updateNode(g, n)), onChangeType: () => {}, onDelete: () => {}, onClose: () => {},
  })
}

test('full HTTP workspace URL field accepts and retains a typed URL', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(DrawerHarness, { capture: (n) => { latest = n } }))
  const editor = container.querySelector('[aria-label="Request URL"]') as HTMLInputElement
  assert.ok(editor, 'Request URL field renders')
  assert.equal(editor.type, 'url')
  const url = 'https://api.example.com/webhook'
  typeInto(editor, url)
  assert.equal((container.querySelector('[aria-label="Request URL"]') as HTMLInputElement).value, url)
  assert.equal((latest as unknown as { data: { url: string } }).data.url, url)
  cleanup()
})
