/**
 * Per-run state overrides: "pretend this step produced THIS instead".
 *
 * Distinct from graph.pinData, which lives on the flow DRAFT and is therefore
 * shared by every run. Overrides live on the FlowRun row, so forking a run to
 * test a hypothesis never mutates the flow everyone else is editing.
 *
 * Precedence at execution time: stateOverrides > pinData > replayed output.
 */

export type StateOverrides = Record<string, unknown>

/** Narrow persisted JSON to a usable override map. Empty means "none". */
export function parseStateOverrides(value: unknown): StateOverrides | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length ? (Object.fromEntries(entries) as StateOverrides) : null
}

/**
 * Resolve one node's override. `iterationKey` is either a bare node id or the
 * per-iteration `${nodeId}#${index}` form used inside loops.
 *
 * An exact `node#i` entry applies to that iteration only; a bare `node` entry
 * applies to every iteration. The more specific key wins.
 *
 * Returns `hit` separately from `value` so that overriding a step to `null` is
 * expressible and distinct from "not overridden". Uses hasOwnProperty rather
 * than `in` so a node named `constructor` or `toString` cannot resolve to an
 * inherited Object.prototype member.
 */
export function resolveOverride(
  overrides: StateOverrides | null,
  iterationKey: string,
): { hit: boolean; value: unknown } {
  if (!overrides) return { hit: false, value: undefined }

  if (Object.prototype.hasOwnProperty.call(overrides, iterationKey)) {
    return { hit: true, value: overrides[iterationKey] }
  }

  const bare = iterationKey.split('#')[0]
  if (Object.prototype.hasOwnProperty.call(overrides, bare)) {
    return { hit: true, value: overrides[bare] }
  }

  return { hit: false, value: undefined }
}
