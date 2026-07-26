import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeMcpVerificationError } from '@/lib/mcp/verify-connection'

test('MCP verification errors remain actionable without exposing credentials', () => {
  const message = safeMcpVerificationError(
    new Error('401 Bearer secret-token api_key=abc123 client_secret=hunter2'),
  )
  assert.match(message, /401/)
  assert.doesNotMatch(message, /secret-token|abc123|hunter2/)
  assert.match(message, /Bearer \[redacted\]/)
  assert.match(message, /api_key=\[redacted\]/)
  assert.match(message, /client_secret=\[redacted\]/)
})
