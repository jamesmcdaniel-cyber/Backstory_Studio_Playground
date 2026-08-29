import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pullResultText, redactPullArguments, safePullError } from '@/lib/knowledge/pull'

test('pull provenance redacts secret-shaped fields recursively', () => {
  assert.deepEqual(
    redactPullArguments({ query: 'renewals', nested: { accessToken: 'nope', page: 2 } }),
    { query: 'renewals', nested: { accessToken: '[REDACTED]', page: 2 } },
  )
})

test('pull results become editable text artifacts', () => {
  assert.deepEqual(pullResultText({ rows: [{ id: 1 }] }), {
    content: '{\n  "rows": [\n    {\n      "id": 1\n    }\n  ]\n}',
    mimeType: 'application/json',
    truncated: false,
  })
  assert.equal(pullResultText('plain text').mimeType, 'text/plain')
})

test('provider errors are bounded and scrub common credential shapes', () => {
  const safe = safePullError(new Error('401 Bearer abc.def-123 API_KEY=supersecret password: hunter2'))
  assert.equal(safe, '401 Bearer [REDACTED] API_KEY=[REDACTED] password: [REDACTED]')
  assert.equal(safePullError('x'.repeat(3_000)).length, 2_000)
})
