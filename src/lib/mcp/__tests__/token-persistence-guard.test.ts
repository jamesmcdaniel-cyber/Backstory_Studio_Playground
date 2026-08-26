import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Building an McpClient from a STORED authorization-code connection without
 * somewhere to write rotated tokens is destructive, and destructive on a delay.
 *
 * Refresh-token rotation is the default for public clients at most identity
 * providers: spending a refresh token returns a new one and invalidates the old
 * one. A caller that refreshes and drops the result has consumed the credential
 * the database still holds — the run that does it succeeds, and the failure
 * lands on whatever touches the connection next. That is how a six-hourly
 * background health sweep became the thing that made connections unhealthy.
 *
 * Nothing in the types says so, which is why this is a test: any new caller
 * that decrypts a stored row has to say how a rotated token gets saved.
 */

const ROOT = join(process.cwd(), 'src')

/**
 * Files allowed to decrypt a stored row without attaching persistence, each
 * with the reason it is safe. Adding to this list is a decision, not a default.
 */
const EXEMPT: Record<string, string> = {
  'src/lib/mcp/mcp-client.ts':
    'Defines mcpConfigFromConnection. Building the config is not the same as using it.',
  'src/lib/mcp/connection-token.ts':
    'Defines attachTokenPersistence and the mcpClientForStoredConnection factory.',
  'src/lib/mcp/verify-connection.ts':
    'verifyStoredMcpConnection verifies a DRAFT whose credentials came in on the request — there is no stored row to write back to. Stored rows go through verifyLiveMcpConnection.',
  'src/features/flows/http-auth.ts':
    'Reads an already-refreshed bearer for an HTTP step. Calls ensureFreshConnectionToken and constructs no client, so no refresh can happen here.',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

test('every caller that decrypts a stored connection persists rotated tokens', () => {
  const offenders: string[] = []

  for (const file of walk(ROOT)) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('mcpConfigFromConnection(')) continue

    const relative = file.slice(process.cwd().length + 1)
    if (EXEMPT[relative]) continue

    const persists =
      source.includes('attachTokenPersistence') || source.includes('mcpClientForStoredConnection')
    if (!persists) offenders.push(relative)
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')} builds a client config from a stored MCP connection without ` +
      'attachTokenPersistence or mcpClientForStoredConnection. A refresh triggered there would ' +
      'consume the stored refresh token and discard its replacement, killing the connection.',
  )
})

test('the background health sweep verifies through the persisting path', () => {
  // The sweep runs unattended across every workspace's connections. It is the
  // single most damaging place to refresh without saving, because nobody is
  // watching when it happens.
  const sweep = readFileSync(join(ROOT, 'lib/mcp/health-sweep.ts'), 'utf8')
  assert.match(sweep, /verifyLiveMcpConnection/)
  assert.doesNotMatch(sweep, /verifyStoredMcpConnection/)
})

test('the exemption list stays honest', () => {
  // An exemption for a file that no longer decrypts anything is a comment
  // claiming a risk was considered, for code that no longer carries it.
  for (const relative of Object.keys(EXEMPT)) {
    const source = readFileSync(join(process.cwd(), relative), 'utf8')
    assert.ok(
      source.includes('mcpConfigFromConnection'),
      `${relative} is exempted but no longer calls mcpConfigFromConnection — drop the exemption.`,
    )
  }
})
