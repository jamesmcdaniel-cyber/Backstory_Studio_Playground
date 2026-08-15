/**
 * Secret encryption/decryption utilities (MCP connections, HTTP credentials,
 * integration secrets, People.ai tokens, OAuth state cookies).
 *
 * Storage format (current):  v2:<keyId>:<ivB64>:<tagB64>:<ctB64>
 * Storage format (legacy):   v1:<ivB64>:<tagB64>:<ctB64>
 * Storage format (legacy):   b64:<base64payload>  — READ-ONLY, see below
 *
 * `b64:` is reversible and is no longer written outside `NODE_ENV=test`. It
 * stays readable so rows written before that change can still be decrypted and
 * re-encrypted by `npm run secrets:rotate`.
 *
 * ── Key rotation ─────────────────────────────────────────────────────────
 * v1 carried no key identifier, which meant a compromised ENCRYPTION_KEY could
 * not be replaced: every stored secret was tied to it with nothing to say which
 * key it was, so a rotation would have silently bricked every credential in the
 * database with no way to tell rows apart.
 *
 * v2 prefixes each payload with a short, non-secret key id. That makes a
 * dual-read / single-write rotation possible:
 *
 *   1. Set ENCRYPTION_KEY_PREVIOUS to the current key, and ENCRYPTION_KEY to
 *      the new one. Both are now readable; all new writes use the new key.
 *   2. Run `npm run secrets:rotate` to re-encrypt every stored payload onto the
 *      new key (`--dry-run` first to see the counts).
 *   3. Once the script reports zero remaining, unset ENCRYPTION_KEY_PREVIOUS.
 *
 * ENCRYPTION_KEY_PREVIOUS accepts a comma-separated list, so an interrupted
 * rotation can be resumed without stranding rows on an intermediate key.
 *
 * Keys may be any non-empty string (64-char hex, base64 32-byte, or a
 * passphrase) — each is normalised to 32 bytes via SHA-256.
 */

import crypto from 'crypto'

// ── Key derivation ─────────────────────────────────────────────────────────

let _warned = false

/**
 * Short, stable, non-secret identifier for a derived key.
 *
 * A second SHA-256 pass, so the id is a digest OF the key rather than a prefix
 * of it — publishing the id in the ciphertext must not leak key material. 8 hex
 * characters is 32 bits: ample to tell apart the two or three keys a rotation
 * ever has in flight at once.
 */
function keyIdFor(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)
}

function deriveKey(raw: string): Buffer {
  return crypto.createHash('sha256').update(raw).digest()
}

function getDerivedKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    // Secrets at rest must never silently degrade to reversible base64 — refuse
    // to operate instead.
    //
    // This once threw only in production, which meant a staging or development
    // box wrote real, working credentials to a real database as reversible
    // base64 and said so in a single startup warning nobody re-reads. "Not
    // production" is not a property of the DATA: the same Slack token opens the
    // same workspace whatever NODE_ENV called it. So the only environment still
    // allowed the fallback is `test`, where the values are fixtures by
    // construction and there is no database to leave them in.
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        'ENCRYPTION_KEY is required to store secrets. Generate one with `openssl rand -hex 32` ' +
          'and set it in your environment (see .env.example).',
      )
    }
    if (!_warned) {
      console.warn('ENCRYPTION_KEY not set — test-mode fixtures stored unencrypted')
      _warned = true
    }
    return null
  }
  // Derive a 32-byte key regardless of input format/length
  return deriveKey(raw)
}

/**
 * Every key this process can DECRYPT with: the primary first, then any
 * retired keys still named in ENCRYPTION_KEY_PREVIOUS.
 *
 * Read from the environment on each call rather than cached at module load —
 * the rotation script and the tests both change these variables at runtime, and
 * a cached ring would serve a stale answer to exactly the code that needs it to
 * be current.
 */
function decryptionRing(): Array<{ id: string; key: Buffer }> {
  const ring: Array<{ id: string; key: Buffer }> = []
  const seen = new Set<string>()

  for (const raw of [process.env.ENCRYPTION_KEY, ...(process.env.ENCRYPTION_KEY_PREVIOUS ?? '').split(',')]) {
    const trimmed = raw?.trim()
    if (!trimmed) continue
    const key = deriveKey(trimmed)
    const id = keyIdFor(key)
    if (seen.has(id)) continue
    seen.add(id)
    ring.push({ id, key })
  }

  return ring
}

/**
 * The key id new writes are stamped with, or null when no key is configured.
 * Exposed for the rotation script and the health probe, so "which key is this
 * deployment writing with" is answerable without printing key material.
 */
export function activeKeyId(): string | null {
  const key = getDerivedKey()
  return key ? keyIdFor(key) : null
}

/**
 * Whether a stored payload is already encrypted under the ACTIVE key. The
 * rotation script uses this to decide what still needs re-encrypting; false for
 * legacy v1/b64 payloads, which always need rewriting.
 */
export function isCurrentKeyPayload(payload: string): boolean {
  const active = activeKeyId()
  return Boolean(active) && payload.startsWith(`v2:${active}:`)
}

/**
 * Whether secrets are actually encrypted at rest.
 *
 * False means ENCRYPTION_KEY is unset and `encryptSecret` is falling back to
 * reversible base64 — impossible in production (getDerivedKey throws), but a
 * staging box running NODE_ENV != 'production' would silently store credentials
 * in the clear. Surfaced on the health probe so that is visible rather than
 * discovered later.
 */
export function encryptionConfigured(): boolean {
  return Boolean(process.env.ENCRYPTION_KEY)
}

// ── One-way token hashing (webhook trigger secrets) ────────────────────────

/**
 * SHA-256 hex digest of a token. Used to store webhook trigger secrets so the
 * plaintext is never persisted — the secret is shown once at creation/rotation
 * and validated by hashing the presented value. Compare with timingSafeEqualHex.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time compare of two hex digests (returns false on length mismatch). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

// ── Encryption ────────────────────────────────────────────────────────────

export function encryptSecret(plaintext: string): string {
  const key = getDerivedKey()

  if (!key) {
    // Fallback: reversible base64 encoding (no security)
    return 'b64:' + Buffer.from(plaintext, 'utf8').toString('base64')
  }

  const iv = crypto.randomBytes(12) // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag() // 128-bit authentication tag

  return [
    'v2',
    keyIdFor(key),
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

// ── Decryption ────────────────────────────────────────────────────────────

export function decryptSecret(payload: string): string {
  if (payload.startsWith('b64:')) {
    // Legacy unencrypted payloads stay readable, but only when the process is
    // properly configured — production without a key must not run at all.
    if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY is required in production')
    }
    return Buffer.from(payload.slice(4), 'base64').toString('utf8')
  }

  if (payload.startsWith('v2:')) {
    const [, keyId, ivB64, tagB64, ctB64] = payload.split(':')
    if (!keyId || !ivB64 || !tagB64 || !ctB64) {
      throw new Error('Malformed v2 encrypted secret payload')
    }

    const ring = decryptionRing()
    if (!ring.length) {
      throw new Error('ENCRYPTION_KEY is required to decrypt v2 secrets but is not set')
    }

    const match = ring.find((entry) => entry.id === keyId)
    if (!match) {
      // Named a key this process does not hold. Say which one: the id is not
      // secret, and "which key am I missing" is the entire question during a
      // half-finished rotation.
      throw new Error(
        `No configured key matches id ${keyId} — add the retired key to ENCRYPTION_KEY_PREVIOUS`,
      )
    }

    return gcmDecrypt(match.key, ivB64, tagB64, ctB64)
  }

  if (payload.startsWith('v1:')) {
    const [, ivB64, tagB64, ctB64] = payload.split(':')
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error('Malformed v1 encrypted secret payload')
    }

    const ring = decryptionRing()
    if (!ring.length) {
      throw new Error(
        'ENCRYPTION_KEY is required to decrypt v1 secrets but is not set',
      )
    }

    // v1 carries no key id, so the only way to identify the key is to try each
    // one. GCM's auth tag makes that safe and unambiguous: a wrong key fails
    // the tag check rather than returning plausible garbage.
    for (const { key } of ring) {
      try {
        return gcmDecrypt(key, ivB64, tagB64, ctB64)
      } catch {
        continue
      }
    }
    throw new Error('No configured key can decrypt this v1 secret')
  }

  throw new Error(`Unknown secret payload format: ${payload.slice(0, 10)}`)
}

function gcmDecrypt(key: Buffer, ivB64: string, tagB64: string, ctB64: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

// ── authConfig assembly ───────────────────────────────────────────────────

export type AuthType = 'none' | 'api_key' | 'oauth2'

export interface RawAuthInput {
  authType: AuthType
  apiKey?: string
  headerName?: string
  clientId?: string
  clientSecret?: string
  tokenUrl?: string
  scopes?: string
  /**
   * Which oauth2 grant the caller is configuring. Only 'client_credentials' is
   * meaningful here — it tells mergeAuthConfig to discard the authorization-code
   * artefacts (tokens, flow marker) left behind by a previous SSO connect, so a
   * connection switched to client credentials stops presenting stale SSO tokens.
   * The authcode side is written directly by the OAuth callback route.
   */
  flow?: 'client_credentials' | 'authcode'
}

/** Keys written only by the authorization-code (SSO) callback. */
const AUTHCODE_ONLY_KEYS = ['flow', 'accessToken', 'refreshToken', 'tokenEndpoint', 'expiresAt']
/** Keys that belong to api_key auth and mean nothing under oauth2 (and vice versa). */
const API_KEY_ONLY_KEYS = ['apiKey', 'headerName']
const OAUTH_ONLY_KEYS = [...AUTHCODE_ONLY_KEYS, 'clientId', 'clientSecret', 'tokenUrl', 'scopes']

function without(
  existing: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const next = { ...existing }
  for (const key of keys) delete next[key]
  return next
}

/**
 * Build the `authConfig` JSON blob for storage.
 * Secret fields (apiKey, clientSecret) are encrypted; everything else is plain.
 */
export function buildAuthConfig(input: RawAuthInput): Record<string, unknown> {
  const { authType } = input

  if (authType === 'none') {
    return {}
  }

  if (authType === 'api_key') {
    return {
      ...(input.apiKey !== undefined && {
        apiKey: encryptSecret(input.apiKey),
      }),
      ...(input.headerName !== undefined && { headerName: input.headerName }),
    }
  }

  if (authType === 'oauth2') {
    return {
      ...(input.clientId !== undefined && { clientId: input.clientId }),
      ...(input.clientSecret !== undefined && {
        clientSecret: encryptSecret(input.clientSecret),
      }),
      ...(input.tokenUrl !== undefined && { tokenUrl: input.tokenUrl }),
      ...(input.scopes !== undefined && { scopes: input.scopes }),
    }
  }

  return {}
}

/**
 * Merge an existing stored authConfig with updated fields from a PUT request.
 * Only re-encrypts fields that were explicitly provided in `input`.
 * Fields omitted from `input` are preserved from `existing`.
 */
export function mergeAuthConfig(
  existing: Record<string, unknown>,
  input: RawAuthInput,
): Record<string, unknown> {
  const { authType } = input

  if (authType === 'none') {
    return {}
  }

  if (authType === 'api_key') {
    // Drop oauth2 leftovers so a connection switched from oauth2 to api_key
    // stops carrying credentials it no longer uses.
    return {
      ...without(existing, OAUTH_ONLY_KEYS),
      ...(input.apiKey !== undefined && {
        apiKey: encryptSecret(input.apiKey),
      }),
      ...(input.headerName !== undefined && { headerName: input.headerName }),
    }
  }

  if (authType === 'oauth2') {
    const stale =
      input.flow === 'client_credentials'
        ? [...API_KEY_ONLY_KEYS, ...AUTHCODE_ONLY_KEYS]
        : API_KEY_ONLY_KEYS
    return {
      ...without(existing, stale),
      ...(input.clientId !== undefined && { clientId: input.clientId }),
      ...(input.clientSecret !== undefined && {
        clientSecret: encryptSecret(input.clientSecret),
      }),
      ...(input.tokenUrl !== undefined && { tokenUrl: input.tokenUrl }),
      ...(input.scopes !== undefined && { scopes: input.scopes }),
    }
  }

  return {}
}

// ── Redacted view for API responses ──────────────────────────────────────

export interface RedactedAuthConfig {
  authType: AuthType
  hasApiKey?: boolean
  headerName?: string
  clientId?: string
  tokenUrl?: string
  scopes?: string
  hasClientSecret?: boolean
  /** 'authcode' marks a connection established via the SSO redirect flow. */
  flow?: 'authcode'
}

/**
 * Return a safe, non-secret view of authType + authConfig for API responses.
 * Secrets (apiKey, clientSecret) are NEVER included.
 */
export function redactConfig(
  authType: string,
  authConfig: unknown,
): RedactedAuthConfig {
  const cfg =
    authConfig && typeof authConfig === 'object' && !Array.isArray(authConfig)
      ? (authConfig as Record<string, unknown>)
      : {}

  const type = authType as AuthType

  if (type === 'api_key') {
    return {
      authType: type,
      hasApiKey: Boolean(cfg.apiKey),
      ...(cfg.headerName !== undefined && {
        headerName: cfg.headerName as string,
      }),
    }
  }

  if (type === 'oauth2') {
    return {
      authType: type,
      ...(cfg.flow === 'authcode' && { flow: 'authcode' as const }),
      ...(cfg.clientId !== undefined && { clientId: cfg.clientId as string }),
      ...(cfg.tokenUrl !== undefined && { tokenUrl: cfg.tokenUrl as string }),
      ...(cfg.scopes !== undefined && { scopes: cfg.scopes as string }),
      hasClientSecret: Boolean(cfg.clientSecret),
    }
  }

  return { authType: 'none' }
}
