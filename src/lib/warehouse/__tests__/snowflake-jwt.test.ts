import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto'
import { normalizePem, snowflakeJwtAccount, snowflakeKeyPairJwt, SnowflakeKeyPairError } from '../snowflake-jwt'
import { applyHttpCredential } from '@/features/flows/http-auth'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const encrypted = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'open sesame' }).toString()
const expectedFingerprint = `SHA256:${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

test('the JWT carries Snowflake\'s claims: iss with the public key fingerprint, sub, and a one-hour expiry', () => {
  const now = 1_760_000_000
  const token = snowflakeKeyPairJwt({ account: 'xy12345.us-east-1', user: 'backstory_svc', privateKey: pkcs8 }, { now })
  const [header, payload, signature] = token.split('.')
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(decode(payload), {
    iss: `XY12345.BACKSTORY_SVC.${expectedFingerprint}`,
    sub: 'XY12345.BACKSTORY_SVC',
    iat: now,
    exp: now + 3600,
  })
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${header}.${payload}`)
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true)
})

test('the account comes from the host when not given, and an org-account identifier keeps its hyphen', () => {
  assert.equal(snowflakeJwtAccount('myorg-myaccount.snowflakecomputing.com'), 'MYORG-MYACCOUNT')
  assert.equal(snowflakeJwtAccount('https://xy12345.eu-west-1.snowflakecomputing.com'), 'XY12345')
  const token = snowflakeKeyPairJwt({ user: 'svc', privateKey: pkcs8 }, { allowedHost: 'acme-prod.snowflakecomputing.com', now: 1 })
  assert.equal(decode(token.split('.')[1]).sub, 'ACME-PROD.SVC')
})

test('an encrypted key needs its passphrase, and a key pasted on one line still parses', () => {
  const token = snowflakeKeyPairJwt({ account: 'a', user: 'u', privateKey: encrypted, passphrase: 'open sesame' }, { now: 1 })
  assert.match(String(decode(token.split('.')[1]).iss), new RegExp(`${expectedFingerprint.replace(/[+/]/g, (c) => `\\${c}`)}$`))
  assert.throws(() => snowflakeKeyPairJwt({ account: 'a', user: 'u', privateKey: encrypted, passphrase: 'wrong' }, { now: 1 }), SnowflakeKeyPairError)
  const oneLine = pkcs8.replace(/\n/g, ' ')
  assert.match(normalizePem(oneLine), /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/)
  assert.doesNotThrow(() => snowflakeKeyPairJwt({ account: 'a', user: 'u', privateKey: oneLine }, { now: 1 }))
  assert.throws(() => snowflakeKeyPairJwt({ account: 'a', user: 'u', privateKey: 'not a key' }, { now: 1 }), /not a readable PEM key/)
  assert.throws(() => snowflakeKeyPairJwt({ account: 'a', privateKey: pkcs8 }, { now: 1 }), /needs the user name/)
})

test('the HTTP credential store applies key-pair and PAT auth with Snowflake\'s token-type header, host-locked', async () => {
  const host = 'acme-prod.snowflakecomputing.com'
  const keypair = await applyHttpCredential(
    { url: `https://${host}/api/v2/statements`, init: { method: 'POST', headers: { accept: 'application/json' } } },
    { name: 'Snowflake', authType: 'snowflake_keypair', allowedHost: host, config: { account: 'acme-prod', user: 'svc', privateKey: pkcs8 } },
  )
  const keypairHeaders = keypair.init.headers as Record<string, string>
  assert.match(keypairHeaders.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  assert.equal(keypairHeaders['x-snowflake-authorization-token-type'], 'KEYPAIR_JWT')
  assert.equal(keypairHeaders.accept, 'application/json')

  const pat = await applyHttpCredential(
    { url: `https://${host}/api/v2/statements`, init: { method: 'POST' } },
    { name: 'Snowflake PAT', authType: 'snowflake_pat', allowedHost: host, config: { token: 'pat-secret' } },
  )
  const patHeaders = pat.init.headers as Record<string, string>
  assert.equal(patHeaders.authorization, 'Bearer pat-secret')
  assert.equal(patHeaders['x-snowflake-authorization-token-type'], 'PROGRAMMATIC_ACCESS_TOKEN')

  await assert.rejects(
    applyHttpCredential({ url: 'https://evil.example.com/x', init: {} }, { name: 'Snowflake PAT', authType: 'snowflake_pat', allowedHost: host, config: { token: 'pat-secret' } }),
    /restricted to acme-prod\.snowflakecomputing\.com/,
  )
})
