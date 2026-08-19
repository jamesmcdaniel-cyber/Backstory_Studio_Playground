/**
 * Daily ceilings on WHICH model a standard user's runs may reach for.
 *
 * The caps in free-tier-limits.ts bound how many runs a person starts. These
 * bound how expensive those runs are allowed to be, which is a different lever:
 * a workspace can be well inside its run count and still be spending Opus money
 * on work Qwen would have done.
 *
 * ── Redirect, never refuse ─────────────────────────────────────────────────
 *
 * Exhausting one of these caps does not fail a run. It removes the Claude steps
 * from the routing chain, so the run proceeds on Qwen. That is the whole design
 * intent — the ceiling exists to move load onto the cheaper endpoint, not to
 * stop people working, and a cap that stops work gets raised until it means
 * nothing. It follows that the caps only apply when Qwen is actually configured
 * (see routeModel): with nowhere to redirect to, a missing env var would
 * otherwise silently halt every run in the workspace.
 *
 * ── Two tiers ──────────────────────────────────────────────────────────────
 *
 * Frontier Claude (Opus, Fable, Mythos) is several times the price of the rest
 * of the family, so it gets the tighter cap and degrades to Sonnet — still
 * Claude, still capable, a fraction of the cost. The wider cap covers the whole
 * family, and past it the workspace is on Qwen for the rest of the UTC day.
 *
 * Exempt: super admins and the usage-exempt identities, exactly as in
 * free-tier-limits.ts — one definition of "standard user", not two.
 *
 * systemPrisma: this runs inside the worker, outside any request's org context,
 * and reads the ledger rows for whichever org the run belongs to. Same posture
 * as usage/ledger.ts.
 */
import { systemPrisma } from '@/lib/prisma'
import { isSuperAdminPlatformRole } from '@/lib/authz/platform-roles'
import { isUnlimitedActor, runWindowStart } from './free-tier-limits'

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
const FRONTIER_CLAUDE_PREFIXES = ['claude-opus', 'claude-fable', 'claude-mythos'] as const

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
 * Distinct RUNS this person has already had served by Claude today.
 *
 * Counted from the ledger rather than from a counter of our own, because the
 * ledger records what an endpoint actually served — including the runs that
 * started on Qwen and fell back to Claude mid-run, which a decision made at
 * admission time would miss entirely.
 *
 * Rows with neither run id are the interactive surfaces (copilots, headlines,
 * the assistant). They are excluded: these ceilings are about runs, and folding
 * a copilot question into the same budget would let someone exhaust their agents
 * by asking questions.
 *
 * Bounded by `take`, so the query cost does not grow with a busy day — the only
 * fact needed is whether the count has reached the cap.
 */
async function countClaudeRuns(userId: string, since: Date, tier: 'frontier' | 'claude', cap: number): Promise<number> {
  const groups = await systemPrisma.llmCall.groupBy({
    by: ['agentExecutionId', 'flowRunId'],
    where: {
      userId,
      provider: 'anthropic',
      createdAt: { gte: since },
      // Excludes rows where BOTH ids are null, i.e. the non-run surfaces.
      NOT: { agentExecutionId: null, flowRunId: null },
      ...(tier === 'frontier'
        ? { OR: FRONTIER_CLAUDE_PREFIXES.map((prefix) => ({ model: { startsWith: prefix } })) }
        : {}),
    },
    // Prisma requires an ordering alongside `take`. Which rows come back does
    // not matter — the only question is whether there are more than `cap` of
    // them — so this orders on the grouping key itself.
    orderBy: { agentExecutionId: 'asc' },
    take: cap + 1,
  })
  return groups.length
}

/**
 * What this person's next run may route to.
 *
 * Reads the actor's own exemption rather than taking it from a caller: this is
 * invoked from the worker, which has no auth context to ask, and an exemption
 * that had to be threaded through every job payload would be forgotten by the
 * first job type that forgot it.
 *
 * Best-effort in the safe direction — if the lookup fails, the run keeps its
 * full allowance. A telemetry hiccup must not silently move a workspace onto a
 * different model.
 */
export async function modelAllowanceFor(userId: string | null | undefined): Promise<ModelAllowance> {
  if (!userId) return UNLIMITED_MODEL_ALLOWANCE
  try {
    const user = await systemPrisma.user.findUnique({
      where: { id: userId },
      select: { email: true, platformRole: true, runAllowanceResetAt: true },
    })
    if (!user) return UNLIMITED_MODEL_ALLOWANCE
    if (isUnlimitedActor({ canReview: isSuperAdminPlatformRole(user.platformRole), email: user.email })) {
      return UNLIMITED_MODEL_ALLOWANCE
    }

    // The same window the run-count caps use, so an operator's allowance reset
    // clears both ceilings at once instead of leaving a person with runs they
    // may start but only Qwen to start them on.
    const since = runWindowStart(user.runAllowanceResetAt)
    const [frontierUsed, claudeUsed] = await Promise.all([
      countClaudeRuns(userId, since, 'frontier', MODEL_LIMITS.frontierClaudeRunsPerDay),
      countClaudeRuns(userId, since, 'claude', MODEL_LIMITS.claudeRunsPerDay),
    ])
    return {
      frontier: frontierUsed < MODEL_LIMITS.frontierClaudeRunsPerDay,
      claude: claudeUsed < MODEL_LIMITS.claudeRunsPerDay,
    }
  } catch {
    return UNLIMITED_MODEL_ALLOWANCE
  }
}

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
