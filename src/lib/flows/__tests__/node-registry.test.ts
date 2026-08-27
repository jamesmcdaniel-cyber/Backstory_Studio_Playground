import test from 'node:test'
import assert from 'node:assert/strict'
import { CURRENT_NODE_VERSIONS } from '@/lib/flows/node-versions'
import { nativeNodeRegistry } from '@/lib/flows/node-registry'

test('native node registry covers every versioned runtime node exactly once', () => {
  const definitions = nativeNodeRegistry()
  assert.deepEqual(definitions.map((definition) => definition.type).sort(), Object.keys(CURRENT_NODE_VERSIONS).sort())
  assert.equal(new Set(definitions.map((definition) => definition.type)).size, definitions.length)
  for (const definition of definitions) {
    assert.equal(definition.typeVersion, CURRENT_NODE_VERSIONS[definition.type])
    assert.ok(definition.title)
    assert.ok(definition.description)
    assert.ok(definition.configurationFields.length > 0)
  }
})

test('native node registry searches operation variants and configuration fields', () => {
  assert.deepEqual(nativeNodeRegistry('compare datasets').map((definition) => definition.type), ['data'])
  assert.deepEqual(nativeNodeRegistry('credentialResolverId').map((definition) => definition.type), ['http'])
  assert.deepEqual(nativeNodeRegistry('hosted form').map((definition) => definition.type), ['trigger'])
})
