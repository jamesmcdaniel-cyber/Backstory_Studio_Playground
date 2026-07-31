/**
 * /api/cron/dispatch — Vercel Cron handler
 *
 * Invoked by the Vercel cron entry (see vercel.json). Scheduling is catch-up
 * based, not tick-aligned: for each active agentTask, `isDue` checks whether
 * any scheduled minute has elapsed since the agent's last run (e.g. a cron of
 * "0 9 * * *" still fires even if the dispatch tick lands at 13:00, not 09:00).
 * For every due agent it creates an agentExecution row and runs it inline.
 *
 * Auth (fail closed): CRON_SECRET env var MUST be set. If it is not configured
 * the handler returns 503. When set, requests must carry:
 *   Authorization: Bearer <CRON_SECRET>
 * compared in constant time. There is no header-only bypass in any environment.
 */

import { timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { dispatchFlowExecution, dispatchDetachedFlowExecution } from '@/features/flows/execute-flow'
import { runFlowPoll, lastPolledAt } from '@/features/flows/poll-dispatch'
import { scanAll, stalestFirst } from '@/lib/scheduling/scan'
import { resolveRunOwners } from '@/lib/scheduling/owners'
import { OrgCapacity, orgMaxInFlightRuns } from '@/lib/queue/org-capacity'
import { parseFlowInput } from '@/lib/flows/input'
import { triggerConditionPasses } from '@/lib/flows/trigger-condition'
import { isDue, type AgentSchedule } from '@/lib/scheduling/due'
import { workersEnabled } from '@/lib/queue/config'
import { EXECUTION_MODE } from '@/lib/queue/execution-mode'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'
import { reapStuckFlowRuns } from '@/lib/flows/reap'
import { sweepTemplateGeneration } from '@/lib/templates/generation-queue'
import { blocksSchedule } from '@/lib/flows/schedule-blocking'
import { captureError } from '@/lib/observability/sentry'

export const runtime = 'nodejs'
export const maxDuration = 800
export const dynamic = 'force-dynamic'

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

function capError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, MAX_ERROR_LENGTH)
}

/**
 * Fail-closed auth. CRON_SECRET must be configured; otherwise the handler is
 * unavailable. When set, the request must present a matching bearer token,
 * compared in constant time over equal-length buffers. No header-only bypass.
 *
 * Returns null when authorized, or a Response to short-circuit with.
 */
function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 503 },
    )
  }

  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  const authorized = a.length === b.length && timingSafeEqual(a, b)
  if (!authorized) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized

  try {
    // I5 — reap stuck runs: any execution still "running" past the time limit
    // is marked failed so it doesn't pin resources or block reporting.
    // systemPrisma: global reaper sweep — runs across all orgs by design (CRON_SECRET-gated).
    // Reap 'running' AND the two other non-terminal states a killed process can
    // strand: 'cancelling' (user hit cancel, then the process died — the run is
    // un-cancellable and un-deletable, since neither predicate treats it as
    // cancellable or terminal) and 'pending' (queued but never claimed by a
    // worker). All three carry a `startedAt` (defaults to now()), so the age
    // filter applies uniformly. A stranded cancel resolves to 'cancelled'.
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

    // Single-owner scheduling: when the BullMQ worker is live in queue mode it
    // owns RECURRING dispatch (via its JobScheduler), so this cron must not also
    // dispatch recurring agents — otherwise they fire twice (double side effects
    // + token cost). One-time ("once") agents are never registered with the
    // BullMQ scheduler (repeatFor returns null for them), so this cron is the
    // only path that can fire them — dispatch those even in worker mode.
    const workerOwnsRecurring = workersEnabled && EXECUTION_MODE === 'queue'

    // Scan EVERY active agent, not an arbitrary window of them. Dueness lives in
    // a JSON schedule column (and cron expressions), so it cannot be pushed into
    // SQL — the only way to be sure a due agent is noticed is to look at all of
    // them. The cap that used to sit here was on the SCAN, which meant agents
    // outside a stable, unordered 200-row window were never examined at all.
    // systemPrisma: global scheduling scan — reads active agents across all orgs by design (CRON_SECRET-gated).
    const agentScan = await scanAll((cursorId, take) =>
      systemPrisma.agentTask.findMany({
        where: { status: 'ACTIVE' },
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

    const now = new Date()

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
    // two user lookups per agent inside the loop.
    const agentCapacity = await OrgCapacity.forOrgs([...new Set(dueAgents.map((a) => a.organizationId))])
    const agentOwners = await resolveRunOwners(dueAgents)

    const dueCount = dueAgents.length
    const ranIds: string[] = []

    for (const agent of dueAgents) {
      // I2 — advance lastExecutedAt BEFORE running so that even a persistently
      // failing (or throwing) agent does not re-fire on every tick. The whole
      // per-agent body is wrapped so one agent can never abort the tick.
      try {
        // Capacity gate BEFORE the lastExecutedAt write: a deferred agent must
        // keep its stale marker, or skipping it would look like a run and push
        // it to the back of the queue behind the orgs that actually ran.
        if (!agentCapacity.tryClaim(agent.organizationId)) continue

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

        const ownerUserId = agentOwners.get(agent.id)
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

        // Create the execution row in pending state
        const execution = await prisma.agentExecution.create({
          data: {
            agentType: agent.agentType,
            agentTaskId: agent.id,
            status: 'pending',
            input: { prompt: input },
            trigger: { type: 'schedule' },
            metadata: { title: (metadata.title as string) || agent.description },
            userId: user.id,
            organizationId: agent.organizationId,
          },
        })

        try {
          // Enqueue rather than run here. Inline (dev/CI) still executes in the
          // request; in queue mode this costs one queue.add and the run happens
          // on the worker pool, so a burst of due schedules can no longer starve
          // the tick or blow its 800s ceiling mid-run.
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
          await prisma.agentExecution.update({
            where: { id: execution.id, organizationId: agent.organizationId },
            data: {
              status: 'failed',
              error: capError(error),
              completedAt: new Date(),
            },
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
    // flows are owned by this cron (no BullMQ scheduler for flows), so run them
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
        where: { status: 'ACTIVE', publishedGraph: { not: Prisma.AnyNull } },
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
    type DueFlow = { flow: (typeof flowScan.rows)[number]; trigger: FlowTrigger; isPoll: boolean; lastExecuted: Date | null }
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

      dueFlowsAll.push({ flow, trigger, isPoll, lastExecuted })
    }

    const dueFlows = stalestFirst(dueFlowsAll, (entry) => entry.lastExecuted).slice(0, MAX_FLOWS_PER_TICK)
    if (dueFlowsAll.length > dueFlows.length) {
      apiLogger.warn('cron/dispatch: flow dispatch cap reached — stalest went first, rest deferred', {
        due: dueFlowsAll.length,
        cap: MAX_FLOWS_PER_TICK,
      })
    }

    const flowCapacity = await OrgCapacity.forOrgs([...new Set(dueFlows.map((entry) => entry.flow.organizationId))])
    const flowOwners = await resolveRunOwners(dueFlows.map((entry) => entry.flow))

    // Pass 2 — dispatch.
    const ranFlowIds: string[] = []
    for (const { flow, trigger, isPoll } of dueFlows) {
      try {
        if (!flowCapacity.tryClaim(flow.organizationId)) continue
        const ownerId = flowOwners.get(flow.id)
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
        })
        ranFlowIds.push(flow.id)
      } catch (error) {
        apiLogger.error('cron/dispatch: flow dispatch failed, skipping', {
          flowId: flow.id,
          organizationId: flow.organizationId,
          error: capError(error),
        })
        continue
      }
    }

    const saturated = [...new Set([...agentCapacity.saturatedOrgs(), ...flowCapacity.saturatedOrgs()])]
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

    return Response.json({ success: true, due: dueCount, ran: ranIds, ranFlows: ranFlowIds, resumedWaits: resumedWaitIds, generatedOrgs })
  } catch (error) {
    apiLogger.error('cron/dispatch: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
