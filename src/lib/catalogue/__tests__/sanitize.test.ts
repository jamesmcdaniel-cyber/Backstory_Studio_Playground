import test from 'node:test'
import assert from 'node:assert/strict'
import { findSecretCandidates, stripOrgReferences } from '../sanitize'

test('workspace-only ids are dropped at every depth', () => {
  const snapshot = {
    graph: {
      nodes: [
        { id: 'a', type: 'http', data: { url: 'https://api.example.com/v1', credentialId: 'cred_123', method: 'GET' } },
        { id: 'b', type: 'tool', data: { toolName: 'send_message', connectionId: 'conn_456' } },
        { id: 'c', type: 'agent', data: { agentId: 'agent_789', toolConnectionIds: ['conn_1', 'conn_2'] } },
        { id: 'd', type: 'subflow', data: { flowId: 'flow_abc', label: 'Child' } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    },
    configuration: { organizationId: 'org_1', model: 'claude-opus-5' },
  }

  const cleaned = stripOrgReferences(snapshot)
  const serialized = JSON.stringify(cleaned)

  for (const leaked of ['credentialId', 'connectionId', 'toolConnectionIds', 'agentId', 'flowId', 'organizationId']) {
    assert.doesNotMatch(serialized, new RegExp(leaked), `${leaked} must not survive`)
  }
  // The functional content is exactly what makes a template worth installing.
  assert.equal(cleaned.graph.nodes[0].data.url, 'https://api.example.com/v1')
  assert.equal(cleaned.graph.nodes[0].data.method, 'GET')
  assert.equal(cleaned.graph.nodes[1].data.toolName, 'send_message')
  assert.equal(cleaned.graph.nodes[3].data.label, 'Child')
  assert.equal(cleaned.configuration.model, 'claude-opus-5')
  assert.equal(cleaned.graph.edges.length, 1)
})

test('stripping leaves primitives and array positions alone', () => {
  const input = { list: [1, 'two', null, true], nested: [[{ credentialId: 'x', keep: 'yes' }]] }
  const cleaned = stripOrgReferences(input)
  assert.deepEqual(cleaned.list, [1, 'two', null, true])
  assert.deepEqual(cleaned.nested, [[{ keep: 'yes' }]])
})

test('recognisable credential shapes are reported with the value masked', () => {
  const findings = findSecretCandidates({
    nodes: [
      { data: { headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' } } },
      { data: { body: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123' } },
      { data: { args: { key: 'sk-ant-abcdefghijklmnopqrstuv' } } },
    ],
  })

  assert.equal(findings.length, 3)
  assert.equal(findings[0].path, 'nodes[0].data.headers.Authorization')
  assert.match(findings[0].reason, /Bearer token/)
  // The masked preview must locate the value without reproducing it.
  assert.doesNotMatch(findings[0].preview, /abcdefghijklmnop/)
  assert.match(findings[0].preview, /chars/)
  assert.match(findings[1].reason, /GitHub token/)
  assert.match(findings[2].reason, /Anthropic/)
})

test('a long opaque value is reported only when its key claims to be a secret', () => {
  const secret = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
  const flagged = findSecretCandidates({ apiKey: secret })
  assert.equal(flagged.length, 1)
  assert.match(flagged[0].reason, /long literal value/)

  // The same string under an innocent key is content, not a credential.
  assert.deepEqual(findSecretCandidates({ description: secret }), [])
})

test('token references are never reported as leaked credentials', () => {
  const findings = findSecretCandidates({
    headers: { Authorization: 'Bearer {{credentials.apiKey}}' },
    apiKey: '{{secrets.SERVICE_TOKEN}}',
  })
  assert.deepEqual(findings, [])
})

test('a literal credential beside a token reference is still reported', () => {
  // The bypass this pins: the scanner used to skip any string containing `{{`,
  // so co-locating a live key with a reference hid it completely — and that is
  // what a real authenticated step looks like.
  const findings = findSecretCandidates({
    headers: { Authorization: 'Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAA {{step.suffix}}' },
  })
  assert.equal(findings.length, 1)
  // Classified as a Bearer token rather than an Anthropic key: SECRET_VALUE_PATTERNS
  // is first-match-wins and Bearer is ordered ahead. Either reason is a report.
  assert.match(findings[0].reason, /Bearer token/)
  // The preview still locates the value in the ORIGINAL string.
  assert.match(findings[0].preview, /^Bea/)

  // A bare provider key with no Bearer prefix keeps its specific classification.
  const anthropic = findSecretCandidates({ header: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA {{step.suffix}}' })
  assert.equal(anthropic.length, 1)
  assert.match(anthropic[0].reason, /Anthropic API key/)

  // Same for the opaque-value-under-a-secret-key rule.
  const opaque = findSecretCandidates({ apiKey: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6{{env.REGION}}' })
  assert.equal(opaque.length, 1)
  assert.match(opaque[0].reason, /long literal value/)
})

test('a clean snapshot produces no findings', () => {
  const findings = findSecretCandidates({
    graph: { nodes: [{ data: { url: 'https://api.example.com/orders', method: 'POST', label: 'Create order' } }] },
  })
  assert.deepEqual(findings, [])
})

test('findings are capped so one snapshot cannot flood the review screen', () => {
  const nodes = Array.from({ length: 80 }, () => ({ auth: 'Bearer abcdefghijklmnopqrstuvwxyz012345' }))
  assert.equal(findSecretCandidates({ nodes }, 50).length, 50)
})
