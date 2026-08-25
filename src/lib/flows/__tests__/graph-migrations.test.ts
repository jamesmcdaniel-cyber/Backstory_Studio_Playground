import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CURRENT_GRAPH_VERSION,
  GRAPH_MIGRATIONS,
  describeGraphMigration,
  graphSchemaVersion,
  isFutureGraph,
  migrateGraphShape,
  pendingGraphMigrations,
  type GraphMigration,
} from '@/lib/flows/graph-migrations'
import { flowGraphSchema } from '@/lib/flows/graph'

/**
 * The chain is empty today, so most of what is worth pinning is the SHAPE of
 * the mechanism: that it runs in order, that it stamps, that a graph from a
 * newer deployment is left alone. Those are the properties that will be relied
 * on by the first real migration, written by someone who is not looking at this
 * file.
 */

// A stand-in chain, so ordering and application are tested without inventing a
// migration in production code that nothing needs yet.
function runChain(chain: readonly GraphMigration[], graph: Record<string, unknown>, from: number) {
  let out = graph
  for (const migration of chain.filter((entry) => entry.to > from)) out = migration.migrate(out)
  return out
}

test('the registered chain is ordered, gapless, and ends at the current version', () => {
  // The invariant every future migration depends on. A gap means a graph is
  // migrated past a step; a duplicate means one runs twice.
  let expected = 1
  for (const migration of GRAPH_MIGRATIONS) {
    assert.equal(migration.to, expected, `migration out of order at ${migration.to}`)
    assert.ok(migration.describe.trim().length > 0, `migration ${migration.to} has no description`)
    expected += 1
  }
  const last = GRAPH_MIGRATIONS.at(-1)?.to ?? CURRENT_GRAPH_VERSION
  assert.equal(
    last,
    CURRENT_GRAPH_VERSION,
    'CURRENT_GRAPH_VERSION must equal the last migration — raise it in the same commit',
  )
})

test('every flow saved before versioning reads as version 0', () => {
  assert.equal(graphSchemaVersion({ nodes: [], edges: [] }), 0)
  assert.equal(graphSchemaVersion({ nodes: [], edges: [], schemaVersion: undefined }), 0)
  // Junk in the stamp is not a version — it is an unstamped graph.
  for (const stamp of ['2', 1.5, -1, null, {}, NaN]) {
    assert.equal(graphSchemaVersion({ schemaVersion: stamp }), 0, String(stamp))
  }
})

test('migrating stamps the graph so it is not re-migrated forever', () => {
  const migrated = migrateGraphShape({ nodes: [], edges: [] }) as Record<string, unknown>
  assert.equal(migrated.schemaVersion, CURRENT_GRAPH_VERSION)
  // Idempotent: the second pass is a no-op that returns the same object.
  assert.equal(migrateGraphShape(migrated), migrated)
})

test('a graph from a newer deployment is passed through, never rewritten', () => {
  // Mid-rollout, an older instance reads what a newer one just saved. It cannot
  // know how to down-convert, and rewriting is how that read corrupts the flow.
  const future = { nodes: [], edges: [], schemaVersion: CURRENT_GRAPH_VERSION + 5 }
  assert.equal(isFutureGraph(future), true)
  assert.equal(migrateGraphShape(future), future)
  assert.deepEqual(describeGraphMigration(future).pending, [])
})

test('a non-graph value is returned untouched rather than stamped', () => {
  for (const value of [null, undefined, 'graph', 42, []]) {
    assert.equal(migrateGraphShape(value), value, String(value))
  }
})

test('migrations run in order, each seeing the previous one’s output', () => {
  const chain: GraphMigration[] = [
    { to: 1, describe: 'rename a to b', migrate: (g) => ({ ...g, trail: [...((g.trail as string[]) ?? []), 'one'] }) },
    { to: 2, describe: 'drop b', migrate: (g) => ({ ...g, trail: [...((g.trail as string[]) ?? []), 'two'] }) },
  ]
  assert.deepEqual(runChain(chain, { nodes: [] }, 0).trail, ['one', 'two'])
  // A graph already at 1 skips the first.
  assert.deepEqual(runChain(chain, { nodes: [] }, 1).trail, ['two'])
})

test('pending migrations are what a graph still has to go through', () => {
  assert.deepEqual([...pendingGraphMigrations(CURRENT_GRAPH_VERSION)], [])
  assert.equal(pendingGraphMigrations(0).length, GRAPH_MIGRATIONS.length)
})

test('the report says where a stored graph stands', () => {
  const old = describeGraphMigration({ nodes: [], edges: [] })
  assert.equal(old.version, 0)
  assert.equal(old.current, false, 'version 0 is not the current shape')
  assert.equal(old.future, false)

  const now = describeGraphMigration({ nodes: [], edges: [], schemaVersion: CURRENT_GRAPH_VERSION })
  assert.equal(now.current, true)
  assert.deepEqual(now.pending, [])
})

// ── The seam that makes it invisible to every caller ────────────────────────

test('parsing a legacy graph migrates and stamps it, with no call site involved', () => {
  const parsed = flowGraphSchema.parse({
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }],
    edges: [],
  })
  assert.equal(parsed.schemaVersion, CURRENT_GRAPH_VERSION)
  assert.equal(parsed.nodes.length, 1)
})

test('parsing preserves a graph’s content exactly — versioning adds, never edits', () => {
  const parsed = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'call', type: 'http', data: { method: 'GET', url: 'https://x.test' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
    pinData: { call: { ok: true } },
  })
  assert.equal(parsed.nodes[1].id, 'call')
  assert.deepEqual(parsed.edges, [{ id: 'e1', source: 'trigger', target: 'call' }])
  assert.deepEqual(parsed.pinData, { call: { ok: true } })
})

test('a malformed graph still fails validation — migration is not a repair pass', () => {
  const result = flowGraphSchema.safeParse({ nodes: 'not an array', edges: [] })
  assert.equal(result.success, false)
})
