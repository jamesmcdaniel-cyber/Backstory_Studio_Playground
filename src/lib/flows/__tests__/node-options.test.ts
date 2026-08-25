import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addableOptions,
  addedOptions,
  applicableOptions,
  isOptionAdded,
  nodeOptions,
  optionPatch,
  strandedOptions,
  PER_ITEM_TYPES,
} from '@/lib/flows/node-options'
import type { FlowNode } from '@/lib/flows/graph'

const http = (data: Record<string, unknown> = {}) =>
  ({ id: 'n1', type: 'http', data: { method: 'GET', url: 'https://x.test', ...data } }) as unknown as FlowNode

/**
 * Measured against n8n's HTTP node, ours declares 21 parameters to their 86 and
 * reads as the busier panel. The difference is the collection idiom: a
 * parameter does not exist on screen until you add it. These are its rules.
 */

test('a fresh step has added nothing — the panel opens on its parameters', () => {
  assert.deepEqual([...addedOptions(http())], [])
  assert.ok(addableOptions(http()).length > 5, 'and there is plenty available behind one control')
})

test('an option is added by holding a value, and removed by clearing it', () => {
  // The same convention the advanced-params panel has always used, so every
  // option that already existed keeps its stored meaning.
  assert.equal(isOptionAdded(http({ retries: 2 }), 'retries'), true)
  assert.equal(isOptionAdded(http({ retries: 0 }), 'retries'), true, '0 is a value, not an absence')
  assert.equal(isOptionAdded(http({ retries: undefined }), 'retries'), false)
  assert.equal(isOptionAdded(http(), 'retries'), false)
})

test('adding an option writes something meaningful, not an empty control', () => {
  const retries = nodeOptions('http').find((option) => option.key === 'retries')!
  assert.deepEqual(optionPatch(retries, 'add'), { retries: 2 })
  assert.deepEqual(optionPatch(retries, 'remove'), { retries: undefined })
})

test('an added option leaves the add list', () => {
  const node = http({ retries: 2 })
  assert.ok(addedOptions(node).some((option) => option.key === 'retries'))
  assert.ok(!addableOptions(node).some((option) => option.key === 'retries'))
})

test('an option that cannot do anything is not offered at all', () => {
  // Body format on a request that sends no body. n8n gates this the same way,
  // and greying it out would still be a control on screen.
  assert.ok(!addableOptions(http()).some((option) => option.key === 'bodyMode'))
  assert.ok(addableOptions(http({ sendBody: true })).some((option) => option.key === 'bodyMode'))
})

test('a value stranded by a later edit is surfaced, not left acting invisibly', () => {
  // Set the body format, then turn the body off. n8n hides the control and
  // keeps the value, so a setting is in force that the panel does not show.
  const stranded = http({ sendBody: false, bodyMode: 'form-data' })
  assert.deepEqual(strandedOptions(stranded).map((option) => option.key), ['bodyMode'])
  // And it is not double-counted as added, or it would render twice.
  assert.ok(!addedOptions(stranded).some((option) => option.key === 'bodyMode'))
})

test('options keep manifest order so the panel never reshuffles', () => {
  const node = http({ alwaysOutputData: true, responseType: 'json', retries: 1 })
  const order = addedOptions(node).map((option) => option.key)
  const manifest = nodeOptions('http').map((option) => option.key)
  assert.deepEqual(order, manifest.filter((key) => order.includes(key)))
})

test('every option a node declares is reachable and describable', () => {
  // A manifest entry with no label, or a duplicate key, is a control the panel
  // cannot render or can render twice.
  for (const type of ['http', 'agent', 'ai', 'tool', 'subflow', 'code', 'loop', 'data'] as const) {
    const options = nodeOptions(type)
    const keys = options.map((option) => option.key)
    assert.equal(new Set(keys).size, keys.length, `${type} declares a duplicate option`)
    for (const option of options) {
      assert.ok(option.label.trim().length > 0, `${type}.${option.key} has no label`)
      assert.notEqual(option.addValue, undefined, `${type}.${option.key} adds nothing`)
    }
  }
})

test('the code step is not offered settings its interpreter ignores', () => {
  // Offering a dead toggle is worse than offering nothing.
  const keys = nodeOptions('code').map((option) => option.key)
  assert.ok(!keys.includes('alwaysOutputData'))
  assert.ok(!keys.includes('retries'))
  assert.ok(keys.includes('timeoutMs'))
})

test('applicability is evaluated per node, not per type', () => {
  const withBody = applicableOptions(http({ sendBody: true })).map((option) => option.key)
  const without = applicableOptions(http()).map((option) => option.key)
  assert.ok(withBody.includes('bodyMode'))
  assert.ok(!without.includes('bodyMode'))
})

test('every per-item type is offered the per-item option, and no other type is', () => {
  // These were two lists of the same nine types in two files. They would have
  // drifted the first time a tenth was added.
  for (const type of PER_ITEM_TYPES) {
    assert.ok(
      nodeOptions(type).some((option) => option.key === 'perItem'),
      `${type} supports per-item but is not offered it`,
    )
  }
  for (const type of ['loop', 'condition', 'switch'] as const) {
    assert.ok(!nodeOptions(type).some((option) => option.key === 'perItem'), `${type} should not offer per-item`)
  }
})
