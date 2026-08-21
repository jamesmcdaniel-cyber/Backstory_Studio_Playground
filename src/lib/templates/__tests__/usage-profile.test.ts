import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateUsage, capabilitiesForProviders, USAGE_WINDOW_DAYS, type UsageRow } from '../usage-profile'
import type { ConnectedProvider, ConnectedPlane } from '@/lib/integrations/connected'

const row = (provider: string, tool: string, runId: string | null, at: string): UsageRow => ({ provider, tool, runId, at })
const cp = (key: string, plane: ConnectedPlane = 'nango', label = key): ConnectedProvider => ({ key, label, plane })

test('empty rows produce an empty profile with the default window', () => {
  const profile = aggregateUsage([])
  assert.deepEqual(profile.providers, [])
  assert.deepEqual(profile.topTools, [])
  assert.deepEqual(profile.coOccurrence, [])
  assert.deepEqual(profile.sequences, [])
  assert.equal(profile.runCount, 0)
  assert.equal(profile.windowDays, USAGE_WINDOW_DAYS)
  // Enrichment fields are populated only by buildUsageProfile; the pure
  // aggregator always leaves them empty.
  assert.deepEqual(profile.capabilities, [])
  assert.deepEqual(profile.themes, [])
  // The pure aggregator has no notion of the DB-side row cap -- only
  // buildUsageProfile can ever mark a profile sampled.
  assert.equal(profile.sampled, false)
})

test('providers count rows per provider, desc with a deterministic tie-break', () => {
  const rows = [
    row('slack', 'send', 'r1', '2026-07-01T00:00:00Z'),
    row('slack', 'send', 'r1', '2026-07-01T00:01:00Z'),
    row('gmail', 'send', 'r1', '2026-07-01T00:02:00Z'),
    row('asana', 'task', 'r2', '2026-07-01T00:03:00Z'),
    row('gmail', 'read', 'r2', '2026-07-01T00:04:00Z'),
  ]
  const { providers } = aggregateUsage(rows)
  // slack=2, gmail=2, asana=1 -> slack & gmail tie at 2, tie-break by provider string asc (gmail < slack)
  assert.deepEqual(providers, [
    { provider: 'gmail', calls: 2 },
    { provider: 'slack', calls: 2 },
    { provider: 'asana', calls: 1 },
  ])
})

test('topTools counts per (provider,tool) and caps at 25, desc', () => {
  const rows: UsageRow[] = []
  // 30 distinct tools with descending call counts 30..1 so the top 25 are stable
  for (let i = 0; i < 30; i++) {
    const calls = 30 - i
    for (let c = 0; c < calls; c++) {
      rows.push(row('slack', `tool${String(i).padStart(2, '0')}`, `r${i}`, `2026-07-01T00:00:${String(c).padStart(2, '0')}Z`))
    }
  }
  const { topTools } = aggregateUsage(rows)
  assert.equal(topTools.length, 25)
  assert.deepEqual(topTools[0], { provider: 'slack', tool: 'tool00', calls: 30 })
  assert.equal(topTools[24].calls, 6) // 30th..? cap keeps counts 30 down to 6
})

test('coOccurrence counts distinct-provider SETS shared across runs (size >= 2 only)', () => {
  const rows = [
    // run 1 uses {slack, gmail} (with a dup slack row that must dedupe to a set)
    row('slack', 'send', 'r1', '2026-07-01T00:00:00Z'),
    row('slack', 'send', 'r1', '2026-07-01T00:00:30Z'),
    row('gmail', 'send', 'r1', '2026-07-01T00:01:00Z'),
    // run 2 uses {gmail, slack} in a different order -> SAME set
    row('gmail', 'read', 'r2', '2026-07-01T00:02:00Z'),
    row('slack', 'send', 'r2', '2026-07-01T00:03:00Z'),
    // run 3 is single-provider -> set size 1 -> dropped
    row('asana', 'task', 'r3', '2026-07-01T00:04:00Z'),
    // null-run rows are ignored for co-occurrence
    row('notion', 'page', null, '2026-07-01T00:05:00Z'),
    row('linear', 'issue', null, '2026-07-01T00:06:00Z'),
  ]
  const { coOccurrence } = aggregateUsage(rows)
  assert.deepEqual(coOccurrence, [{ providers: ['gmail', 'slack'], runs: 2 }])
})

test('sequences collapse consecutive same-provider and count identical chains (length >= 2)', () => {
  const rows = [
    // run 1: slack, slack, gmail -> collapse -> [slack, gmail]
    row('slack', 'a', 'r1', '2026-07-01T00:00:00Z'),
    row('slack', 'b', 'r1', '2026-07-01T00:00:10Z'),
    row('gmail', 'c', 'r1', '2026-07-01T00:00:20Z'),
    // run 2: slack, gmail, gmail -> collapse -> [slack, gmail] (SAME chain)
    row('slack', 'a', 'r2', '2026-07-01T00:00:00Z'),
    row('gmail', 'c', 'r2', '2026-07-01T00:00:10Z'),
    row('gmail', 'd', 'r2', '2026-07-01T00:00:20Z'),
    // run 3: slack, slack -> collapse -> [slack] length 1 -> dropped
    row('slack', 'a', 'r3', '2026-07-01T00:00:00Z'),
    row('slack', 'b', 'r3', '2026-07-01T00:00:10Z'),
  ]
  const { sequences } = aggregateUsage(rows)
  assert.deepEqual(sequences, [{ steps: ['slack', 'gmail'], count: 2 }])
})

test('sequences are ordered by `at`, not by input order', () => {
  const rows = [
    row('gmail', 'c', 'r1', '2026-07-01T00:00:20Z'),
    row('slack', 'a', 'r1', '2026-07-01T00:00:00Z'),
  ]
  const { sequences } = aggregateUsage(rows)
  assert.deepEqual(sequences, [{ steps: ['slack', 'gmail'], count: 1 }])
})

test('output is deterministic and stable across shuffled input', () => {
  const rows = [
    row('slack', 'send', 'r1', '2026-07-01T00:00:00Z'),
    row('gmail', 'send', 'r1', '2026-07-01T00:01:00Z'),
    row('slack', 'send', 'r2', '2026-07-01T00:02:00Z'),
    row('gmail', 'read', 'r2', '2026-07-01T00:03:00Z'),
    row('asana', 'task', 'r3', '2026-07-01T00:04:00Z'),
    row('gmail', 'send', 'r3', '2026-07-01T00:05:00Z'),
    row('notion', 'page', 'r4', '2026-07-01T00:06:00Z'),
    row('slack', 'send', 'r4', '2026-07-01T00:07:00Z'),
  ]
  const base = aggregateUsage(rows)
  // A fixed, non-trivial reordering of the same multiset.
  const shuffled = [rows[5], rows[0], rows[7], rows[2], rows[6], rows[1], rows[4], rows[3]]
  const other = aggregateUsage(shuffled)
  assert.deepEqual(other, base)
  // A second, different reordering must also match.
  const shuffled2 = [rows[3], rows[6], rows[1], rows[5], rows[0], rows[4], rows[7], rows[2]]
  assert.deepEqual(aggregateUsage(shuffled2), base)
})

test('runCount is the number of distinct non-null runs', () => {
  const rows = [
    row('slack', 'send', 'r1', '2026-07-01T00:00:00Z'),
    row('gmail', 'send', 'r1', '2026-07-01T00:01:00Z'),
    row('slack', 'send', 'r2', '2026-07-01T00:02:00Z'),
    row('notion', 'page', null, '2026-07-01T00:03:00Z'),
  ]
  assert.equal(aggregateUsage(rows).runCount, 2)
})

test('windowDays is passed through', () => {
  assert.equal(aggregateUsage([], 30).windowDays, 30)
})

// ── capabilitiesForProviders (pure enrichment, no DB) ────────────────────────

test('capabilitiesForProviders maps a connected provider to its catalogued capabilities', () => {
  const caps = capabilitiesForProviders([cp('github')])
  assert.equal(caps.length, 1)
  assert.equal(caps[0].provider, 'github')
  assert.ok(caps[0].capabilities.includes('github_create_issue'))
  assert.ok(caps[0].capabilities.length > 0)
})

test('capabilitiesForProviders dedupes a provider case-insensitively', () => {
  const caps = capabilitiesForProviders([cp('slack', 'nango'), cp('SLACK', 'nango')])
  assert.equal(caps.length, 1, 'one capability entry per distinct provider')
  assert.equal(caps[0].provider, 'slack')
})

test('capabilitiesForProviders covers Granola from the Nango tool registry', () => {
  const caps = capabilitiesForProviders([cp('granola', 'builtin')])
  assert.deepEqual(caps, [{ provider: 'granola', capabilities: ['granola_list_notes', 'granola_get_note'] }])
})

test('capabilitiesForProviders omits custom MCP servers with no static catalogue', () => {
  assert.deepEqual(capabilitiesForProviders([cp('mcp:abc', 'mcp')]), [])
})

test('capabilitiesForProviders is sorted by provider for determinism', () => {
  const caps = capabilitiesForProviders([cp('slack', 'nango'), cp('github', 'nango')])
  assert.deepEqual(caps.map((c) => c.provider), ['github', 'slack'])
})

test('a non-empty provider with an empty tool still counts (lifecycle rows must be filtered at the query, not here)', () => {
  // aggregateUsage has no notion of an audit `action`: a leaked lifecycle row
  // like flow.published (resourceType='flow', tool=null) would count as a 'flow'
  // provider here. buildUsageProfile therefore restricts by action at the DB
  // query (TOOL_USAGE_ACTIONS). This locks the aggregator's correct
  // non-filtering behavior so the responsibility stays where the signal exists.
  const { providers, topTools } = aggregateUsage([row('flow', '', 'r1', '2026-07-01T00:00:00Z')])
  assert.deepEqual(providers, [{ provider: 'flow', calls: 1 }])
  assert.deepEqual(topTools, [{ provider: 'flow', tool: '', calls: 1 }])
})
