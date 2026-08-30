import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { NangoProxy, NangoProxyArgs } from '@/lib/nango/delivery'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY

  let prisma: any
  let seeded: Awaited<ReturnType<typeof import('@/lib/server/__tests__/test-auth').seedTestOrg>>
  let agentId: string
  let syncGitHubRepository: typeof import('../github-sync').syncGitHubRepository
  let retrieveKnowledge: typeof import('../retrieve').retrieveKnowledge
  let blobSha = 'a'.repeat(40)
  let blobContent = '# Repository guide\nThe launch codename is juniper.'

  const proxy: NangoProxy = async (args: NangoProxyArgs) => {
    if (args.endpoint === '/repos/acme/reference') {
      return { data: { id: 42, owner: { login: 'acme' }, name: 'reference', full_name: 'acme/reference', private: true, default_branch: 'main' } }
    }
    if (args.endpoint === '/repos/acme/reference/git/trees/main') {
      return { data: { truncated: false, tree: [{ path: 'README.md', type: 'blob', sha: blobSha, size: Buffer.byteLength(blobContent) }] } }
    }
    if (args.endpoint === `/repos/acme/reference/git/blobs/${blobSha}`) {
      return { data: { encoding: 'base64', content: Buffer.from(blobContent).toString('base64') } }
    }
    throw new Error(`Unexpected GitHub request: ${args.endpoint}`)
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const authHelpers = await import('@/lib/server/__tests__/test-auth')
    seeded = await authHelpers.seedTestOrg(prisma)
    authHelpers.installTestAuth(seeded.auth)
    agentId = (await prisma.agentTask.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        description: 'GitHub reference agent',
        objective: 'Use synchronized repository files',
        status: 'ACTIVE',
      },
    })).id
    await prisma.nangoConnection.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        connectionId: `github-${seeded.userId}`,
        providerConfigKey: 'github',
        provider: 'github',
        status: 'connected',
      },
    })
    ;({ syncGitHubRepository } = await import('../github-sync'))
    ;({ retrieveKnowledge } = await import('../retrieve'))
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('GitHub sync is incremental, agent-scoped, and disables newly unsafe content', async () => {
    const input = {
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      agentId,
      workspaceScope: false,
      owner: 'acme',
      repo: 'reference',
      ref: 'main',
      proxy,
    }
    const first = await syncGitHubRepository(input)
    assert.equal(first.created, 1)
    assert.ok((await retrieveKnowledge({
      organizationId: seeded.organizationId,
      agentId,
      query: 'juniper launch codename',
    })).some((hit) => hit.filename === 'acme/reference/README.md'))

    const second = await syncGitHubRepository(input)
    assert.equal(second.unchanged, 1)
    assert.equal(second.created, 0)

    blobSha = 'b'.repeat(40)
    blobContent = `token = ghp_${'A'.repeat(30)}`
    const blocked = await syncGitHubRepository(input)
    assert.equal(blocked.failed, 1)
    assert.equal(blocked.disabled, 1)
    assert.equal(blocked.skipped.secret_or_binary_content, 1)
    assert.deepEqual(await retrieveKnowledge({
      organizationId: seeded.organizationId,
      agentId,
      query: 'juniper launch codename',
    }), [])
  })
}
