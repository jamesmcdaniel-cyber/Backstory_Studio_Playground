/**
 * The daily model ceilings, stated as pure data and pure functions.
 *
 * Split from model-allowance.ts, which reads the ledger to decide what a given
 * person may still use, because these names are needed in three places that
 * must not reach a database: the router, the operator console's client bundle,
 * and their tests. A client component importing a module that touches Prisma
 * pulls the client into the browser bundle.
 *
 * The rationale for the ceilings themselves lives in model-allowance.ts.
 */

export const MODEL_LIMITS = {
  /**
   * Runs per UTC day that may use a frontier Claude model.
   *
   * Well below the whole-family cap because these are the models where one run
   * can cost more than a day of the rest.
   */
  frontierClaudeRunsPerDay: 3,
  /**
   * Runs per UTC day that may use ANY Claude model, across agents and flows.
   *
   * NOTE the interaction with FREE_TIER_LIMITS: a standard user may start only
   * 5 agent runs and 5 flow runs a day, so this ceiling binds only once an
   * operator has raised that allowance (runAllowanceResetAt grants, higher
   * tiers). It is deliberately set where it starts to matter for those people
   * rather than where it would be redundant.
   */
  claudeRunsPerDay: 20,
} as const

/** Which ceiling a model id falls under. */
export type ModelTier = 'frontier' | 'claude' | 'open'

/**
 * The Claude families priced as frontier. Matched on the id we SEND, which is
 * also what lands in the ledger, so the counter and the router agree by
 * construction rather than by two lists staying in sync.
 */
export const FRONTIER_CLAUDE_PREFIXES = ['claude-opus', 'claude-fable', 'claude-mythos'] as const

export function modelTier(model: string): ModelTier {
  if (!model.startsWith('claude')) return 'open'
  return FRONTIER_CLAUDE_PREFIXES.some((prefix) => model.startsWith(prefix)) ? 'frontier' : 'claude'
}

/** What a run is still permitted to route to today. */
export type ModelAllowance = {
  /** Frontier Claude is still available; false downgrades those runs to Sonnet. */
  frontier: boolean
  /** Any Claude is still available; false leaves Qwen as the only endpoint. */
  claude: boolean
}

export const UNLIMITED_MODEL_ALLOWANCE: ModelAllowance = { frontier: true, claude: true }

/**
 * How a downgrade reads in a run log. Returns null when nothing was downgraded,
 * so the caller can log unconditionally.
 *
 * Named here rather than written at each executor so both planes say the same
 * thing — and say it in plain English. Someone reading their run log needs to
 * know the model changed and why, not to infer it from a different id.
 */
export function downgradeNotice(requested: string, served: string): string | null {
  if (requested === served) return null
  const openTier = modelTier(served) === 'open'
  return openTier
    ? `Daily Claude limit reached (${MODEL_LIMITS.claudeRunsPerDay} runs) — this run is using ${served}. The limit resets at midnight UTC.`
    : `Daily limit for the top Claude models reached (${MODEL_LIMITS.frontierClaudeRunsPerDay} runs) — this run is using ${served} instead of ${requested}. The limit resets at midnight UTC.`
}
