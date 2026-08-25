import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The audit gap this guards was not "four paths nobody wired up" — it was that
 * NOTHING made wiring them a requirement, so every new credential path started
 * unaudited and stayed that way. Enumerating the paths that existed on
 * 2026-08-15 would have left the fifth one to reopen it, exactly as
 * org-transfer.ts did for revocation.
 *
 * So the invariant is structural: a file that decrypts a stored secret is a
 * file that reads a credential, and it must also record that read. New code
 * that decrypts without auditing fails here rather than in a review.
 */

const SRC = path.join(process.cwd(), 'src')

/**
 * Files that decrypt but legitimately record nothing.
 *
 * Every entry needs a reason. "It was already like that" is not one — an
 * allowlist that grows without justification is how the original gap survived
 * three audits.
 */
const READ_EXEMPT: Record<string, string> = {
  'lib/crypto/secrets.ts': 'The decryption primitive itself. Auditing here would recurse.',
  'lib/audit/stream-delivery.ts':
    'Decrypts the signing secret for ONE outbound audit delivery. Recording that read ' +
    'would recurse: recordCredentialUse writes an audit event, which enqueues a delivery, ' +
    'which reads the secret again — an audit-event storm where every forwarded event ' +
    'forwards another. Same reason as lib/crypto/secrets.ts. The grant IS audited, where ' +
    'the destination is configured.',
  'lib/mcp/mcp-client.ts':
    'mcpConfigFromConnection is synchronous and takes a three-field row with no id or ' +
    'organizationId, so it cannot name the credential it read. Audited one level up, at ' +
    'the tool-plane load in features/agents/tool-planes.ts, which knows all three.',
  'lib/mcp/connection-token.ts':
    'Decrypts only to refresh, and records the result as credential.rotated rather than a read.',
  'app/api/mcp-connections/oauth/callback/route.ts':
    'Decrypts the short-lived OAuth state cookie it wrote itself, not a stored credential. ' +
    'The resulting grant IS audited.',
  'app/api/peopleai/callback/route.ts': 'Decrypts its own OAuth state cookie; the grant is audited in connect-service.ts.',
  'lib/peopleai/webhook-secret.ts':
    'Reads the org webhook SIGNING secret to verify an inbound signature. Verifying a ' +
    'signature is not acting with a credential, and auditing every inbound webhook would ' +
    'bury the events that matter.',
  'app/api/signals/people-ai/route.ts': 'Same inbound-signature verification path as webhook-secret.ts.',
  'lib/integrations/slack.ts':
    'Decrypts the workspace\'s own Slack SIGNING secret to verify an inbound Events API ' +
    'signature (src/app/api/slack/events/route.ts) — same rationale as peopleai/webhook-secret.ts: ' +
    'verifying a signature is not acting with a credential. The bot TOKEN this file also handles ' +
    'goes through getSlackToken -> resolveOrgCredential -> readOrgSecret in org-credential.ts, ' +
    'which is what records its reads.',
}

/**
 * Files that store encrypted material but authorize nothing. Kept separate from
 * READ_EXEMPT because the two guards ask different questions, and a single
 * shared list let an entry exempt a file from a rule it was never examined
 * against.
 */
const GRANT_EXEMPT: Record<string, string> = {
  'app/api/mcp-connections/oauth/start/route.ts':
    'Encrypts the short-lived OAuth state/PKCE cookie it is about to hand back to the ' +
    'browser. No credential exists yet — the grant it leads to is audited in the callback.',
  'app/api/peopleai/connect/route.ts':
    'Same: encrypts its own OAuth state cookie. The grant is audited in connect-service.ts.',
  'app/api/slack/install/route.ts':
    'Same as the MCP start route: encrypts the short-lived OAuth state cookie it is about ' +
    'to hand back to the browser. No credential exists yet — the bot token the install ' +
    'leads to is minted by Slack and audited in slack/oauth/callback/route.ts.',
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

test('every file that decrypts a stored secret also records that it read one', () => {
  const offenders: string[] = []

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    if (!/\bdecryptSecret\s*\(/.test(source)) continue

    const relative = path.relative(SRC, file)
    if (relative in READ_EXEMPT) continue

    if (!source.includes('@/lib/credentials/audit')) offenders.push(relative)
  }

  assert.deepEqual(
    offenders,
    [],
    `these files decrypt a stored credential without recording the read: ${offenders.join(', ')}. ` +
      'Call recordCredentialUse (and recordCredentialUseFailure on the decrypt-failure branch), ' +
      'or add the file to READ_EXEMPT with a reason.',
  )
})

test('each allowlist only names files that still exist and still match its rule', () => {
  // An allowlist entry that no longer applies is a silent hole: the file it
  // named may have been split, and the replacement inherits the exemption
  // without anyone deciding it should.
  const stale: string[] = []

  const checks: Array<[Record<string, string>, RegExp, string]> = [
    [READ_EXEMPT, /\bdecryptSecret\s*\(/, 'no longer decrypts'],
    [GRANT_EXEMPT, /\bencryptSecret\s*\(|\bbuildAuthConfig\s*\(/, 'no longer stores credential material'],
  ]

  for (const [list, pattern, why] of checks) {
    for (const relative of Object.keys(list)) {
      const full = path.join(SRC, relative)
      let source: string
      try {
        source = readFileSync(full, 'utf8')
      } catch {
        stale.push(`${relative} (file no longer exists)`)
        continue
      }
      if (!pattern.test(source)) stale.push(`${relative} (${why})`)
    }
  }

  assert.deepEqual(stale, [], `remove these stale audit-exemptions: ${stale.join(', ')}`)
})

test('every credential grant surface records a grant', () => {
  // The write half of the same invariant. A route that persists encrypted
  // material is authorizing access, and an unattributed authorization is the
  // thing a security review asks about first.
  const offenders: string[] = []

  for (const file of sourceFiles(path.join(SRC, 'app', 'api'))) {
    const source = readFileSync(file, 'utf8')
    if (!/\bencryptSecret\s*\(|\bbuildAuthConfig\s*\(/.test(source)) continue

    const relative = path.relative(SRC, file)
    if (relative in GRANT_EXEMPT) continue

    if (!source.includes('@/lib/credentials/audit')) offenders.push(relative)
  }

  assert.deepEqual(
    offenders,
    [],
    `these API routes store credential material without recording who authorized it: ${offenders.join(', ')}`,
  )
})
