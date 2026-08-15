/**
 * Client-credentials exchange for the public API.
 *
 * The API took one long-lived bearer token, which was both the credential and
 * the identifier. Two consequences: identifying a key in a support thread meant
 * pasting the secret, and every single request carried a value that stayed
 * valid until a human revoked it.
 *
 * A pair fixes the first (clientId is public and safe to quote) and the token
 * exchange fixes the second: callers trade the pair for an access token that
 * expires in minutes, so a leaked proxy log or request trace exposes something
 * already dead.
 *
 * Both halves are additive. Keys minted before this still authenticate with
 * their bearer token, because breaking every existing integration to improve a
 * credential format is not a trade anyone would accept.
 */

import { randomBytes } from 'node:crypto'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { systemPrisma } from '@/lib/prisma'

/** Access-token lifetime. Short enough to matter, long enough not to thrash. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60

export const CLIENT_ID_PREFIX = 'bsc_'
export const CLIENT_SECRET_PREFIX = 'bss_'
export const ACCESS_TOKEN_PREFIX = 'bsa_'

export interface MintedClientCredentials {
  clientId: string
  clientSecret: string
  /** Digest stored in ApiKey.keyHash — the secret itself is never persisted. */
  clientSecretHash: string
}

export function mintClientCredentials(): MintedClientCredentials {
  const clientSecret = `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`
  return {
    clientId: `${CLIENT_ID_PREFIX}${randomBytes(12).toString('base64url')}`,
    clientSecret,
    clientSecretHash: hashToken(clientSecret),
  }
}

export type ExchangeFailure =
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'invalid_scope'

export interface ExchangeSuccess {
  accessToken: string
  expiresInSeconds: number
  scopes: string[]
}

/**
 * Exchange a client-credentials pair for a short-lived access token.
 *
 * Every failure returns the same `invalid_client` to the caller (the route
 * decides the wording): distinguishing "no such client" from "wrong secret"
 * turns the endpoint into an oracle for enumerating valid client ids.
 */
export async function exchangeClientCredentials(params: {
  clientId: string
  clientSecret: string
  /** Optional narrowing. Omitted means "everything this key already has". */
  requestedScopes?: string[]
  now?: Date
}): Promise<{ ok: true; result: ExchangeSuccess } | { ok: false; reason: ExchangeFailure }> {
  const now = params.now ?? new Date()

  const key = await systemPrisma.apiKey.findFirst({
    // systemPrisma: the client id resolves the tenant before tenant context exists.
    where: { clientId: params.clientId, revokedAt: null },
    select: { id: true, organizationId: true, userId: true, scopes: true, keyHash: true, expiresAt: true },
  })
  if (!key) return { ok: false, reason: 'invalid_client' }

  // Constant-time, and over the DIGESTS rather than the secrets — the stored
  // value is a hash, and comparing hashes keeps the timing profile flat
  // regardless of how much of the secret was correct.
  if (!timingSafeEqualHex(hashToken(params.clientSecret), key.keyHash)) {
    return { ok: false, reason: 'invalid_client' }
  }

  if (key.expiresAt && key.expiresAt <= now) return { ok: false, reason: 'invalid_grant' }

  // The owner check mirrors the bearer path exactly. A key whose owner was
  // deactivated must not be able to mint fresh tokens — otherwise offboarding
  // would revoke the key's own use while leaving it a token factory.
  if (!key.userId) return { ok: false, reason: 'unauthorized_client' }
  const owner = await systemPrisma.user.findFirst({
    where: { id: key.userId, organizationId: key.organizationId, isActive: true },
    select: { id: true },
  })
  if (!owner) return { ok: false, reason: 'unauthorized_client' }

  const keyScopes = Array.isArray(key.scopes)
    ? key.scopes.filter((scope): scope is string => typeof scope === 'string')
    : []

  // A token may narrow its key's scopes but never widen them. Asking for
  // something the key does not hold is an error rather than a silent
  // intersection: silently granting less than requested produces failures far
  // from their cause.
  const requested = params.requestedScopes?.length ? params.requestedScopes : keyScopes
  const overreach = requested.filter((scope) => !keyScopes.includes(scope))
  if (overreach.length > 0) return { ok: false, reason: 'invalid_scope' }
  if (requested.length === 0) return { ok: false, reason: 'invalid_scope' }

  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000)

  await systemPrisma.apiAccessToken.create({
    data: {
      organizationId: key.organizationId,
      apiKeyId: key.id,
      tokenHash: hashToken(accessToken),
      // Snapshotted, so narrowing the key later cannot widen a live token, and
      // a token can never outrank the key that issued it.
      scopes: requested,
      expiresAt,
    },
  })

  return {
    ok: true,
    result: { accessToken, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS, scopes: requested },
  }
}

/**
 * Delete expired tokens.
 *
 * Expiry is already enforced on every read, so this is housekeeping rather than
 * a security control — but an append-only table of dead credentials is both a
 * growing index and a bigger thing to lose in a breach.
 */
export async function purgeExpiredAccessTokens(before: Date = new Date()): Promise<number> {
  const result = await systemPrisma.apiAccessToken.deleteMany({
    where: { expiresAt: { lt: before } },
  })
  return result.count
}
