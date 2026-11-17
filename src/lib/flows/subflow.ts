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

/** How a parent flow's subflow step describes the pause it is sitting in. */
export type SubflowWait = {
  /**
   * The CHILD's own wait kind, carried up as-is. A reply box on the parent is
   * right only when the child is asking a person something: an approval,
   * timer, webhook or external-agent wait resumes the child on its own, and
   * the child's finish then wakes the parent.
   */
  kind: string
  question: string
  resumeAt?: string
  timeoutAt?: string
}

/**
 * Describe a paused child for the parent's waiting row, from the child's own
 * waiting step output (`{ waiting: { kind, question, resumeAt, timeoutAt } }`).
 * A child with no readable pause reason (a legacy row) keeps the old meaning:
 * it paused to ask for input.
 */
export function describeSubflowWait(childWaitingOutput: unknown, childName: string): SubflowWait {
  const waiting = (childWaitingOutput as { waiting?: Record<string, unknown> } | null | undefined)?.waiting
  const kind = typeof waiting?.kind === 'string' && waiting.kind ? waiting.kind : 'input'
  const question = typeof waiting?.question === 'string' ? waiting.question : ''
  const resumeAt = typeof waiting?.resumeAt === 'string' ? waiting.resumeAt : undefined
  const timeoutAt = typeof waiting?.timeoutAt === 'string' ? waiting.timeoutAt : undefined
  const described =
    kind === 'approval'
      ? `"${childName}" is waiting for an approval decision.`
      : kind === 'external'
        ? `"${childName}" is waiting for an external agent to reply.`
        : kind === 'timer'
          ? `"${childName}" is waiting on a timer.`
          : kind === 'webhook'
            ? `"${childName}" is waiting for a webhook callback.`
            : question
              ? `${childName}: ${question}`
              : `"${childName}" paused to ask for input.`
  return { kind, question: described, ...(resumeAt ? { resumeAt } : {}), ...(timeoutAt ? { timeoutAt } : {}) }
}

/** The agent-style waiting status a parent reports for a child's wait kind. */
export function subflowWaitingStatus(kind: string): 'waiting_for_input' | 'waiting_for_approval' | 'waiting_for_external' {
  return kind === 'approval' ? 'waiting_for_approval' : kind === 'external' ? 'waiting_for_external' : 'waiting_for_input'
}
