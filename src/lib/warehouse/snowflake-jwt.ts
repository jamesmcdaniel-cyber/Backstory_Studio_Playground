import { createHash, createPrivateKey, createPublicKey, createSign, type KeyObject } from 'node:crypto'

/**
 * Snowflake key-pair authentication: a short-lived RS256 JWT signed with the
 * service user's private key.
 *
 *   header   { alg: RS256, typ: JWT }
 *   iss      <ACCOUNT>.<USER>.SHA256:<base64 SHA-256 of the public key's DER SPKI>
 *   sub      <ACCOUNT>.<USER>
 *   iat/exp  now / now + 1 hour (Snowflake's maximum)
 *
 * sent as `Authorization: Bearer <jwt>` with
 * `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT`.
 *
 * The private key lives only in the encrypted HTTP credential and is read here
 * at request time; neither it nor the token ever enters flow data.
 */

export class SnowflakeKeyPairError extends Error {}

export type SnowflakeKeyPairConfig = {
  account?: string
  user?: string
  privateKey?: string
  passphrase?: string
}

const JWT_LIFETIME_SECONDS = 60 * 60
/** Reuse a signed token until this close to its expiry. */
const REUSE_MARGIN_SECONDS = 5 * 60

/**
 * The account part of iss/sub: uppercase, and only the part before the first
 * dot — an account locator with a region (`xy12345.us-east-1`) signs as
 * `XY12345`, and a pasted host (`myorg-acct.snowflakecomputing.com`) as
 * `MYORG-ACCT`.
 */
export function snowflakeJwtAccount(account: string): string {
  return account.trim().replace(/^https?:\/\//i, '').split('.')[0].toUpperCase()
}

/**
 * A PEM pasted into a single-line field loses its line breaks; rebuild the
 * block so node:crypto can parse it. Anything already well-formed is kept.
 */
export function normalizePem(raw: string): string {
  const text = raw.trim().replace(/\\n/g, '\n')
  const match = /^(-----BEGIN [A-Z ]+-----)\s*([\s\S]+?)\s*(-----END [A-Z ]+-----)$/.exec(text)
  if (!match) return text
  const [, begin, body, end] = match
  // Encrypted PKCS#1 keys carry Proc-Type/DEK-Info headers that must keep their lines.
  if (/:/.test(body)) return text
  const compact = body.replace(/\s+/g, '')
  return `${begin}\n${compact.match(/.{1,64}/g)?.join('\n') ?? compact}\n${end}\n`
}

export function snowflakePrivateKey(config: SnowflakeKeyPairConfig): KeyObject {
  if (!config.privateKey?.trim()) throw new SnowflakeKeyPairError('Snowflake key-pair authentication needs the private key (PEM).')
  try {
    return createPrivateKey({
      key: normalizePem(config.privateKey),
      format: 'pem',
      ...(config.passphrase ? { passphrase: config.passphrase } : {}),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (/passphrase|decrypt|bad decrypt/i.test(reason)) {
      throw new SnowflakeKeyPairError('The Snowflake private key could not be decrypted — check its passphrase.')
    }
    throw new SnowflakeKeyPairError('The Snowflake private key is not a readable PEM key (expected "-----BEGIN PRIVATE KEY-----" or "-----BEGIN ENCRYPTED PRIVATE KEY-----").')
  }
}

/** `SHA256:<base64>` — the fingerprint Snowflake stores as RSA_PUBLIC_KEY_FP. */
export function snowflakePublicKeyFingerprint(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url')

const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/**
 * Sign (or reuse) the JWT for this key. `now` is seconds since the epoch,
 * injectable for tests.
 */
export function snowflakeKeyPairJwt(
  config: SnowflakeKeyPairConfig,
  options: { allowedHost?: string; now?: number } = {},
): string {
  const accountSource = config.account?.trim() || options.allowedHost || ''
  if (!accountSource) throw new SnowflakeKeyPairError('Snowflake key-pair authentication needs the account identifier.')
  if (!config.user?.trim()) throw new SnowflakeKeyPairError('Snowflake key-pair authentication needs the user name the public key is assigned to.')
  const account = snowflakeJwtAccount(accountSource)
  const user = config.user.trim().toUpperCase()
  const key = snowflakePrivateKey(config)
  const fingerprint = snowflakePublicKeyFingerprint(key)
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const cacheKey = `${account}.${user}.${fingerprint}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt - REUSE_MARGIN_SECONDS > now && options.now === undefined) return cached.token

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: `${account}.${user}.${fingerprint}`,
    sub: `${account}.${user}`,
    iat: now,
    exp: now + JWT_LIFETIME_SECONDS,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  const token = `${header}.${payload}.${base64url(signer.sign(key))}`
  if (options.now === undefined) tokenCache.set(cacheKey, { token, expiresAt: now + JWT_LIFETIME_SECONDS })
  return token
}
