import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cachedToolDiscovery,
  loadNativePlaneGroups,
  mcpConnectionScope,
  mcpConnectionSlug,
  resolveFlowToolExecutor,
  toolDiscoveryCacheKey,
  toolName,
} from '@/features/agents/tool-planes'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'

/**
 * Tool-plane routing and its permission boundaries.
 *
 * Everything here runs without a database: the plane selection, the visibility
 * scope, the discovery cache key, and the executor's refusals are all decided
 * before any Prisma call. The DB-backed halves (an actual mcpConnection row, a
 * resolved Nango connection) are marked skipped below rather than silently
 * omitted.
 */

// ── tool naming ───────────────────────────────────────────────────────────────

test('toolName sanitizes to the model-callable charset and bounds the length', () => {
  assert.equal(toolName('slack', 'send_message'), 'slack_send_message')
  // A connection named "Acme's CRM (prod)" must not emit a name the model API rejects.
  assert.equal(toolName("acme's crm (prod)", 'find/account'), 'acme_s_crm__prod__find_account')
  assert.match(toolName('nango:salesforce', 'create_record'), /^[a-zA-Z0-9_-]+$/)
  const long = toolName('p'.repeat(50), 'n'.repeat(50))
  assert.equal(long.length, 64)
})

test('mcpConnectionSlug produces a stable provider slug from a display name', () => {
  assert.equal(mcpConnectionSlug('Acme CRM'), 'acme_crm')
  assert.equal(mcpConnectionSlug('  Weird -- Name!! '), 'weird_name')
  assert.equal(mcpConnectionSlug('***'), '')
})

// ── visibility scope: the cross-member boundary ───────────────────────────────

test('mcpConnectionScope always pins the org and only ever widens to the acting user', () => {
  const anon = mcpConnectionScope('org-1')
  assert.equal(anon.organizationId, 'org-1')
  assert.equal(anon.isActive, true)
  assert.equal('OR' in anon, false, 'an ownerless load must not widen to personal connections')

  const scoped = mcpConnectionScope('org-1', 'user-1')
  assert.equal(scoped.organizationId, 'org-1')
  assert.equal(scoped.isActive, true)
  // Exactly two alternatives: org-shared rows, and this user's own rows.
  assert.deepEqual(scoped.OR, [{ userId: null }, { userId: 'user-1' }])
  const owners = (scoped.OR ?? []).map((clause) => clause.userId)
  assert.equal(owners.includes('user-2' as never), false, 'another member\'s personal connection must not be visible')
})

// ── discovery cache: one org must not pin another org's tool set ──────────────

test('the discovery cache key is org-scoped, so a shared server URL is not shared', () => {
  const url = 'https://mcp.example.com/mcp'
  assert.notEqual(toolDiscoveryCacheKey('org-a', url), toolDiscoveryCacheKey('org-b', url))
  assert.equal(toolDiscoveryCacheKey('org-a', url), toolDiscoveryCacheKey('org-a', url))
})

test('cachedToolDiscovery caches a non-empty result and never caches an empty one', async () => {
  const url = `https://cache-test.example/${Math.random()}`
  let calls = 0
  const fetchTools = async () => {
    calls += 1
    return [{ name: 'find_account' }]
  }
  const first = await cachedToolDiscovery('org-cache-1', url, fetchTools)
  assert.deepEqual(first, [{ name: 'find_account' }])
  await cachedToolDiscovery('org-cache-1', url, fetchTools)
  assert.equal(calls, 1, 'a warm discovery must not re-hit the server')

  // A different org on the SAME server URL re-discovers: MCP servers can gate
  // tools/list by identity, so one tenant's answer must not serve another's.
  await cachedToolDiscovery('org-cache-2', url, fetchTools)
  assert.equal(calls, 2)
})

test('a transient empty discovery is never pinned for the TTL', async () => {
  const url = `https://cache-empty.example/${Math.random()}`
  let calls = 0
  const empty = await cachedToolDiscovery('org-empty', url, async () => {
    calls += 1
    return []
  })
  assert.deepEqual(empty, [])
  const later = await cachedToolDiscovery('org-empty', url, async () => {
    calls += 1
    return [{ name: 'back_online' }]
  })
  assert.deepEqual(later, [{ name: 'back_online' }], 'an empty answer must not disable the integration for the TTL')
  assert.equal(calls, 2)
})

test('cachedToolDiscovery propagates a discovery failure instead of caching a fallback', async () => {
  const url = `https://cache-fail.example/${Math.random()}`
  await assert.rejects(
    () => cachedToolDiscovery('org-fail', url, async () => { throw new Error('server down') }),
    /server down/,
  )
})

// ── native plane selection ────────────────────────────────────────────────────

test('the native plane loads only the built-ins the agent actually selected', async () => {
  const groups = await loadNativePlaneGroups('org-1', { providers: ['http'] })
  assert.equal(groups.length, 1, `expected only the HTTP plane, got ${groups.map((g) => g.provider).join(', ')}`)
  const [http] = groups
  assert.equal(http.plane, 'native')
  assert.equal(http.provider, 'http')
  assert.equal(http.id, 'native:http')
  assert.equal(parseFlowToolConnectionId(http.id).plane, 'native')
  assert.ok(http.client, 'a selected, available plane must carry an execution client')
  assert.ok(http.tools.some((tool) => tool.name === 'request'), 'the HTTP plane exposes the generic request tool')
  // Write classification drives the approval gate — it must come from the registry.
  assert.equal(http.isWrite, BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'http')!.isWrite)
})

test('an agent that selected nothing gets no native tools at all', async () => {
  assert.deepEqual(await loadNativePlaneGroups('org-1', { providers: [] }), [])
})

test('agent-configured HTTP endpoints become their own named tools beside request', async () => {
  const [http] = await loadNativePlaneGroups('org-1', {
    providers: ['http'],
    httpEndpoints: [
      { id: 'e1', name: 'Get Widget', method: 'GET', url: 'https://api.example.com/widget', description: 'fetch a widget' } as never,
    ],
  })
  assert.ok(http.tools.length > 1, 'a configured endpoint must add a tool')
  assert.ok(http.tools.some((tool) => tool.name === 'request'))
  const named = http.tools.filter((tool) => tool.name !== 'request')
  assert.ok(named.length >= 1)
  for (const tool of http.tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]+$/, `tool "${tool.name}" is not a callable tool name`)
    assert.ok(tool.description, `tool "${tool.name}" must be described for the model`)
  }
})

// ── flow tool executor: plane boundaries ──────────────────────────────────────

const executorParams = (plane: 'people_ai' | 'mcp' | 'native' | 'nango', ref: string) => ({
  organizationId: 'org-1',
  userId: 'user-1',
  plane,
  ref,
  toolName: 'anything',
})

test('the native plane refuses a ref that is not a built-in integration', async () => {
  // A crafted/stale graph naming an arbitrary ref must not fall through to
  // another plane's resolution — it is a hard, user-actionable refusal.
  for (const ref of ['backstory', 'salesforce', 'nango:gmail', '', '../slack']) {
    await assert.rejects(
      () => resolveFlowToolExecutor(executorParams('native', ref)),
      /Unknown built-in integration/,
      `native ref "${ref}" should not resolve`,
    )
  }
})

test('the HTTP built-in resolves with the registry write flag and no credential', async () => {
  const executor = await resolveFlowToolExecutor(executorParams('native', 'http'))
  assert.equal(executor.provider, 'http')
  assert.equal(executor.isWrite, BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'http')!.isWrite)
  assert.equal(typeof executor.execute, 'function')
})

test('the nango plane refuses everything when integrations are not configured', async () => {
  const saved = process.env.NANGO_SECRET_KEY
  delete process.env.NANGO_SECRET_KEY
  try {
    await assert.rejects(
      () => resolveFlowToolExecutor(executorParams('nango', 'gmail')),
      /Integrations are not configured/,
    )
  } finally {
    if (saved === undefined) delete process.env.NANGO_SECRET_KEY
    else process.env.NANGO_SECRET_KEY = saved
  }
})

test('a nango ref that names neither a provider tool nor a delivery capability is refused', async () => {
  const saved = process.env.NANGO_SECRET_KEY
  process.env.NANGO_SECRET_KEY = 'test-key'
  try {
    await assert.rejects(
      () => resolveFlowToolExecutor(executorParams('nango', 'not_a_real_tool')),
      /Unknown Nango tool/,
    )
    // A built-in provider id is not a Nango tool either — planes do not alias.
    await assert.rejects(
      () => resolveFlowToolExecutor(executorParams('nango', 'granola')),
      /Unknown Nango tool/,
    )
  } finally {
    if (saved === undefined) delete process.env.NANGO_SECRET_KEY
    else process.env.NANGO_SECRET_KEY = saved
  }
})

test.skip('DB-backed: an mcp ref owned by another member does not resolve — needs a live mcpConnection row (see mcpConnectionScope coverage above)', () => {})
test.skip("DB-backed: a resolved Nango executor refuses a tool name other than its own — needs a live Nango connection", () => {})
