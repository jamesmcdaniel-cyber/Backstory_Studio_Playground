import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeFlowPackage, nativeFlowPackageSchema } from '@/lib/flows/native-package'

test('native flow packages round-trip and redact HTTP credentials', () => {
  const packaged = nativeFlowPackage({
    name: 'Portable', description: 'test', folder: '', visibility: 'shared',
    graph: { nodes: [{ id: 'http', type: 'http', data: { url: 'https://example.test', method: 'GET', headers: JSON.stringify({ Authorization: 'Bearer secret', Accept: 'application/json' }) }, position: { x: 0, y: 0 } }], edges: [] },
  })
  assert.equal(nativeFlowPackageSchema.parse(packaged).format, 'backstory.flow.v1')
  const headers = JSON.parse((packaged.flow.graph.nodes[0].data as { headers: string }).headers)
  assert.equal(headers.Authorization, 'redacted')
  assert.equal(headers.Accept, 'application/json')
})

test('native packages reject unknown formats', () => {
  assert.equal(nativeFlowPackageSchema.safeParse({ format: 'other', flow: {} }).success, false)
})
