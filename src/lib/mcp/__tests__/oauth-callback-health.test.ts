import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'

test('verified OAuth creation and reconnection persist healthy state; failed verification never writes credentials', async () => {
  const source = readFileSync('src/app/api/mcp-connections/oauth/callback/route.ts', 'utf8')
  for (const reconnect of [false, true]) {
    for (const fails of [false, true]) {
      const writes: any[] = []
      const verifiedAt = new Date('2026-10-01T00:00:00Z')
      const payload = { state: 'state', codeVerifier: 'pkce', clientId: 'client', tokenEndpoint: 'https://example.test/token', serverUrl: 'https://example.test/mcp', name: 'QA', organizationId: 'org', ...(reconnect ? { connectionId: 'connection' } : {}) }
      const mocks: Record<string, any> = {
        'next/server': { NextResponse: { redirect: (url: URL) => ({ url: String(url), cookies: { set() {} } }) } },
        '@prisma/client': {},
        '@/lib/prisma': { prisma: { mcpConnection: {
          updateMany: async (args: any) => { writes.push(args); return { count: 1 } },
          create: async (args: any) => { writes.push(args); return { id: 'created' } },
        } } },
        '@/lib/logger': { apiLogger: { error() {}, warn() {} } },
        '@/lib/crypto/secrets': { decryptSecret: () => JSON.stringify(payload), encryptSecret: (s: string) => `encrypted:${s}` },
        '@/lib/mcp/oauth-authcode': { OAUTH_COOKIE: 'qa', exchangeCode: async () => ({ access_token: 'synthetic-token' }), safeReturnToPath: () => null },
        '@/lib/mcp/backstory-connection': { bustBackstoryReadyCache() {} },
        '@/lib/mcp/verify-connection': { verifyMcpConfig: async () => { if (fails) throw Error('Handshake failed'); return { verifiedAt, schemaHash: 'verified-schema' } } },
        '@/lib/credentials/audit': { normalizeScopes: () => [], recordCredentialGrant: async () => {}, recordCredentialRotation: async () => {} },
        '@/lib/credentials/scopes': { reviewScopes: () => ({ permitted: true }), scopeViolationMessage: () => '' },
        '@/lib/ratelimit': { rateLimit: async () => ({ ok: true }) },
        '@/lib/security/events': { clientIp: () => 'synthetic-ip' },
      }
      const testModule = { exports: {} as any }
      runInNewContext(transform(source, { transforms: ['typescript', 'imports'] }).code, {
        module: testModule, exports: testModule.exports, URL, Date,
        require: (name: string) => { assert.ok(name in mocks, `Unexpected dependency ${name}`); return mocks[name] },
      })
      await testModule.exports.GET({ nextUrl: new URL('https://studio.test/callback?code=code&state=state'), cookies: { get: () => ({ value: 'encrypted-state' }) } })
      assert.equal(writes.length, fails ? 0 : 1)
      if (!fails) {
        assert.equal(writes[0].data.healthStatus, 'healthy')
        assert.equal(writes[0].data.lastError, null)
        assert.equal(writes[0].data.toolSchemaHash, 'verified-schema')
        assert.equal(writes[0].data.lastVerifiedAt, verifiedAt)
        assert.equal(writes[0].data.authConfig.accessToken, 'encrypted:synthetic-token')
        assert.equal(reconnect ? writes[0].where.organizationId : writes[0].data.organizationId, 'org')
      }
    }
  }
})
