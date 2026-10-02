import { test } from 'node:test'
import assert from 'node:assert/strict'

// Prisma delegates are dynamic proxies, not methods Node's mock.method can
// replace. Supply the existing global client seam before importing consumers.
const nangoReads: unknown[] = []
const agentReads: Array<{ where: Record<string, unknown> }> = []
;(globalThis as Record<string, unknown>).prisma = {
  nangoConnection: { findMany: async (query: unknown) => { nangoReads.push(query); return [{ connectionId: 'qa-github', providerConfigKey: 'github', userId: 'qa-user' }] } },
  agentTask: { findMany: async (query: { where: Record<string, unknown> }) => { agentReads.push(query); return [] } },
}

test('flow validation resolves only the Nango tools the graph names', async () => {
  const saved = process.env.NANGO_SECRET_KEY
  process.env.NANGO_SECRET_KEY = 'qa-no-network'
  const { loadFlowToolCatalog } = await import('../tool-catalog')
  try {
    const catalog = await loadFlowToolCatalog('qa-org', { userId: 'qa-user', connectionIds: ['nango:github_list_repositories'] })
    assert.equal(nangoReads.length, 1, 'unrelated provider credentials must not be resolved')
    assert.deepEqual(catalog.map(c => c.id), ['nango:github_list_repositories'])
    assert.deepEqual(catalog[0].tools.map(t => t.name), ['github_list_repositories'])
  } finally {
    if (saved === undefined) delete process.env.NANGO_SECRET_KEY; else process.env.NANGO_SECRET_KEY = saved
  }
})

test('a code-only graph never loads the workspace agent roster', async () => {
    const { loadRunValidationContext } = await import('../run-validation')
    const context = await loadRunValidationContext({ nodes: [], edges: [], schemaVersion: 2 }, { organizationId: 'qa-org', userId: 'qa-user' })
    assert.deepEqual(context.agents, [])
    assert.equal(agentReads.length, 0)
})

test('agent lookup stays scoped to exactly the graph dependencies and visibility', async () => {
    const { loadRunValidationContext } = await import('../run-validation')
    await loadRunValidationContext({ nodes: [{ id: 'a', type: 'agent', data: { agentId: 'named-agent' } }], edges: [], schemaVersion: 2 } as never, { organizationId: 'qa-org', userId: 'qa-user' })
    const query = agentReads[0]
    assert.deepEqual(query.where.id, { in: ['named-agent'] })
    assert.equal(query.where.organizationId, 'qa-org')
    assert.ok(query.where.OR)
})
