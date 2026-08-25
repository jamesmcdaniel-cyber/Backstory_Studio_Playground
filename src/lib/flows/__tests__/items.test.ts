import assert from 'node:assert/strict'
import { test } from 'node:test'
import { flowItemsFromValue, mergeInputItems, valueFromFlowItems } from '../items'

test('normalizes object arrays and records deterministic paired-item lineage', () => {
  const parents = flowItemsFromValue([{ id: 1 }, { id: 2 }])
  const children = flowItemsFromValue([{ ok: true }, { ok: false }], parents, 0, 'fetch')
  assert.deepEqual(children.map((item) => item.pairedItem), [
    { item: 0, sourceNode: 'fetch' },
    { item: 1, sourceNode: 'fetch' },
  ])
})

test('preserves binary metadata on already-normalized items', () => {
  const [item] = flowItemsFromValue({
    json: { name: 'report' },
    binary: { file: { id: 'file-1', mimeType: 'application/pdf', fileName: 'report.pdf' } },
  })
  assert.equal(item.binary?.file.id, 'file-1')
  assert.deepEqual(valueFromFlowItems([item]), { name: 'report' })
})

test('merges indexed input sockets without losing which input produced an item', () => {
  const merged = mergeInputItems([
    flowItemsFromValue([{ side: 'left' }]),
    flowItemsFromValue([{ side: 'right' }]),
  ])
  assert.deepEqual(merged.map((item) => item.pairedItem), [{ item: 0 }, { item: 0, input: 1 }])
})
