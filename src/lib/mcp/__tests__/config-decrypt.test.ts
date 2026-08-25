import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptSecret } from '@/lib/crypto/secrets'
import {
  MCP_CREDENTIAL_UNREADABLE,
  McpCredentialError,
  mcpConfigFromConnection,
} from '@/lib/mcp/mcp-client'

/**
 * A stored credential that cannot be decrypted is an operational state, not a
 * programming error: a half-finished key rotation, a row written by a build
 * that used a different key, a value that was never a ciphertext envelope at
 * all. It reached callers as whatever `decryptSecret` happened to throw —
 * "Malformed v1 encrypted secret payload" — which 500'd the connection-test
 * route and surfaced verbatim on a failed flow step. Neither told anyone the
 * one thing that fixes it: reconnect the connection.
 */

const UNREADABLE = 'v1:not-a-real-envelope'

/** assert.throws returns nothing, and these assertions are about the error. */
function caught(run: () => unknown): McpCredentialError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof McpCredentialError, `expected McpCredentialError, got ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'expected a throw, got none' })
}

test('an unreadable api_key payload throws an actionable credential error', () => {
  const error = caught(() =>
    mcpConfigFromConnection({
      serverUrl: 'https://mcp.example.com/mcp',
      authType: 'api_key',
      authConfig: { apiKey: UNREADABLE },
    }),
  )

  assert.equal(error.message, MCP_CREDENTIAL_UNREADABLE)
  // The real reason is preserved for the log, not for the reader.
  assert.match(String((error.cause as Error).message), /Malformed v1/)
  assert.equal(error.field, 'apiKey')
})

test('an unreadable authcode access token throws the same actionable error', () => {
  const error = caught(() =>
    mcpConfigFromConnection({
      serverUrl: 'https://mcp.people.ai/mcp',
      authType: 'oauth2',
      authConfig: {
        flow: 'authcode',
        clientId: 'client-1',
        tokenEndpoint: 'https://mcp.people.ai/token',
        accessToken: UNREADABLE,
      },
    }),
  )

  assert.equal(error.message, MCP_CREDENTIAL_UNREADABLE)
  assert.equal(error.field, 'accessToken')
  // Never echoes the stored payload — an envelope in an error string is a
  // ciphertext handed to whoever reads the log.
  assert.ok(!error.message.includes(UNREADABLE))
})

test('an unreadable client secret on a client-credentials row is named too', () => {
  const error = caught(() =>
    mcpConfigFromConnection({
      serverUrl: 'https://mcp.example.com/mcp',
      authType: 'oauth2',
      authConfig: { clientId: 'client-1', clientSecret: UNREADABLE, tokenUrl: 'https://x.example.com/token' },
    }),
  )

  assert.equal(error.field, 'clientSecret')
})

test('a well-formed row still decrypts unchanged', () => {
  const config = mcpConfigFromConnection({
    serverUrl: 'https://mcp.example.com/mcp',
    authType: 'api_key',
    authConfig: { apiKey: encryptSecret('sk-live-1'), headerName: 'X-Api-Key' },
  })
  assert.equal(config.apiKey, 'sk-live-1')
  assert.equal(config.headerName, 'X-Api-Key')
})
