import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isSecretFieldName, redactFlowString, redactFlowValue } from '../secret-redaction'
import { REDACTED } from '@/lib/logging/redact'

/**
 * Token-shaped fixtures are ASSEMBLED rather than written out.
 *
 * A realistic literal in a test file is still a realistic literal in the
 * repository: GitHub push protection blocked this very file for a Slack-shaped
 * fixture, which is the control working exactly as intended. Building them at
 * runtime keeps the redactor under test seeing the real shape without leaving
 * one committed.
 */
const FAKE = {
  anthropic: ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-'),
  slack: ['xoxb', '111111111111', 'A'.repeat(20)].join('-'),
  google: `ya29.${'A'.repeat(28)}`,
  googleRefresh: `1//09${'A'.repeat(20)}`,
}

/**
 * Two properties in tension, and both have to hold:
 *
 *   1. No literal credential survives — in ANY node type, ANY field, and in
 *      HTTP response bodies whose keys we do not control.
 *   2. Template references survive untouched, and the surrounding structure
 *      stays intact, or the export cannot be imported and run and people stop
 *      using it (or hand-edit secrets back in, which is worse).
 */

// ── References survive ─────────────────────────────────────────────────────

test('a pure template reference is never touched', () => {
  // This is the CORRECT way to write an authenticated step. Redacting it would
  // punish exactly the authors doing the right thing.
  assert.equal(redactFlowString('{{credentials.apiKey}}'), '{{credentials.apiKey}}')
  assert.equal(redactFlowString('Bearer {{credentials.token}}'), 'Bearer {{credentials.token}}')
})

test('a URL built from references keeps every reference', () => {
  const url = 'https://api.example.com/{{step.id}}/items?key={{env.API_KEY}}'
  assert.equal(redactFlowString(url), url)
})

test('a secret-named field holding only a reference is preserved', () => {
  const out = redactFlowValue({ apiKey: '{{credentials.stripe}}' })
  assert.deepEqual(out, { apiKey: '{{credentials.stripe}}' })
})

// ── Literals do not survive ────────────────────────────────────────────────

test('a literal beside a reference is still caught', () => {
  // The bypass that mattered: skipping any string containing `{{` hid a live
  // credential sitting next to a legitimate reference.
  const out = redactFlowString(`Bearer ${FAKE.anthropic} {{step.id}}`)

  assert.ok(!out.includes(FAKE.anthropic), 'the literal key is gone')
  assert.ok(out.includes('{{step.id}}'), 'the reference survives')
})

test('a credential in a URL query string is removed, host and path kept', () => {
  // Blanket-deleting the url would make the exported flow undescriptive and
  // unimportable. The endpoint is the useful part; the key is not.
  const out = redactFlowString('https://api.example.com/v1/charges?api_key=SUPERSECRETVALUE12345&limit=10')

  assert.ok(out.startsWith('https://api.example.com/v1/charges'), 'endpoint survives')
  assert.ok(!out.includes('SUPERSECRETVALUE12345'))
  assert.ok(out.includes('limit=10'), 'non-secret params survive')
})

test('a secret-named field holding a literal is redacted whatever its shape', () => {
  // Short and unpatterned — no value-shape rule would catch this, which is why
  // the field-name rule exists alongside it.
  assert.deepEqual(redactFlowValue({ password: 'hunter2' }), { password: REDACTED })
  assert.deepEqual(redactFlowValue({ client_secret: 'abc' }), { client_secret: REDACTED })
})

// ── Every node type, not just http ─────────────────────────────────────────

test('a code node with an inlined key is redacted', () => {
  // `code` was entirely untouched before: 100KB of user-authored source that
  // exported verbatim.
  const node = {
    type: 'code',
    data: { language: 'javascript', code: `const key = "${FAKE.anthropic}"` },
  }
  const out = redactFlowValue(node) as typeof node

  assert.ok(!out.data.code.includes(FAKE.anthropic))
  assert.ok(out.data.code.includes('const key ='), 'the code structure survives')
})

test('an ai node prompt carrying a key is redacted', () => {
  const out = redactFlowValue({
    type: 'ai',
    data: { prompt: `Call the API with ${FAKE.slack} and summarise` },
  }) as { data: { prompt: string } }

  assert.ok(!out.data.prompt.includes(FAKE.slack))
  assert.ok(out.data.prompt.includes('summarise'), 'the instruction survives')
})

// ── Run data: keys we do not control ───────────────────────────────────────

test('a token-endpoint response body is redacted', () => {
  // The single most valuable thing that lands in run history, and it was stored
  // in full: step outputs had no redaction whatsoever.
  const out = redactFlowValue({
    status: 200,
    body: {
      access_token: FAKE.google,
      refresh_token: FAKE.googleRefresh,
      expires_in: 3600,
      token_type: 'Bearer',
    },
  }) as { status: number; body: Record<string, unknown> }

  assert.equal(out.body.access_token, REDACTED)
  assert.equal(out.body.refresh_token, REDACTED)
  // Non-secret metadata stays readable — the run view still has to be useful.
  assert.equal(out.body.expires_in, 3600)
  assert.equal(out.body.token_type, 'Bearer')
  assert.equal(out.status, 200)
})

test('nested arrays and objects are walked', () => {
  const out = redactFlowValue({
    nodes: [
      { data: { headers: `Authorization: Bearer ${FAKE.anthropic}` } },
      { data: { label: 'harmless' } },
    ],
  }) as unknown as { nodes: Array<{ data: Record<string, string> }> }

  assert.ok(!out.nodes[0].data.headers.includes(FAKE.anthropic))
  assert.equal(out.nodes[1].data.label, 'harmless')
})

// ── Not over-redacting ─────────────────────────────────────────────────────

test('ordinary flow content is left alone', () => {
  // Over-redacting a user's own flow reads as data loss and gets reported as a
  // bug, so the field-name list is deliberately narrower than the logger's.
  const graph = {
    name: 'Sync accounts',
    nodes: [{ id: 'n1', type: 'http', data: { url: 'https://api.example.com/accounts', method: 'GET' } }],
  }
  assert.deepEqual(redactFlowValue(graph), graph)
})

test('token-shaped field names that hold no secret are not redacted', () => {
  assert.equal(isSecretFieldName('tokenUrl'), false)
  assert.equal(isSecretFieldName('tokenEndpoint'), false)
  assert.equal(isSecretFieldName('credentialId'), false, 'a reference to a credential, not the credential')
  assert.equal(isSecretFieldName('maxTokens'), false)

  assert.equal(isSecretFieldName('apiKey'), true)
  assert.equal(isSecretFieldName('client_secret'), true)
  assert.equal(isSecretFieldName('Authorization'), true)
})

test('numbers and booleans pass through untouched', () => {
  const out = redactFlowValue({ timeoutMs: 30000, enabled: true, retries: 3 })
  assert.deepEqual(out, { timeoutMs: 30000, enabled: true, retries: 3 })
})

test('deep recursion terminates rather than blowing the stack', () => {
  let deep: Record<string, unknown> = { value: 'leaf' }
  for (let i = 0; i < 40; i += 1) deep = { nested: deep }
  assert.doesNotThrow(() => redactFlowValue(deep))
})
