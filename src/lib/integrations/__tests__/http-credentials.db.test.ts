import { test, before, mock } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The agent HTTP tool and the workspace credential store.
 *
 * The tool used to tell the model to read API keys out of the agent's
 * instructions, which meant secrets lived in plain-text prompt copy. Credentials
 * are now stored encrypted and host-locked, and attached here automatically —
 * so these tests care about exactly one thing: a secret reaches the host it was
 * bound to, and no other.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'

  let prisma: any
  let seedTestOrg: any
  let HttpToolClient: any
  let encryptSecret: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ HttpToolClient } = await import('../http'))
    ;({ encryptSecret } = await import('@/lib/crypto/secrets'))
  })

  const saveCredential = (organizationId: string, allowedHost: string, token: string) =>
    prisma.httpCredential.create({
      data: {
        organizationId,
        name: `${allowedHost} bearer`,
        authType: 'bearer',
        allowedHost,
        secretConfig: encryptSecret(JSON.stringify({ token })),
        status: 'verified',
        lastVerifiedAt: new Date(),
      },
    })

  /** Capture the outbound request instead of making one. */
  function captureFetch() {
    const calls: { url: string; headers: Record<string, string> }[] = []
    mock.method(globalThis, 'fetch', async (url: any, init: any) => {
      calls.push({ url: String(url), headers: { ...(init?.headers || {}) } })
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return calls
  }

  test('a saved credential is attached automatically for its own host', async () => {
    const s = await seedTestOrg(prisma)
    const calls = captureFetch()
    try {
      await saveCredential(s.organizationId, '203.0.113.10', 'secret-token')
      const result: any = await new HttpToolClient(s.organizationId).executeTool('', 'request', {
        url: 'https://203.0.113.10/v1/things',
      })
      assert.equal(result.authenticated, true, 'the call reports that it was authenticated')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.authorization, 'Bearer secret-token', 'the stored secret was applied')
    } finally {
      mock.restoreAll()
      await s.cleanup()
    }
  })

  test('a credential is never attached to a host it is not bound to', async () => {
    const s = await seedTestOrg(prisma)
    const calls = captureFetch()
    try {
      await saveCredential(s.organizationId, '203.0.113.10', 'secret-token')
      // The model chooses the URL at run time; a different host must not
      // receive the workspace's secret.
      const result: any = await new HttpToolClient(s.organizationId).executeTool('', 'request', {
        url: 'https://198.51.100.20/collect',
      })
      assert.equal(result.authenticated, false)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.authorization, undefined, 'no credential leaked to another host')
    } finally {
      mock.restoreAll()
      await s.cleanup()
    }
  })

  test('another workspace credential is never used', async () => {
    const owner = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    const calls = captureFetch()
    try {
      await saveCredential(owner.organizationId, '203.0.113.10', 'owner-token')
      const result: any = await new HttpToolClient(other.organizationId).executeTool('', 'request', {
        url: 'https://203.0.113.10/v1/things',
      })
      assert.equal(result.authenticated, false)
      assert.equal(calls[0].headers.authorization, undefined, 'credentials do not cross tenants')
    } finally {
      mock.restoreAll()
      await owner.cleanup()
      await other.cleanup()
    }
  })

  test('with no org context the tool still works, unauthenticated', async () => {
    const calls = captureFetch()
    try {
      const result: any = await new HttpToolClient().executeTool('', 'request', {
        url: 'https://203.0.113.10/v1/public',
      })
      assert.equal(result.authenticated, false)
      assert.equal(calls.length, 1)
    } finally {
      mock.restoreAll()
    }
  })
}
