import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const SECURITY_DATA_OPS = ['hash', 'hmac', 'jwtSign', 'jwtVerify', 'totpGenerate', 'totpVerify'] as const
export type SecurityDataOp = (typeof SECURITY_DATA_OPS)[number]

export type SecurityOpConfig = {
  input: unknown
  secret?: string
  algorithm?: string
  nowUnix?: number
  expiresInSeconds?: number
  issuer?: string
  audience?: string
  digits?: 6 | 8
  period?: number
}

export type SecurityOpResult = { output: unknown } | { error: string }

const HASHES = new Set(['sha256', 'sha384', 'sha512'])
const JWT_ALGORITHMS: Record<string, string> = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }

function text(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? null)
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function jsonPart(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`JWT ${label} is invalid.`)
  }
}

function jwtSignature(message: string, secret: string, algorithm: string): Buffer {
  const hash = JWT_ALGORITHMS[algorithm]
  if (!hash) throw new Error('JWT algorithm must be HS256, HS384, or HS512.')
  return createHmac(hash, secret).update(message).digest()
}

function decodeBase32(value: string): Buffer {
  const source = value.toUpperCase().replace(/[\s=-]/g, '')
  if (!source || /[^A-Z2-7]/.test(source)) throw new Error('TOTP secret must be base32 text.')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const character of source) bits += alphabet.indexOf(character).toString(2).padStart(5, '0')
  const bytes: number[] = []
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2))
  return Buffer.from(bytes)
}

function totp(secret: string, timestamp: number, algorithm: string, digits: 6 | 8, period: number): string {
  const key = decodeBase32(secret)
  const counter = Math.floor(timestamp / period)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac(algorithm, key).update(buffer).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(binary).padStart(digits, '0')
}

export function runSecurityOp(op: SecurityDataOp, config: SecurityOpConfig): SecurityOpResult {
  try {
    if (op === 'hash') {
      const algorithm = (config.algorithm ?? 'sha256').toLowerCase()
      if (!HASHES.has(algorithm)) return { error: 'Hash algorithm must be SHA-256, SHA-384, or SHA-512.' }
      return { output: createHash(algorithm).update(text(config.input)).digest('hex') }
    }

    const secret = config.secret ?? ''
    if (secret.length < 8) return { error: 'This operation needs a secret of at least 8 characters.' }

    if (op === 'hmac') {
      const algorithm = (config.algorithm ?? 'sha256').toLowerCase()
      if (!HASHES.has(algorithm)) return { error: 'HMAC algorithm must be SHA-256, SHA-384, or SHA-512.' }
      return { output: createHmac(algorithm, secret).update(text(config.input)).digest('hex') }
    }

    if (op === 'jwtSign') {
      if (!config.input || typeof config.input !== 'object' || Array.isArray(config.input)) {
        return { error: 'Sign JWT needs an object of claims.' }
      }
      const algorithm = (config.algorithm ?? 'HS256').toUpperCase()
      const now = Math.floor(config.nowUnix ?? Date.now() / 1000)
      const claims: Record<string, unknown> = { ...(config.input as Record<string, unknown>) }
      if (claims.iat === undefined) claims.iat = now
      if (config.expiresInSeconds && claims.exp === undefined) claims.exp = now + config.expiresInSeconds
      if (config.issuer && claims.iss === undefined) claims.iss = config.issuer
      if (config.audience && claims.aud === undefined) claims.aud = config.audience
      const message = `${base64url(JSON.stringify({ alg: algorithm, typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`
      return { output: `${message}.${base64url(jwtSignature(message, secret, algorithm))}` }
    }

    if (op === 'jwtVerify') {
      if (typeof config.input !== 'string') return { error: 'Verify JWT needs a token string.' }
      const parts = config.input.split('.')
      if (parts.length !== 3) return { error: 'JWT must contain three parts.' }
      const header = jsonPart(parts[0], 'header')
      const algorithm = (config.algorithm ?? 'HS256').toUpperCase()
      if (header.alg !== algorithm) return { error: `JWT algorithm does not match ${algorithm}.` }
      const expected = jwtSignature(`${parts[0]}.${parts[1]}`, secret, algorithm)
      const actual = Buffer.from(parts[2], 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { error: 'JWT signature is invalid.' }
      const claims = jsonPart(parts[1], 'payload')
      const now = Math.floor(config.nowUnix ?? Date.now() / 1000)
      if (typeof claims.nbf === 'number' && now < claims.nbf) return { error: 'JWT is not active yet.' }
      if (typeof claims.exp === 'number' && now >= claims.exp) return { error: 'JWT has expired.' }
      if (config.issuer && claims.iss !== config.issuer) return { error: 'JWT issuer does not match.' }
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (config.audience && !audiences.includes(config.audience)) return { error: 'JWT audience does not match.' }
      return { output: { valid: true, header, claims } }
    }

    const algorithm = (config.algorithm ?? 'sha1').toLowerCase()
    if (!['sha1', 'sha256', 'sha512'].includes(algorithm)) return { error: 'TOTP algorithm must be SHA-1, SHA-256, or SHA-512.' }
    const digits = config.digits ?? 6
    const period = Math.max(15, Math.min(120, Math.round(config.period ?? 30)))
    const now = Math.floor(config.nowUnix ?? Date.now() / 1000)
    if (op === 'totpGenerate') return { output: totp(secret, now, algorithm, digits, period) }
    if (typeof config.input !== 'string' || !/^\d{6}(?:\d{2})?$/.test(config.input)) return { error: 'Verify TOTP needs a 6- or 8-digit code.' }
    const input = config.input
    const valid = [-1, 0, 1].some((window) => {
      const candidate = Buffer.from(totp(secret, now + window * period, algorithm, digits, period))
      const supplied = Buffer.from(input)
      return candidate.length === supplied.length && timingSafeEqual(candidate, supplied)
    })
    return { output: { valid } }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The security operation failed.' }
  }
}
