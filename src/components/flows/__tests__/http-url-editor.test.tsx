/**
 * Characterization tests for the HTTP step's URL field, driven through the
 * REAL controlled loop the flow builder uses (value down, onChange ->
 * updateNode -> re-render). These pin that the URL editor accepts and retains
 * typed/blurred input in both the inline card and the drawer — the "won't
 * accept URLs" report could not be reproduced here, so this locks the input
 * path as correct and gives the reducer refactor (WS-R6 Phase 2) a safety net.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useState } from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { StepCard } from '../step-card'
import { StepDrawer } from '../step-drawer'
import { updateNode } from '@/lib/flows/mutate'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

const httpNode = (): FlowNode => ({ id: 'h1', type: 'http', data: { method: 'POST', url: '', bodyMode: 'json', body: '' } }) as FlowNode
const dataFields = [{ label: 'Run input', token: '{{trigger.input}}', type: 'string' }]

function typeInto(editor: HTMLInputElement, url: string) {
  fireEvent.focus(editor)
  fireEvent.change(editor, { target: { value: url } })
}

function CardHarness({ capture }: { capture: (n: FlowNode) => void }) {
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [httpNode()], edges: [] } as FlowGraph)
  const node = graph.nodes.find((n) => n.id === 'h1') as FlowNode
  capture(node)
  return React.createElement(StepCard, {
    node, title: 'HTTP', selected: true, agents: [], toolCatalog: [], dataFields, labelCtx: {} as never,
    onChange: (n: FlowNode) => setGraph((g) => updateNode(g, n)), onClick: () => {},
  })
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

test('inline card URL field accepts and retains a typed URL', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  const editor = container.querySelector('[aria-label="URI"]') as HTMLInputElement
  assert.ok(editor, 'URI field renders')
  assert.equal(editor.type, 'url')
  const url = 'https://api.example.com/webhook?a=b&c=d'
  typeInto(editor, url)
  assert.equal((container.querySelector('[aria-label="URI"]') as HTMLInputElement).value, url)
  assert.equal((latest as unknown as { data: { url: string } }).data.url, url)
  assert.equal(document.body.textContent?.includes('Insert data'), false, 'URI focus does not open the generic data picker')
  cleanup()
})

test('inline card URL survives a blur', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  const editor = container.querySelector('[aria-label="URI"]') as HTMLInputElement
  const url = 'https://example.com/x'
  typeInto(editor, url)
  fireEvent.blur(editor)
  assert.equal((container.querySelector('[aria-label="URI"]') as HTMLInputElement).value, url)
  assert.equal((latest as unknown as { data: { url: string } }).data.url, url)
  cleanup()
})

test('drawer URL field accepts and retains a typed URL', () => {
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
