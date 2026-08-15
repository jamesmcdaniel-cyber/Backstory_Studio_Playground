/**
 * Per-step narrowing of the tools an agent may call.
 *
 * The only per-step tool control was additive: `toolConnectionIds` GRANTED
 * extra connections for one step. There was no way to take anything away, so a
 * step whose job is "read these records and write a summary" still held every
 * write tool its agent owns — send mail, create records, delete.
 *
 * That matters because of what feeds these steps. A flow agent reads the output
 * of earlier steps: third-party API responses, webhook bodies, CRM notes an
 * outsider can write. An agent processing attacker-influenceable content while
 * holding a send/delete tool is the confused-deputy shape a workflow platform
 * is most exposed to, and fencing the data reduces the odds without changing
 * what is reachable if the fence is talked through.
 *
 * Least privilege is the control that still holds when the model is fooled.
 *
 * ── Narrowing only ─────────────────────────────────────────────────────────
 *
 * A policy can only REMOVE tools from the set already resolved for the run. It
 * is applied after the agent's own tools and any step-granted connections, so
 * it can never be used to reach something the agent was not already allowed —
 * which means a flow author cannot escalate through it, only restrict.
 */

export type ToolPolicyMode = 'inherit' | 'readonly' | 'allowlist' | 'none'

export interface ToolPolicy {
  mode: ToolPolicyMode
  allowedTools?: string[]
}

/**
 * Name fragments implying a tool changes something rather than reading it.
 *
 * Shared in spirit with the import capability analyzer's list and deliberately
 * generous for the same reason: over-restricting a step produces a visible,
 * reported failure the author can fix in seconds, while under-restricting fails
 * silently and only once it matters.
 */
const WRITE_NAME_FRAGMENTS = [
  'create',
  'update',
  'delete',
  'send',
  'post',
  'write',
  'remove',
  'archive',
  'upload',
  'invite',
  'assign',
  'close',
  'publish',
  'merge',
  'move',
  'add',
  'set',
  'reply',
  'comment',
  'schedule',
  'cancel',
  'approve',
  'revoke',
  'execute',
  'run',
]

export function isWriteToolName(name: string): boolean {
  const normalized = name.toLowerCase()
  return WRITE_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

export interface PolicyDecision<T> {
  tools: T[]
  /** Names removed, for the run log — a silently shrunk tool set is a bug report. */
  removed: string[]
}

/**
 * Apply a step's policy to the tools resolved for the run.
 *
 * `nameOf` keeps this independent of the tool object shape, so it can be unit
 * tested without constructing a live tool set.
 */
export function applyToolPolicy<T>(
  tools: T[],
  policy: ToolPolicy | undefined,
  nameOf: (tool: T) => string,
): PolicyDecision<T> {
  const mode = policy?.mode ?? 'inherit'
  if (mode === 'inherit') return { tools, removed: [] }

  if (mode === 'none') {
    return { tools: [], removed: tools.map(nameOf) }
  }

  const keep = (tool: T): boolean => {
    const name = nameOf(tool)
    if (mode === 'readonly') return !isWriteToolName(name)
    // allowlist: exact match only. Prefix or fuzzy matching would let
    // `send_message` satisfy an allowlist entry of `send`, which is the
    // opposite of what an allowlist is for.
    return (policy?.allowedTools ?? []).includes(name)
  }

  const tools_ = tools.filter(keep)
  return { tools: tools_, removed: tools.filter((tool) => !keep(tool)).map(nameOf) }
}

/** One line for the run log, or null when the policy changed nothing. */
export function describeToolPolicy(decision: PolicyDecision<unknown>, mode: ToolPolicyMode): string | null {
  if (mode === 'inherit' || decision.removed.length === 0) return null
  return `Tool policy (${mode}) withheld ${decision.removed.length} tool(s) from this step: ${decision.removed
    .slice(0, 8)
    .join(', ')}${decision.removed.length > 8 ? '…' : ''}.`
}
