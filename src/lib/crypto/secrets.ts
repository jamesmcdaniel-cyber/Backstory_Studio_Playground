/**
 * MCP Connection secret encryption/decryption utilities.
 *
 * Storage format (encrypted): v1:<ivB64>:<tagB64>:<ctB64>
 * Storage format (fallback):  b64:<base64payload>
 *
 * Set ENCRYPTION_KEY to any non-empty string (64-char hex or base64 32-byte).
 * The key is normalised via SHA-256 so any non-empty string works.
 */

import crypto from 'crypto'

// ── Key derivation ─────────────────────────────────────────────────────────

let _warned = false

function getDerivedKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    // Secrets at rest must never silently degrade to reversible base64 in
    // production — refuse to operate instead.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY is required in production')
    }
    if (!_warned) {
      console.warn('ENCRYPTION_KEY not set — MCP secrets stored unencrypted')
      _warned = true
    }
    return null
  }
  // Derive a 32-byte key regardless of input format/length
  return crypto.createHash('sha256').update(raw).digest()
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
    'v1',
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

  if (payload.startsWith('v1:')) {
    const key = getDerivedKey()
    if (!key) {
      throw new Error(
        'ENCRYPTION_KEY is required to decrypt v1 secrets but is not set',
      )
    }

    const [, ivB64, tagB64, ctB64] = payload.split(':')
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error('Malformed v1 encrypted secret payload')
    }

    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ciphertext = Buffer.from(ctB64, 'base64')

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')
  }

  throw new Error(`Unknown secret payload format: ${payload.slice(0, 10)}`)
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
