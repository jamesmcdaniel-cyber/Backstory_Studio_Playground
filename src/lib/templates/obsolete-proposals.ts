import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

/**
 * Retire improvement proposals whose complaint has stopped happening.
 *
 * `process_improvement` proposals are raised by flow reflection when a flow
 * keeps failing the same way. Until now the lifecycle had no closing half: the
 * only exits were a human clicking accept or dismiss, so FIXING the underlying
 * problem could not clear the flag. The board filled with complaints about
 * bugs that no longer existed, and the surface lost its meaning — the whole
 * point of a recommendation is that it is still true.
 *
 * The evidence used is the only honest one available: has the thing it is about
 * been running cleanly SINCE it was raised? A proposal is retired when its
 * target has completed `MIN_CLEAN_RUNS` times with zero failures after the
 * proposal's createdAt. A target that has not run again keeps its proposal —
 * silence is not proof of a fix.
 */

/** Clean runs required before a complaint is considered resolved. */
export const MIN_CLEAN_RUNS = 3

/** Bound the per-tick scan; far above any real volume of open proposals. */
const MAX_SCAN = 200

/** Terminal status set to 'obsolete' — distinct from 'dismissed', which a human chose. */
export const OBSOLETE = 'obsolete'

export type RunTally = { completed: number; failed: number }

/**
 * Has the complaint stopped reproducing?
 *
 * Pure, so the judgement is testable without a database. Deliberately
 * conservative in both directions: one lucky success does not retire a real
 * recurring problem, and a single failure since the proposal was raised keeps
 * it open no matter how many successes surround it.
 */
export function isResolved(tally: RunTally, minCleanRuns = MIN_CLEAN_RUNS): boolean {
  if (tally.failed > 0) return false
  return tally.completed >= minCleanRuns
}

/** Read targetType/targetId off a proposal's configuration blob. */
export function proposalTarget(configuration: unknown): { type: 'flow' | 'agent'; id: string } | null {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return null
  const { targetType, targetId } = configuration as { targetType?: unknown; targetId?: unknown }
  if (targetType !== 'flow' && targetType !== 'agent') return null
  if (typeof targetId !== 'string' || !targetId.trim()) return null
  return { type: targetType, id: targetId.trim() }
}

/**
 * One sweep pass. Returns how many proposals were retired.
 *
 * systemPrisma: a global sweep across every org, like the other reapers on the
 * dispatch tick — there is no single tenant context for it to run in.
 */
export async function sweepObsoleteProposals(): Promise<number> {
  const open = await systemPrisma.templateProposal.findMany({
    where: { status: 'open', kind: 'process_improvement' },
    select: { id: true, organizationId: true, configuration: true, createdAt: true },
    take: MAX_SCAN,
  })
  if (!open.length) return 0

  let retired = 0
  for (const proposal of open) {
    const target = proposalTarget(proposal.configuration)
    if (!target) continue

    const tally = target.type === 'flow'
      ? await tallyFlowRuns(target.id, proposal.organizationId, proposal.createdAt)
      : await tallyAgentRuns(target.id, proposal.organizationId, proposal.createdAt)

    if (!isResolved(tally)) continue

    // Guarded on status so a human accepting or dismissing mid-sweep wins —
    // their decision is a real one and must not be overwritten by a reaper.
    const result = await systemPrisma.templateProposal.updateMany({
      where: { id: proposal.id, organizationId: proposal.organizationId, status: 'open' },
      data: { status: OBSOLETE },
    })
    retired += result.count
  }

  if (retired) apiLogger.info('proposals: retired resolved improvements', { retired })
  return retired
}

async function tallyFlowRuns(flowId: string, organizationId: string, since: Date): Promise<RunTally> {
  const rows = await systemPrisma.flowRun.groupBy({
    by: ['status'],
    where: { flowId, organizationId, startedAt: { gt: since } },
    _count: { _all: true },
  })
  return toTally(rows, 'succeeded')
}

async function tallyAgentRuns(agentTaskId: string, organizationId: string, since: Date): Promise<RunTally> {
  const rows = await systemPrisma.agentExecution.groupBy({
    by: ['status'],
    where: { agentTaskId, organizationId, startedAt: { gt: since } },
    _count: { _all: true },
  })
  return toTally(rows, 'completed')
}

/** Flows call success 'succeeded' and agents call it 'completed'; both fail as 'failed'. */
function toTally(rows: Array<{ status: string; _count: { _all: number } }>, successStatus: string): RunTally {
  let completed = 0
  let failed = 0
  for (const row of rows) {
    if (row.status === successStatus) completed += row._count._all
    if (row.status === 'failed') failed += row._count._all
  }
  return { completed, failed }
}
