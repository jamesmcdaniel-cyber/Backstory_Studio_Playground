import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeFlowPackage, nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { REDACTED } from '@/lib/logging/redact'

test('native flow packages round-trip and redact HTTP credentials', () => {
  const packaged = nativeFlowPackage({
    name: 'Portable', description: 'test', folder: '', visibility: 'shared',
    graph: { nodes: [{ id: 'http', type: 'http', data: { url: 'https://example.test', method: 'GET', headers: JSON.stringify({ Authorization: 'Bearer secret', Accept: 'application/json' }) }, position: { x: 0, y: 0 } }], edges: [] },
  })
  assert.equal(nativeFlowPackageSchema.parse(packaged).format, 'backstory.flow.v1')
  const headers = JSON.parse((packaged.flow.graph.nodes[0].data as { headers: string }).headers)
  assert.equal(headers.Authorization, REDACTED)
  assert.equal(headers.Accept, 'application/json')
})

test('export redacts node types other than http — the old redactor covered only http', () => {
  // `code` exported up to 100KB of user-authored source verbatim, and an `ai`
  // node's prompt was never touched at all.
  const packaged = nativeFlowPackage({
    name: 'Portable', description: '', folder: '', visibility: 'shared',
    graph: {
      nodes: [
        { id: 'c', type: 'code', data: { language: 'javascript', code: `const k = "${['sk', 'ant', 'api03', 'A'.repeat(24)].join('-')}"` }, position: { x: 0, y: 0 } },
      ],
      edges: [],
    },
  })

  const code = (packaged.flow.graph.nodes[0].data as { code: string }).code
  assert.ok(!code.includes('api03-AAA'), 'the literal key is gone')
  assert.ok(code.includes('const k ='), 'the code still reads as code')
})

test('export strips a credential from an http URL but keeps the endpoint', () => {
  // The url field was never redacted, so `?api_key=LIVE` exported verbatim.
  const packaged = nativeFlowPackage({
    name: 'Portable', description: '', folder: '', visibility: 'shared',
    graph: {
      nodes: [
        { id: 'h', type: 'http', data: { url: 'https://api.example.test/v1/x?api_key=LIVEKEYVALUE12345&page=2', method: 'GET' }, position: { x: 0, y: 0 } },
      ],
      edges: [],
    },
  })

  const url = (packaged.flow.graph.nodes[0].data as { url: string }).url
  assert.ok(!url.includes('LIVEKEYVALUE12345'))
  assert.ok(url.startsWith('https://api.example.test/v1/x'), 'the endpoint survives so the flow is still importable')
  assert.ok(url.includes('page=2'))
})

test('export preserves template references — the correct way to authenticate', () => {
  const packaged = nativeFlowPackage({
    name: 'Portable', description: '', folder: '', visibility: 'shared',
    graph: {
      nodes: [
        { id: 'h', type: 'http', data: { url: 'https://api.example.test/v1', method: 'GET', headers: JSON.stringify({ Authorization: 'Bearer {{credentials.token}}' }) }, position: { x: 0, y: 0 } },
      ],
      edges: [],
    },
  })

  const headers = JSON.parse((packaged.flow.graph.nodes[0].data as { headers: string }).headers)
  assert.equal(headers.Authorization, 'Bearer {{credentials.token}}')
})

test('native packages reject unknown formats', () => {
  assert.equal(nativeFlowPackageSchema.safeParse({ format: 'other', flow: {} }).success, false)
})
