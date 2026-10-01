/**
 * Pure helpers for the `subflow` step (WS15) — the guards and input shaping
 * the execute-flow adapter applies before recursing into runFlowExecution.
 * Kept free of DB/model imports so every rule is unit-testable.
 */

/** How deep flows may nest (parent → child → … ). Indirect cycles A→B→A are
 * caught by this cap rather than graph analysis — each hop increments depth. */
export const SUBFLOW_MAX_DEPTH = 5

/**
 * Why a subflow dispatch must not run, or null when it may. `depth` is the
 * CURRENT run's depth (0 = a top-level run).
 */
export function subflowGuard(input: { flowId: string; selfFlowId: string; depth: number }): string | null {
  if (!input.flowId.trim()) return 'This step has no flow selected.'
  if (input.flowId === input.selfFlowId) return 'A flow cannot run itself.'
  if (input.depth >= SUBFLOW_MAX_DEPTH) {
    return `Flows can only nest ${SUBFLOW_MAX_DEPTH} levels deep — this run is already at that limit.`
  }
  return null
}

/**
 * The child run's input: the resolved per-field map when any mapped value is
 * set, else the free-form input string. Blank-valued mapped fields are
 * dropped so the child's own defaults (WS11 input defaults) can fill them.
 */
export function subflowChildInput(
  inputs: Record<string, unknown> | undefined,
  fallback: unknown,
): unknown {
  const entries = Object.entries(inputs ?? {}).filter(([, value]) => value !== undefined && (typeof value !== 'string' || value.trim() !== ''))
  if (entries.length) return Object.fromEntries(entries)
  return fallback === undefined ? '' : fallback
}
