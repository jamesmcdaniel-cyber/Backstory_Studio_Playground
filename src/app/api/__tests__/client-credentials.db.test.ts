import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The client-credentials exchange and the short-lived tokens it issues.
 *
 * The properties worth regression-testing are the ones that would silently
 * WIDEN access if they broke: a token outranking its key, a token outliving a
 * revoked key, or a deactivated owner still able to mint fresh tokens. Each of
 * those turns "revoke immediately" into "revoke eventually", which is the exact
 * guarantee this system is built on.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let systemPrisma: any
  let seedTestOrg: any
  let exchangeClientCredentials: any
  let mintClientCredentials: any
  let purgeExpiredAccessTokens: any

  before(async () => {
    ;({ systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ exchangeClientCredentials, mintClientCredentials, purgeExpiredAccessTokens } = await import(
      '@/lib/public-api/client-credentials'
    ))
  })

  async function seedKey(scopes: string[] = ['flows:read', 'flows:write']) {
    const org = await seedTestOrg(systemPrisma)
    const user = await systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `${crypto.randomUUID()}@example.com`,
        organizationId: org.organizationId,
        role: 'ADMIN',
        isActive: true,
      },
    })
    const credentials = mintClientCredentials()
    const key = await systemPrisma.apiKey.create({
      data: {
        organizationId: org.organizationId,
        userId: user.id,
        name: 'test key',
        scopes,
        clientId: credentials.clientId,
        keyHash: credentials.clientSecretHash,
        prefix: credentials.clientId.slice(0, 12),
      },
    })
    return { org, user, key, credentials }
  }

  test('a valid pair exchanges for a short-lived token carrying the key scopes', async () => {
    const { credentials } = await seedKey()
    const result = await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })

    assert.equal(result.ok, true)
    assert.ok(result.result.accessToken.startsWith('bsa_'))
    assert.ok(result.result.expiresInSeconds > 0 && result.result.expiresInSeconds <= 3600)
    assert.deepEqual(result.result.scopes.sort(), ['flows:read', 'flows:write'])
  })

  test('the access token is never stored in plaintext', async () => {
    const { credentials, key } = await seedKey()
    const result = await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })

    const stored = await systemPrisma.apiAccessToken.findFirst({ where: { apiKeyId: key.id } })
    assert.ok(stored)
    assert.notEqual(stored.tokenHash, result.result.accessToken)
    assert.equal(stored.tokenHash.length, 64, 'a sha-256 hex digest')
  })

  test('a wrong secret is refused, and says only invalid_client', async () => {
    // Never "no such client" vs "wrong secret" — that difference is an oracle
    // for enumerating valid client ids.
    const { credentials } = await seedKey()
    const wrong = await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: 'bss_not-the-secret',
    })
    const missing = await exchangeClientCredentials({
      clientId: 'bsc_does-not-exist',
      clientSecret: credentials.clientSecret,
    })

    assert.equal(wrong.ok, false)
    assert.equal(missing.ok, false)
    assert.equal(wrong.reason, missing.reason, 'both failures must be indistinguishable')
  })

  test('a token may NARROW its key scopes', async () => {
    const { credentials } = await seedKey(['flows:read', 'flows:write'])
    const result = await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      requestedScopes: ['flows:read'],
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.result.scopes, ['flows:read'])
  })

  test('a token can never WIDEN beyond its key scopes', async () => {
    // Refused rather than silently intersected: quietly granting less than was
    // asked for produces failures far from their cause.
    const { credentials } = await seedKey(['flows:read'])
    const result = await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      requestedScopes: ['flows:read', 'flows:write'],
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid_scope')
  })

  test('a revoked key cannot mint new tokens', async () => {
    const { credentials, key } = await seedKey()
    await systemPrisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } })

    const result = await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })
    assert.equal(result.ok, false)
  })

  test('an expired key cannot mint new tokens', async () => {
    const { credentials, key } = await seedKey()
    await systemPrisma.apiKey.update({
      where: { id: key.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const result = await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid_grant')
  })

  test('a deactivated owner turns the key off, not just its own sessions', async () => {
    // Otherwise offboarding would revoke the key's direct use while leaving it
    // a working token factory.
    const { credentials, user } = await seedKey()
    await systemPrisma.user.update({ where: { id: user.id }, data: { isActive: false } })

    const result = await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unauthorized_client')
  })

  test('deleting a key cascades to every token it issued', async () => {
    const { credentials, key } = await seedKey()
    await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })

    await systemPrisma.apiKey.delete({ where: { id: key.id } })
    const orphans = await systemPrisma.apiAccessToken.count({ where: { apiKeyId: key.id } })
    assert.equal(orphans, 0, 'a live token must not outlive the key that issued it')
  })

  test('purging expired tokens leaves live ones alone', async () => {
    const { credentials, key } = await seedKey()
    await exchangeClientCredentials({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })
    await systemPrisma.apiAccessToken.create({
      data: {
        organizationId: key.organizationId,
        apiKeyId: key.id,
        tokenHash: crypto.randomBytes(32).toString('hex'),
        scopes: ['flows:read'],
        expiresAt: new Date(Date.now() - 60_000),
      },
    })

    await purgeExpiredAccessTokens()
    const remaining = await systemPrisma.apiAccessToken.findMany({ where: { apiKeyId: key.id } })
    assert.equal(remaining.length, 1)
    assert.ok(remaining[0].expiresAt > new Date())
  })
}
