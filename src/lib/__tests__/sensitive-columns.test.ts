import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Secret-bearing columns must be a decided list, not an accident.
 *
 * API responses are trimmed by hand-written serializers (serializeConnection,
 * redactedCredential, redactConfig, src/lib/flows/serialize.ts) rather than by
 * Prisma `select:` clauses. Those serializers are explicit allowlists, so they
 * are correct the day they are written — and silently incomplete the day someone
 * adds a column they do not know about. Nothing connected the schema to them.
 *
 * This does what the tenant-guard schema test does for organizationId: derive
 * the list from schema.prisma, and fail when a new secret-shaped column appears
 * that nobody has classified. It cannot prove a serializer is correct; it makes
 * the decision mandatory instead of optional.
 *
 * Adding a column here is a review step, not a formality. Pick honestly:
 *
 *   'encrypted' — ciphertext at rest (src/lib/crypto/secrets.ts). Must also be
 *                 covered by scripts/rotate-encryption-key.ts, or a key rotation
 *                 will strand it.
 *   'hash'      — one-way digest; the plaintext is shown once and never stored.
 *   'capability'— an unguessable bearer value that IS the credential. Safe to
 *                 return only to a caller already authorized to hold it.
 *   'not-secret'— matches the name pattern but carries no secret (an idempotency
 *                 key, a provider config name, a Prisma relation field).
 */

const SCHEMA = readFileSync(fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url)), 'utf8')

type Classification = 'encrypted' | 'hash' | 'capability' | 'not-secret'

const CLASSIFIED: Record<string, Classification> = {
  // ── Encrypted at rest ────────────────────────────────────────────────────
  'HttpCredential.secretConfig': 'encrypted',
  'IntegrationSecret.authConfig': 'encrypted',
  'McpConnection.authConfig': 'encrypted',
  'Organization.peopleAiWebhookSecret': 'encrypted',
  'PeopleAiConnection.accessToken': 'encrypted',
  'PeopleAiConnection.refreshToken': 'encrypted',

  // ── One-way hashes; plaintext shown once at creation/rotation ────────────
  'ApiKey.keyHash': 'hash',
  // Hash of the client SECRET on paired keys, of the bearer token on legacy ones.
  'ApiAccessToken.tokenHash': 'hash',
  'FlowRun.resumeTokenHash': 'hash',
  'Invitation.tokenHash': 'hash',
  'OrganizationDomain.verificationTokenHash': 'hash',
  'ScimToken.tokenHash': 'hash',

  // ── Unguessable bearer values ────────────────────────────────────────────
  // Flow.shareToken is a plaintext bearer value by design — the anonymous share
  // link IS the credential. Treating the URL and DB access as credential-bearing
  // is the accepted trade-off; a hashed lookup digest remains a P2 follow-on.
  'Flow.shareToken': 'capability',
  // Published to the workspace admin who must place it in DNS to prove control.
  'OrganizationDomain.verificationToken': 'capability',

  // ── Name matches the pattern, carries no secret ──────────────────────────
  'AgentConnector.connectorKey': 'not-secret',
  'AgentExecution.idempotencyKey': 'not-secret',
  'FlowSideEffect.iterationKey': 'not-secret',
  'FlowSideEffect.scopeKey': 'not-secret',
  'NangoConnection.providerConfigKey': 'not-secret',
  'OutboxEvent.dedupeKey': 'not-secret',
  'Signal.dedupeKey': 'not-secret',
  // Prisma relation fields, not columns.
  'Organization.apiKeys': 'not-secret',
  'Organization.httpCredentials': 'not-secret',
  'Organization.integrationSecrets': 'not-secret',
  'Organization.scimTokens': 'not-secret',
  'User.apiKeys': 'not-secret',
  'User.httpCredentials': 'not-secret',
  // Findings ABOUT secrets, not secrets: findSecretCandidates stores a masked
  // preview (maskValue), never the literal it matched on.
  'Flow.secretFindings': 'not-secret',
  'Flow.secretScanAt': 'not-secret',
  'ApiKey.accessTokens': 'not-secret',
  'ApiAccessToken.apiKey': 'not-secret',
  'Organization.apiAccessTokens': 'not-secret',
  // A foreign key, not a credential — it identifies which key issued the token.
  'ApiAccessToken.apiKeyId': 'not-secret',
}

/** Columns whose names read as secret-bearing. */
const SECRET_SHAPED = /(secret|token|key|password|credential|authconfig)/i
/** Token COUNTS are metering, not credentials. */
const TOKEN_COUNT = /^(input|output|cacheWrite|cacheRead|total)?Tokens$/

function secretShapedColumns(): string[] {
  const found: string[] = []
  let model = ''
  for (const line of SCHEMA.split('\n')) {
    const modelMatch = /^model\s+(\w+)\s*\{/.exec(line)
    if (modelMatch) {
      model = modelMatch[1]
      continue
    }
    if (/^\}/.test(line)) {
      model = ''
      continue
    }
    if (!model) continue
    const fieldMatch = /^\s{2}(\w+)\s+\S/.exec(line)
    if (!fieldMatch) continue
    const field = fieldMatch[1]
    if (TOKEN_COUNT.test(field)) continue
    if (!SECRET_SHAPED.test(field)) continue
    found.push(`${model}.${field}`)
  }
  return found.sort()
}

test('every secret-shaped schema column has been classified', () => {
  const unclassified = secretShapedColumns().filter((column) => !(column in CLASSIFIED))
  assert.deepEqual(
    unclassified,
    [],
    `Unclassified secret-shaped column(s): ${unclassified.join(', ')}.\n` +
      'Add each to CLASSIFIED in this file after deciding how it is protected, ' +
      'and confirm no API serializer returns it.',
  )
})

test('the classification list has no stale entries', () => {
  const actual = new Set(secretShapedColumns())
  const stale = Object.keys(CLASSIFIED).filter((column) => !actual.has(column))
  assert.deepEqual(stale, [], `Classified column(s) no longer in schema.prisma: ${stale.join(', ')}`)
})

test('every encrypted column is covered by the key-rotation script', () => {
  const script = readFileSync(
    fileURLToPath(new URL('../../../scripts/rotate-encryption-key.ts', import.meta.url)),
    'utf8',
  )

  // An encrypted column the rotation script does not touch is a column that
  // gets stranded on a retired key the first time ENCRYPTION_KEY is rotated.
  const missing = Object.entries(CLASSIFIED)
    .filter(([, kind]) => kind === 'encrypted')
    .map(([column]) => column.split('.')[1])
    .filter((field, index, all) => all.indexOf(field) === index)
    .filter((field) => !script.includes(field))

  assert.deepEqual(
    missing,
    [],
    `Encrypted column(s) absent from scripts/rotate-encryption-key.ts: ${missing.join(', ')}`,
  )
})
