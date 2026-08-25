/**
 * Versioning for the stored flow graph.
 *
 * A saved flow is a JSON graph interpreted by whatever code is deployed when it
 * runs. Nothing recorded which shape it was written against, so changing what a
 * node's `data` means silently reinterpreted every flow already in the database
 * — including published ones running on a schedule against real customer
 * systems. We got away with it because the schema has mostly grown additively.
 * That is a property of our history, not of the design.
 *
 * The graph carries a `schemaVersion`, and every node carries a `typeVersion`.
 * A migration chain brings an older
 * graph up to the current shape at PARSE time — so every reader gets a migrated
 * graph without a single call site knowing this exists. The graph version
 * defines the envelope while `typeVersion` pins each node's execution contract,
 * so one node can evolve without silently changing every saved instance.
 */

export const CURRENT_GRAPH_VERSION = 2

/**
 * A graph written before versioning existed. Every flow in the database today
 * is version 0, and reads as such because it carries no stamp.
 */
export const UNSTAMPED_GRAPH_VERSION = 0

export type GraphMigration = {
  /** The version this migration produces. Must be exactly one above its predecessor. */
  to: number
  /** What changed, in the words the report shows an operator. */
  describe: string
  /** Pure: takes a graph one version below `to`, returns it at `to`. */
  migrate: (graph: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Ordered, gapless, and append-only.
 *
 * To change what a node means: add a migration here that rewrites the old shape
 * into the new one, and raise CURRENT_GRAPH_VERSION to match. The test suite
 * fails if the chain gains a gap, loses its order, or stops ending at the
 * current version.
 */
export const GRAPH_MIGRATIONS: readonly GraphMigration[] = [
  {
    to: 1,
    describe: 'Stamp legacy flow graphs with the first explicit graph schema version.',
    migrate: (graph) => ({ ...graph, schemaVersion: 1 }),
  },
  {
    to: 2,
    describe: 'Pin every node implementation version and make connection type and input/output indexes explicit.',
    migrate: (graph) => ({
      ...graph,
      nodes: Array.isArray(graph.nodes)
        ? graph.nodes.map((node) => (isRecord(node) ? { typeVersion: 1, ...node } : node))
        : graph.nodes,
      edges: Array.isArray(graph.edges)
        ? graph.edges.map((edge) =>
            isRecord(edge)
              ? { connectionType: 'main', sourceOutput: 0, targetInput: 0, ...edge }
              : edge,
          )
        : graph.edges,
      schemaVersion: 2,
    }),
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * The version a stored graph was written against.
 *
 * Anything unstamped, or stamped with something that is not a whole number, is
 * version 0 — the shape that predates versioning. A stamp from the FUTURE (a
 * graph written by a newer deployment, read by an older one mid-rollout) is
 * returned as-is rather than clamped, so the caller can tell the difference
 * between "needs migrating" and "was written by something newer than me".
 */
export function graphSchemaVersion(raw: unknown): number {
  if (!isRecord(raw)) return UNSTAMPED_GRAPH_VERSION
  const stamped = raw.schemaVersion
  if (typeof stamped !== 'number' || !Number.isInteger(stamped) || stamped < 0) {
    return UNSTAMPED_GRAPH_VERSION
  }
  return stamped
}

/** The migrations a graph at this version still has to go through. */
export function pendingGraphMigrations(version: number): readonly GraphMigration[] {
  return GRAPH_MIGRATIONS.filter((migration) => migration.to > version)
}

/** True when a graph was written by a deployment newer than this one. */
export function isFutureGraph(raw: unknown): boolean {
  return graphSchemaVersion(raw) > CURRENT_GRAPH_VERSION
}

/**
 * Bring a stored graph up to the current shape.
 *
 * Applied by `flowGraphSchema` itself, so every reader — the executor, the
 * editor, the publish route, the importer — gets a migrated graph without
 * knowing this exists.
 *
 * A graph from the future is passed through untouched: an older deployment
 * cannot know how to down-convert, and quietly rewriting it would be how a
 * mid-rollout read corrupts a flow a newer instance just saved. It still parses
 * — unknown fields are stripped by the schema, which is the same tolerance we
 * have always had — it simply is not rewritten here.
 */
export function migrateGraphShape(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const from = graphSchemaVersion(raw)
  if (from > CURRENT_GRAPH_VERSION) return raw
  if (from === CURRENT_GRAPH_VERSION) return raw

  let graph = raw
  for (const migration of pendingGraphMigrations(from)) {
    graph = migration.migrate(graph)
  }
  return { ...graph, schemaVersion: CURRENT_GRAPH_VERSION }
}

/**
 * A one-line account of what a stored graph needs, for the operator report.
 *
 * Answering "which saved flows are on an old shape, and what would change" is
 * the half of versioning that a version number alone does not give you — it is
 * what turns a silent reinterpretation into something someone can look at.
 */
export function describeGraphMigration(raw: unknown): {
  version: number
  current: boolean
  future: boolean
  pending: string[]
} {
  const version = graphSchemaVersion(raw)
  const future = version > CURRENT_GRAPH_VERSION
  return {
    version,
    current: version === CURRENT_GRAPH_VERSION,
    future,
    pending: future ? [] : pendingGraphMigrations(version).map((migration) => migration.describe),
  }
}
