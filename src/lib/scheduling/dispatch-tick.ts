/**
 * The scheduling tick: reapers, agent dispatch, flow dispatch, wait resumes,
 * and the periodic sweeps.
 *
 * This used to be the body of `GET /api/cron/dispatch`, driven solely by the
 * Vercel cron entry in vercel.json (`*​/15 * * * *`). Two consequences made that
 * untenable:
 *
 *  - The `every15min` cadence the picker offers (src/lib/scheduling/cadence.ts)
 *    could never be honored: a `*​/15` flow dispatched from a `*​/15` tick fires
 *    with up to 15 minutes of drift and degrades to ~30 whenever a tick is late.
 *  - If that single cron was paused, deleted, or plan-limited, every scheduled
 *    flow stopped and nothing said so.
 *
 * So the body lives here and has TWO callers: the cron route (unchanged auth,
 * now a thin delegate) and the BullMQ worker's 60s timer. Both go through
 * `withTickLock`, so running them together is safe, and either surviving alone
 * keeps schedules firing. Scheduling is catch-up based, not tick-aligned: for
 * each active row, `isDue` checks whether any scheduled minute has elapsed since
 * the last run, so a cron of "0 9 * * *" still fires even if the tick that
 * notices lands at 13:00.
 */

import { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { sweepCredentialAnomalies } from '@/lib/credentials/anomaly'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { dispatchFlowExecution, dispatchDetachedFlowExecution } from '@/features/flows/execute-flow'
import { runFlowPoll, lastPolledAt } from '@/features/flows/poll-dispatch'
import { scanAll, stalestFirst } from '@/lib/scheduling/scan'
import { computeNextRunAt } from '@/lib/scheduling/next-run'
import { resolveRunOwners, type OwnedCandidate } from '@/lib/scheduling/owners'
import { OrgCapacity, orgMaxInFlightRuns } from '@/lib/queue/org-capacity'
import { parseFlowInput } from '@/lib/flows/input'
import { triggerConditionPasses } from '@/lib/flows/trigger-condition'
import { isDue, dueOccurrence, type AgentSchedule } from '@/lib/scheduling/due'
import { workersEnabled } from '@/lib/queue/config'
import { EXECUTION_MODE } from '@/lib/queue/execution-mode'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'
import { reapStuckFlowRuns, reapNeverPickedUpRuns } from '@/lib/flows/reap'
import { sweepTemplateGeneration } from '@/lib/templates/generation-queue'
import { blocksSchedule } from '@/lib/flows/schedule-blocking'
import { captureError } from '@/lib/observability/sentry'
import { processOutboxBatch } from '@/lib/outbox'
import { reapStuckApprovals } from '@/lib/approvals/reap'
import { sweepMcpConnectionHealth } from '@/lib/mcp/health-sweep'
import { sweepFlowReflection } from '@/lib/flows/reflection-sweep'
import { sweepObsoleteProposals } from '@/lib/templates/obsolete-proposals'
import { withTickLock } from '@/lib/queue/tick-lock'
import { writeTickLiveness } from '@/lib/queue/tick-liveness'

/** A flow's stored trigger: schedule/poll cadence plus its default input. */
type FlowTrigger = { type?: string; schedule?: AgentSchedule; input?: string }

// Per-tick agent-dispatch cap. This bounds how many runs START per tick — NOT
// how many agents are examined (see scanAll). Env-overridable for the same
// reason the flow cap is: it is a throughput dial, not an invariant.
const MAX_AGENTS_PER_TICK = Math.max(1, Number(process.env.AGENT_DISPATCH_PER_TICK) || 25)
// Per-tick flow-dispatch cap. Configurable because 10/tick is a silent scale
// cliff once an org has more due schedules than that (they'd starve, oldest
// first, with no signal). Raised default + env override + a saturation warning
// (below) so hitting the cap is visible instead of silent truncation.
const MAX_FLOWS_PER_TICK = Math.max(1, Number(process.env.FLOW_DISPATCH_PER_TICK) || 50)
const STUCK_RUN_TIMEOUT_MS = AGENT_RUN_TIMEOUT_MS
const MAX_ERROR_LENGTH = 300

/**
 * Persist recomputed `nextRunAt` values for rows the tick examined and did not
 * dispatch.
 *
 * Grouped by instant so a tick costs a handful of `updateMany`s rather than one
 * UPDATE per row — the population being stamped is dominated by manual and
 * inactive rows, which all collapse to the same NOT_SCHEDULED_AT value, and by
 * daily schedules that share a wall-clock time. Without the grouping this would
 * trade a large read for an equally large pile of writes.
 *
 * Best-effort by design. Stamping is an OPTIMISATION: if it fails, the affected
 * rows keep whatever value they had (NULL for new ones), and the next tick reads
 * and evaluates them exactly as the pre-index scheduler did. A failure here must
 * never abort a tick that has real work to dispatch.
 */
async function stampNextRunAt<T extends { id: string }>(
  label: string,
  rows: T[],
  nextFor: (row: T) => Date,
  write: (ids: string[], at: Date) => Promise<unknown>,
): Promise<void> {
  if (rows.length === 0) return
  const byInstant = new Map<number, string[]>()
  for (const row of rows) {
    const at = nextFor(row).getTime()
    const bucket = byInstant.get(at)
    if (bucket) bucket.push(row.id)
    else byInstant.set(at, [row.id])
  }
  try {
    await Promise.all(
      [...byInstant.entries()].map(([at, ids]) => write(ids, new Date(at))),
    )
  } catch (error) {
    apiLogger.warn(`cron/dispatch: ${label} nextRunAt stamping failed — next tick falls back to a full scan`, {
      rows: rows.length,
      error: capError(error),
    })
  }
}

export function capError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, MAX_ERROR_LENGTH)
}

export type DispatchTickSummary =
  | {
      success: true
      due: number
      ran: string[]
      ranFlows: string[]
      resumedWaits: string[]
      generatedOrgs: string[]
      reflectedFlows: string[]
      outbox: { delivered: number; retried: number; failed: number }
      reapedApprovals: number
      mcpHealth: { checked: number; unhealthy: number; changed: number }
      /** Improvement proposals retired because their target now runs clean. */
      retiredProposals: number
      /** Credential-use anomalies raised this tick, per workspace swept. */
      credentialAnomalies: { organizations: number; anomalies: number }
    }
  | { skipped: 'locked' }

/**
 * Injection seam for tests only. Production passes nothing and gets the real
 * implementations.
 */
export type DispatchTickDeps = {
  forOrgs?: typeof OrgCapacity.forOrgs
  resolveRunOwners?: typeof resolveRunOwners
}

/**
 * Capacity + owner resolution for one dispatch phase.
 *
 * These two reads sat outside every try/catch, so a Prisma pool exhaustion in
 * the AGENT phase's prep took down flow dispatch, wait resumes, and the
 * template sweep for the whole tick. Returning null degrades exactly one phase;
 * every deferred row keeps its stale last-run marker and sorts first next tick.
 */
export async function preparePhase<T extends OwnedCandidate>(
  phase: 'agent' | 'flow',
  rows: T[],
  deps: DispatchTickDeps = {},
): Promise<{ capacity: OrgCapacity; owners: Map<string, string> } | null> {
  const forOrgs = deps.forOrgs ?? OrgCapacity.forOrgs
  const resolve = deps.resolveRunOwners ?? resolveRunOwners
  try {
    const capacity = await forOrgs([...new Set(rows.map((row) => row.organizationId))])
    const owners = await resolve(rows)
    return { capacity, owners }
  } catch (error) {
    apiLogger.error(`cron/dispatch: ${phase} phase prep failed — phase skipped this tick`, {
      error: capError(error),
    })
    captureError(error, { source: `cron.dispatch.${phase}Prep` })
    return null
  }
}

/**
 * Undo a consumed occurrence when the HANDOFF failed — the run never began, so
 * the schedule owes it still.
 *
 * Distinct from a run that RAN and failed: that one keeps the advanced marker so
 * a persistently broken agent does not re-fire every tick. Before this, a
 * `dispatchAgentExecution` throw (worker down, queue unreachable) consumed the
 * occurrence anyway and it was never retried.
 *
 * Best effort; a failure here costs one skipped occurrence, not the tick.
 */
export async function restoreAgentOccurrence(params: {
  agentId: string
  organizationId: string
  executionId: string | null
  previousLastExecutedAt: Date | null
  previousExecutionCount: number
}): Promise<void> {
  try {
    await prisma.agentTask.update({
      where: { id: params.agentId, organizationId: params.organizationId },
      data: {
        lastExecutedAt: params.previousLastExecutedAt,
        executionCount: params.previousExecutionCount,
      },
    })
    if (params.executionId) {
      await prisma.agentExecution.delete({
        where: { id: params.executionId, organizationId: params.organizationId },
      })
    }
  } catch (error) {
    apiLogger.error('cron/dispatch: could not restore a lost agent occurrence', {
      agentId: params.agentId,
      error: capError(error),
    })
  }
}

/**
 * One scheduling tick. Safe to call concurrently from both planes: the lock
 * makes the second caller a no-op rather than a duplicate dispatch.
 */
export async function runDispatchTick(
  now: Date = new Date(),
  deps: DispatchTickDeps = {},
): Promise<DispatchTickSummary> {
  const result = await withTickLock(async (): Promise<DispatchTickSummary> => {
    // Fallback delivery path for deployments whose worker has been restarted or
    // temporarily unavailable. Claims are compare-and-set, so this can race a
    // healthy worker without double-processing a row.
    const outbox = await processOutboxBatch().catch((error) => {
      apiLogger.error('cron/dispatch: outbox processing failed', { error: capError(error) })
      return { delivered: 0, retried: 0, failed: 0 }
    })
    // I5 — reap stuck runs: any execution still "running" past the time limit
    // is marked failed so it doesn't pin resources or block reporting.
    // systemPrisma: global reaper sweep — runs across all orgs by design (CRON_SECRET-gated).
    // Reap 'running' AND the two other non-terminal states a killed process can
    // strand: 'cancelling' (user hit cancel, then the process died — the run is
    // un-cancellable and un-deletable, since neither predicate treats it as
    // cancellable or terminal) and 'pending' (queued but never claimed by a
    // worker). All three carry a `startedAt` (defaults to now()), so the age
    // filter applies uniformly. A stranded cancel resolves to 'cancelled'.
    // Credential-use anomalies. A leaked credential keeps working — that is the
    // whole problem — so what changes is the PATTERN of use, not the credential.
    // Runs here rather than inline at credential-read time: detecting inline
    // means a baseline query inside every flow step, to catch something that is
    // not urgent to the millisecond.
    const anomalies = await sweepCredentialAnomalies().catch((error) => {
      apiLogger.error('cron/dispatch: credential anomaly sweep failed', { error: capError(error) })
      return { organizations: 0, anomalies: 0 }
    })

    const stranded = new Date(Date.now() - STUCK_RUN_TIMEOUT_MS)
    await systemPrisma.agentExecution.updateMany({
      where: { status: { in: ['running', 'pending'] }, startedAt: { lt: stranded } },
      data: { status: 'failed', error: 'Run exceeded time limit', completedAt: new Date() },
    })
    await systemPrisma.agentExecution.updateMany({
      where: { status: 'cancelling', startedAt: { lt: stranded } },
      data: { status: 'cancelled', error: 'Cancelled (run did not stop in time)', completedAt: new Date() },
    })

    // Same recovery for flows: a crashed inline flow execution leaves its run
    // `running` forever, which also wedges that flow's schedule via the
    // overlap guard. Isolated so a reaper failure never aborts the tick.
    try {
      await reapStuckFlowRuns()
    } catch (error) {
      apiLogger.error('cron/dispatch: flow reaper failed', { error: capError(error) })
      captureError(error, { source: 'cron.dispatch.flowReaper' })
    }
    // Fast path: a `running` run with zero steps was never picked up by the
    // execution backend — fail it after ~5 minutes instead of letting it show
    // "Thinking…" until the 30-minute reaper above catches it.
    try {
      const neverPickedUp = await reapNeverPickedUpRuns()
      if (neverPickedUp > 0) {
        apiLogger.error('cron/dispatch: reaped runs never picked up by the execution backend', { count: neverPickedUp })
      }
    } catch (error) {
      apiLogger.error('cron/dispatch: never-picked-up reaper failed', { error: capError(error) })
      captureError(error, { source: 'cron.dispatch.neverPickedUpReaper' })
    }
    let reapedApprovals = 0
    try {
      reapedApprovals = await reapStuckApprovals(now)
    } catch (error) {
      apiLogger.error('cron/dispatch: approval reaper failed', { error: capError(error) })
      captureError(error, { source: 'cron.dispatch.approvalReaper' })
    }
    const mcpHealth = await sweepMcpConnectionHealth(now).catch((error) => {
      apiLogger.error('cron/dispatch: MCP health sweep failed', { error: capError(error) })
      return { checked: 0, unhealthy: 0, changed: 0 }
    })

    // The closing half of the proposal lifecycle: reflection raises an
    // improvement when a flow keeps failing, and this retires it once the flow
    // has been running clean since. Without it, fixing the bug could not clear
    // the flag and the board filled with complaints that were no longer true.
    const retiredProposals = await sweepObsoleteProposals().catch((error) => {
      apiLogger.error('cron/dispatch: obsolete proposal sweep failed', { error: capError(error) })
      return 0
    })

    // Single-owner scheduling: when the BullMQ worker is live in queue mode it
    // owns RECURRING dispatch (via its JobScheduler), so this tick must not also
    // dispatch recurring agents — otherwise they fire twice (double side effects
    // + token cost). One-time ("once") agents are never registered with the
    // BullMQ scheduler (repeatFor returns null for them), so this tick is the
    // only path that can fire them — dispatch those even in worker mode.
    const workerOwnsRecurring = workersEnabled && EXECUTION_MODE === 'queue'

    // Read only the agents that could be due, using the (status, nextRunAt)
    // index, instead of every active agent on every tick.
    //
    // This is a PRE-FILTER and nothing more — isDue below is still the
    // authority, and still runs on every row read. `nextRunAt IS NULL` means
    // "not computed yet, or just edited", and is always included, so the failure
    // mode of a write path that does not maintain the column is a wasted read
    // rather than a schedule that stops firing. On the first tick after the
    // migration every row is NULL, so it behaves exactly like the old full scan
    // and stamps as it goes; from the second tick on it is a range read.
    //
    // The complete cursor scan is retained underneath, so the ordering guarantee
    // that fixed the original starvation bug (no row excluded from being
    // EXAMINED) still holds over the candidate set.
    // systemPrisma: global scheduling scan — reads active agents across all orgs by design (CRON_SECRET-gated).
    const agentScan = await scanAll((cursorId, take) =>
      systemPrisma.agentTask.findMany({
        // quarantinedAt: work whose owner was deprovisioned. systemPrisma
        // bypasses the credential owner guard, so the exclusion is explicit here.
        where: {
          status: 'ACTIVE',
          quarantinedAt: null,
          OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
        },
        orderBy: { id: 'asc' },
        take,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
    )
    if (agentScan.truncated) {
      apiLogger.error('cron/dispatch: agent scan hit the runaway backstop — some agents were not examined', {
        scanned: agentScan.rows.length,
      })
    }

    // Filter to agents whose schedule is currently due
    const dueAgentsAll = agentScan.rows.filter((agent) => {
      const schedule = agent.schedule as unknown as AgentSchedule | null
      if (!schedule || typeof schedule !== 'object') return false
      if (!isDue(schedule, agent.lastExecutedAt, now)) return false
      // In worker mode, only 'once' agents are dispatched here; recurring ones
      // are owned by the BullMQ JobScheduler.
      if (workerOwnsRecurring && schedule.type !== 'once') return false
      return true
    })

    // Stamp every agent this tick EXAMINED with when it should next be looked
    // at. This is what shrinks the next tick's read set, and it is deliberately
    // done for the not-due rows too — those are the ones worth removing from
    // the range, and the only place their whole row is already in hand.
    //
    // Rows being dispatched below are skipped here: dispatching advances
    // lastExecutedAt, which nulls the column again through the write chokepoint,
    // and the following tick recomputes from the post-run state.
    const dueAgentIds = new Set(dueAgentsAll.map((agent) => agent.id))
    await stampNextRunAt(
      'agent',
      agentScan.rows.filter((agent) => !dueAgentIds.has(agent.id)),
      (agent) => {
        const schedule = agent.schedule as unknown as AgentSchedule | null
        // A recurring agent in queue mode is due, but this tick is not what
        // fires it — the BullMQ JobScheduler is. Stamping it from its real
        // lastExecutedAt would compute "due now", pinning every recurring agent
        // into every tick's read set forever and leaving the index with nothing
        // to exclude in exactly the configuration production runs.
        //
        // Anchoring at `now` instead asks the honest question for this tick's
        // purposes: when is the NEXT occurrence after this moment. The row drops
        // out of the range until then, and BullMQ's ownership is unaffected —
        // this column has no bearing on what the scheduler queue does.
        const ownedByQueue = workerOwnsRecurring && schedule?.type !== undefined && schedule.type !== 'once'
        return computeNextRunAt(agent.schedule, ownedByQueue ? now : agent.lastExecutedAt, now)
      },
      (ids, at) => systemPrisma.agentTask.updateMany({ where: { id: { in: ids } }, data: { nextRunAt: at } }),
    )

    // Stalest first, THEN cap. Dispatching advances lastExecutedAt, so anything
    // deferred here sorts ahead of what just ran and goes out next tick — the
    // overflow rotates instead of the same rows winning every time.
    const dueAgents = stalestFirst(dueAgentsAll, (agent) => agent.lastExecutedAt).slice(0, MAX_AGENTS_PER_TICK)
    if (dueAgentsAll.length > dueAgents.length) {
      apiLogger.warn('cron/dispatch: agent dispatch cap reached — stalest went first, rest deferred', {
        due: dueAgentsAll.length,
        cap: MAX_AGENTS_PER_TICK,
      })
    }

    // One capacity read and one owner resolution for the whole tick, instead of
    // two user lookups per agent inside the loop. Isolated: a failure here skips
    // the agent phase, not the tick.
    const agentPrep = await preparePhase('agent', dueAgents, deps)
    const agentCapacity = agentPrep?.capacity ?? null
    const agentOwners = agentPrep?.owners ?? null

    const dueCount = dueAgents.length
    const ranIds: string[] = []

    for (const agent of agentPrep ? dueAgents : []) {
      // I2 — advance lastExecutedAt BEFORE running so that even a persistently
      // failing (or throwing) agent does not re-fire on every tick. The whole
      // per-agent body is wrapped so one agent can never abort the tick.
      try {
        // Capacity gate BEFORE the lastExecutedAt write: a deferred agent must
        // keep its stale marker, or skipping it would look like a run and push
        // it to the back of the queue behind the orgs that actually ran.
        if (!agentCapacity!.tryClaim(agent.organizationId)) continue

        // Captured before the advance so a HANDOFF failure can give the
        // occurrence back (see restoreAgentOccurrence).
        const previousLastExecutedAt = agent.lastExecutedAt
        const previousExecutionCount = agent.executionCount

        await prisma.agentTask.update({
          where: { id: agent.id, organizationId: agent.organizationId },
          data: {
            lastExecutedAt: new Date(),
            executionCount: { increment: 1 },
          },
        })

        const metadata =
          agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata)
            ? (agent.metadata as Record<string, unknown>)
            : {}

        const ownerUserId = agentOwners!.get(agent.id)
        if (!ownerUserId) {
          apiLogger.error('cron/dispatch: no active user found, skipping agent', {
            agentId: agent.id,
            organizationId: agent.organizationId,
          })
          continue
        }
        const user = { id: ownerUserId }

        // Pass the raw objective — runAgentExecution composes skills into the
        // system prompt itself, so composing here too would double-apply them.
        const input = agent.objective

        // Occurrence identity for this run. Reuses the EXISTING
        // @@unique([organizationId, idempotencyKey]) that signal-triggered runs
        // already use (`${signalId}:${agentId}`) — no migration needed.
        const schedule = agent.schedule as unknown as AgentSchedule
        const occurrence = dueOccurrence(schedule, previousLastExecutedAt, now)

        // Create the execution row in pending state
        let execution
        try {
          execution = await prisma.agentExecution.create({
            data: {
              agentType: agent.agentType,
              agentTaskId: agent.id,
              status: 'pending',
              input: { prompt: input },
              trigger: { type: 'schedule' },
              metadata: { title: (metadata.title as string) || agent.description },
              userId: user.id,
              organizationId: agent.organizationId,
              ...(occurrence ? { idempotencyKey: `schedule:${agent.id}:${occurrence.toISOString()}` } : {}),
            },
          })
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            // Another tick already claimed this occurrence. This tick advanced
            // the marker for a run that belongs to the tick that won, so give
            // it back rather than consuming an occurrence we never ran.
            await restoreAgentOccurrence({
              agentId: agent.id,
              organizationId: agent.organizationId,
              executionId: null,
              previousLastExecutedAt,
              previousExecutionCount,
            })
            continue
          }
          throw error
        }

        try {
          // Enqueue rather than run here. Inline (dev/CI) still executes in the
          // request; in queue mode this costs one queue.add and the run happens
          // on the worker pool, so a burst of due schedules can no longer starve
          // the tick or blow its 1800s ceiling mid-run.
          await dispatchAgentExecution({
            executionId: execution.id,
            agentId: agent.id,
            organizationId: agent.organizationId,
            userId: user.id,
            input,
          })
          ranIds.push(agent.id)
        } catch (error) {
          apiLogger.error('cron/dispatch: agent dispatch failed', {
            agentId: agent.id,
            executionId: execution.id,
            error: capError(error),
          })
          // Handoff failure (no live consumer, queue unreachable): the run never
          // started, so give the occurrence back instead of consuming it
          // silently. A `pending` row that never dispatched is noise, not
          // history — and leaving it would strand the reaper — so it goes too.
          await restoreAgentOccurrence({
            agentId: agent.id,
            organizationId: agent.organizationId,
            executionId: execution.id,
            previousLastExecutedAt,
            previousExecutionCount,
          })
        }
      } catch (error) {
        // Any failure in the per-agent body (user lookup, execution row
        // creation, etc.) is isolated so the tick continues with other agents.
        apiLogger.error('cron/dispatch: agent dispatch failed, skipping', {
          agentId: agent.id,
          organizationId: agent.organizationId,
          error: capError(error),
        })
        continue
      }
    }

    // Scheduled flows: reuse the same due-check. A flow's schedule lives at
    // flow.trigger.schedule (a real AgentSchedule: hourly/daily/weekly/cron/once);
    // its most-recent flow_run.startedAt is the "last run" marker. Recurring
    // flows are owned by this tick (no BullMQ scheduler for flows), so run them
    // even in worker mode.
    // Complete scan, same reasoning as agents above: the old `take: 100` was a
    // cap on what got LOOKED AT, so flows outside it never fired.
    // systemPrisma: global scheduling scan — reads active flows across all orgs by design (CRON_SECRET-gated).
    const flowScan = await scanAll((cursorId, take) =>
      systemPrisma.flow.findMany({
        // Unpublished flows never fire on a schedule, so exclude them in SQL
        // rather than loading them to check. AnyNull covers both a SQL NULL and
        // a stored JSON null, matching the `publishedGraph == null` test this
        // replaces. Doing it here also keeps publishedGraph — the largest column
        // on the table — out of the result set entirely.
        // quarantinedAt: work whose owner was deprovisioned. systemPrisma
        // bypasses the credential owner guard, so the exclusion is explicit here.
        // nextRunAt: the same due-range pre-filter as agents above. It matters
        // more here — examining a flow also costs the correlated `runs` lookup
        // below, so every row this excludes is a subquery avoided, not just a
        // row read.
        where: {
          status: 'ACTIVE',
          publishedGraph: { not: Prisma.AnyNull },
          quarantinedAt: null,
          OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
        },
        // Explicit select, NOT include: this scan now reads every active flow,
        // and pulling whole rows (graph JSON and all) into memory once per tick
        // would trade the starvation bug for a memory one. These are the only
        // fields the two passes below and runFlowPoll actually read.
        select: {
          id: true,
          organizationId: true,
          userId: true,
          trigger: true,
          pollCursor: true,
          nextRunAt: true,
          runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { startedAt: true, status: true } },
        },
        orderBy: { id: 'asc' },
        take,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
    )
    if (flowScan.truncated) {
      apiLogger.error('cron/dispatch: flow scan hit the runaway backstop — some flows were not examined', {
        scanned: flowScan.rows.length,
      })
    }

    // Pass 1 — decide who is due, cheaply and with no side effects, so the cap
    // below is applied to a complete picture rather than to whatever the scan
    // happened to reach first.
    type DueFlow = {
      flow: (typeof flowScan.rows)[number]
      trigger: FlowTrigger
      isPoll: boolean
      lastExecuted: Date | null
      // Null for polls (their cadence is pollCursor.lastPolledAt, not an
      // occurrence grid) — the ledger is their duplicate protection instead.
      occurrence: Date | null
    }
    const dueFlowsAll: DueFlow[] = []
    for (const flow of flowScan.rows) {
      const trigger = flow.trigger as FlowTrigger | null
      const schedule = trigger?.schedule
      const isPoll = trigger?.type === 'poll'
      if (!trigger || (trigger.type !== 'schedule' && !isPoll) || !schedule || typeof schedule !== 'object') continue
      // (Only PUBLISHED flows run on a schedule — enforced by the scan's where.)
      // A poll's cadence is tracked by its own lastPolledAt (a poll that finds
      // nothing new creates no run, so the last-run clock would never advance
      // and it'd poll every tick). Schedules use the last run's start.
      const lastExecuted = isPoll ? lastPolledAt(flow.pollCursor) : (flow.runs[0]?.startedAt ?? null)
      if (!isDue(schedule, lastExecuted, now)) continue

      if (!isPoll) {
        // Overlap guard: a still-active previous run means skip this tick — a
        // slow flow must never stack concurrent scheduled executions. A
        // `waiting` run older than 24h stops blocking (blocksSchedule): it stays
        // answerable, but an unanswered approval/question must not wedge the
        // schedule forever. Evaluated here so a blocked flow does not consume a
        // dispatch slot that another org's flow could have used.
        const lastRun = flow.runs[0]
        if (lastRun && blocksSchedule(lastRun, now)) {
          apiLogger.warn('cron/dispatch: flow run still active, skipping tick', { flowId: flow.id })
          continue
        }
        // Trigger-level filter: a scheduled trigger's "input" is its stored
        // default — gate on that same value before creating a run.
        if (!triggerConditionPasses(trigger, parseFlowInput(trigger.input ?? ''))) continue
      }

      dueFlowsAll.push({
        flow,
        trigger,
        isPoll,
        lastExecuted,
        occurrence: isPoll ? null : dueOccurrence(schedule, lastExecuted, now),
      })
    }

    // Same stamping as agents: narrow the next tick's range by recording when
    // each examined-but-not-due flow could next matter.
    const dueFlowIds = new Set(dueFlowsAll.map((entry) => entry.flow.id))
    await stampNextRunAt(
      'flow',
      flowScan.rows.filter((flow) => !dueFlowIds.has(flow.id)),
      (flow) => {
        const trigger = flow.trigger as FlowTrigger | null
        const isPoll = trigger?.type === 'poll'
        const lastExecuted = isPoll ? lastPolledAt(flow.pollCursor) : (flow.runs[0]?.startedAt ?? null)
        return computeNextRunAt(trigger?.schedule, lastExecuted, now)
      },
      (ids, at) => systemPrisma.flow.updateMany({ where: { id: { in: ids } }, data: { nextRunAt: at } }),
    )

    const dueFlows = stalestFirst(dueFlowsAll, (entry) => entry.lastExecuted).slice(0, MAX_FLOWS_PER_TICK)
    if (dueFlowsAll.length > dueFlows.length) {
      apiLogger.warn('cron/dispatch: flow dispatch cap reached — stalest went first, rest deferred', {
        due: dueFlowsAll.length,
        cap: MAX_FLOWS_PER_TICK,
      })
    }

    // Isolated for the same reason the agent prep is: a failure here skips the
    // flow phase, not the whole tick.
    const flowPrep = await preparePhase(
      'flow',
      dueFlows.map((entry) => entry.flow),
      deps,
    )
    const flowCapacity = flowPrep?.capacity ?? null
    const flowOwners = flowPrep?.owners ?? null

    // Pass 2 — dispatch.
    const ranFlowIds: string[] = []
    for (const { flow, trigger, isPoll, occurrence } of flowPrep ? dueFlows : []) {
      try {
        if (!flowCapacity!.tryClaim(flow.organizationId)) continue
        const ownerId = flowOwners!.get(flow.id)
        if (!ownerId) continue

        if (isPoll) {
          const { dispatched } = await runFlowPoll(flow, ownerId, now)
          if (dispatched > 0) ranFlowIds.push(flow.id)
          continue
        }

        // Queue-durable in production (EXECUTION_MODE=queue): a burst of due
        // schedules enqueues instead of executing serially inside this
        // request; inline in dev/CI — behavior there is unchanged.
        await dispatchFlowExecution({
          flowId: flow.id,
          organizationId: flow.organizationId,
          userId: ownerId,
          input: parseFlowInput(trigger.input ?? ''),
          usePublished: true,
          trigger: { type: 'schedule' },
          scheduledFor: occurrence,
        })
        ranFlowIds.push(flow.id)
      } catch (error) {
        // P2002 means another tick already claimed this occurrence — the
        // constraint doing its job, not a failure. The overlap guard above is
        // only a cheap pre-filter; this is the authority.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue
        apiLogger.error('cron/dispatch: flow dispatch failed, skipping', {
          flowId: flow.id,
          organizationId: flow.organizationId,
          error: capError(error),
        })
        continue
      }
    }

    const saturated = [
      ...new Set([...(agentCapacity?.saturatedOrgs() ?? []), ...(flowCapacity?.saturatedOrgs() ?? [])]),
    ]
    if (saturated.length) {
      apiLogger.warn('cron/dispatch: workspaces at their in-flight run ceiling — deferred to the next tick', {
        limit: orgMaxInFlightRuns(),
        organizations: saturated.length,
      })
    }

    // Wait node: resume runs whose timer is due. resumeAt is set ONLY for timer
    // waits (duration/until) and webhook safety-timeouts — a human/approval pause
    // has resumeAt null and is never woken here. runFlowExecution's atomic
    // waiting→running claim dedups against a concurrent/last-tick pick, so no
    // pre-clear is needed; a resumed run that then crashes is swept by the
    // reaper. Isolated + capped per tick like schedule dispatch.
    const resumedWaitIds: string[] = []
    try {
      // systemPrisma: global due-wait scan across all orgs by design (CRON_SECRET-gated).
      const dueWaits = await systemPrisma.flowRun.findMany({
        where: { status: 'waiting', resumeAt: { not: null, lte: now } },
        orderBy: { resumeAt: 'asc' },
        take: MAX_FLOWS_PER_TICK,
        select: { id: true, flowId: true, organizationId: true, userId: true },
      })
      const waitOwners = await resolveRunOwners(dueWaits)
      for (const run of dueWaits) {
        try {
          const userId = waitOwners.get(run.id)
          if (!userId) continue
          // reply '' is the timer signal — the wait step resumes with { resumed: true }.
          await dispatchDetachedFlowExecution({
            flowId: run.flowId,
            organizationId: run.organizationId,
            userId,
            input: {},
            flowRunId: run.id,
            reply: '',
          })
          resumedWaitIds.push(run.id)
        } catch (error) {
          apiLogger.error('cron/dispatch: wait resume failed, skipping', { flowRunId: run.id, error: capError(error) })
        }
      }
    } catch (error) {
      apiLogger.error('cron/dispatch: due-wait scan failed', { error: capError(error) })
      captureError(error, { source: 'cron.dispatch.dueWaits' })
    }

    // Auto-template generation: a daily, debounced, per-org sweep. Each org that
    // meets the 3-integration gate, has no open proposals, and hasn't generated
    // within GENERATION_DEBOUNCE_MS gets ONE generation dispatch (capped per
    // tick). Isolated so a generation failure never aborts the dispatch tick.
    let generatedOrgs: string[] = []
    try {
      generatedOrgs = await sweepTemplateGeneration(now)
    } catch (error) {
      apiLogger.error('cron/dispatch: template-generation sweep failed', { error: capError(error) })
      captureError(error, { source: 'cron.dispatch.templateGeneration' })
    }

    // Flow reflection: a daily, per-flow-debounced pass that turns a REPEATED
    // failure into one proposal instead of N identical failed runs. Isolated so
    // a reflection failure never aborts the dispatch tick.
    let reflectedFlows: string[] = []
    try {
      reflectedFlows = await sweepFlowReflection(now)
    } catch (error) {
      apiLogger.error('cron/dispatch: flow reflection sweep failed', { error: capError(error) })
      captureError(error, { source: 'cron.dispatch.flowReflection' })
    }

    return {
      success: true,
      due: dueCount,
      ran: ranIds,
      ranFlows: ranFlowIds,
      resumedWaits: resumedWaitIds,
      generatedOrgs,
      reflectedFlows,
      outbox,
      reapedApprovals,
      mcpHealth,
      retiredProposals,
      credentialAnomalies: anomalies,
    }
  })

  // Only a tick that actually RAN counts as liveness — a lock-skipped call
  // proves nothing about whether scheduling is working.
  if (!('skipped' in result)) await writeTickLiveness(result, Date.now())
  return result
}
