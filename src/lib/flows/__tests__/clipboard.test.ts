import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowNode } from '@/lib/flows/graph'
import {
  writeFlowClipboard,
  readFlowClipboard,
  writeFlowSelection,
  readFlowSelection,
  FLOW_CLIPBOARD_KEY,
  FLOW_SELECTION_CLIPBOARD_KEY,
} from '../clipboard'

function stubStorage() {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  return store
}

const agent = (id: string): FlowNode => ({ id, type: 'agent', data: { agentId: 'a1', input: '' }, position: { x: 1, y: 2 } })

test('write/read round-trips a step and sanitizes on read', () => {
  const store = stubStorage()
  writeFlowClipboard({ id: 'a', type: 'stop', data: { reason: 'x' } } as never)
  assert.ok(store.get(FLOW_CLIPBOARD_KEY))
  const read = readFlowClipboard()
  assert.equal(read?.type, 'stop')
})

test('read rejects garbage and triggers', () => {
  const store = stubStorage()
  store.set(FLOW_CLIPBOARD_KEY, 'not json')
  assert.equal(readFlowClipboard(), null)
  store.set(FLOW_CLIPBOARD_KEY, JSON.stringify({ id: 't', type: 'trigger', data: {} }))
  assert.equal(readFlowClipboard(), null)
})

test('a copied selection round-trips with its internal edges and positions', () => {
  stubStorage()
  writeFlowSelection({ nodes: [agent('a'), agent('b')], edges: [{ id: 'a->b', source: 'a', target: 'b' }] })
  const read = readFlowSelection()
  assert.deepEqual(read?.nodes.map((node) => node.id), ['a', 'b'])
  assert.deepEqual(read?.edges.map((edge) => edge.id), ['a->b'])
  // Positions survive so a paste can keep the copied arrangement.
  assert.deepEqual(read?.nodes[0].position, { x: 1, y: 2 })
})

test('an edge whose endpoint did not survive sanitization is dropped', () => {
  const store = stubStorage()
  store.set(
    FLOW_SELECTION_CLIPBOARD_KEY,
    JSON.stringify({ nodes: [agent('a')], edges: [{ id: 'a->ghost', source: 'a', target: 'ghost' }] }),
  )
  assert.deepEqual(readFlowSelection()?.edges, [])
})

test('a clipboard written before the canvas (v1, single step) still pastes', () => {
  const store = stubStorage()
  store.set(FLOW_CLIPBOARD_KEY, JSON.stringify(agent('legacy')))
  const read = readFlowSelection()
  assert.deepEqual(read?.nodes.map((node) => node.id), ['legacy'])
  assert.deepEqual(read?.edges, [])
})

test('a single-step copy keeps the v1 key in step; a multi-step copy clears it', () => {
  const store = stubStorage()
  writeFlowClipboard(agent('solo'))
  assert.ok(store.get(FLOW_CLIPBOARD_KEY), 'v1 written for a single step')
  assert.equal(readFlowClipboard()?.id, 'solo')

  writeFlowSelection({ nodes: [agent('a'), agent('b')], edges: [] })
  assert.equal(store.get(FLOW_CLIPBOARD_KEY), undefined, 'stale single step cleared')
})

test('an empty or malformed selection clipboard reads as nothing rather than throwing', () => {
  const store = stubStorage()
  assert.equal(readFlowSelection(), null)
  store.set(FLOW_SELECTION_CLIPBOARD_KEY, 'not json')
  assert.equal(readFlowSelection(), null)
  store.set(FLOW_SELECTION_CLIPBOARD_KEY, JSON.stringify({ nodes: [{ nope: true }], edges: 'bad' }))
  assert.equal(readFlowSelection(), null)
})

test('a copied trigger is refused — the trigger is never pasteable', () => {
  stubStorage()
  writeFlowSelection({
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }, agent('a')],
    edges: [],
  })
  assert.deepEqual(readFlowSelection()?.nodes.map((node) => node.id), ['a'])
})
