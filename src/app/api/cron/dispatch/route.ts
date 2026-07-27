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
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { dispatchFlowExecution, dispatchDetachedFlowExecution } from '@/features/flows/execute-flow'
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

const MAX_AGENTS_PER_TICK = 25
const MAX_FLOWS_PER_TICK = 10
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

    // Load all active agents (capped at 200 to avoid huge fetches)
    // systemPrisma: global scheduling scan — reads active agents across all orgs by design (CRON_SECRET-gated).
    const agents = await systemPrisma.agentTask.findMany({
      where: { status: 'ACTIVE' },
      take: 200,
    })

    const now = new Date()

    // Filter to agents whose schedule is currently due
    const dueAgents = agents
      .filter((agent) => {
        const schedule = agent.schedule as unknown as AgentSchedule | null
        if (!schedule || typeof schedule !== 'object') return false
        if (!isDue(schedule, agent.lastExecutedAt, now)) return false
        // In worker mode, only 'once' agents are dispatched here; recurring ones
        // are owned by the BullMQ JobScheduler.
        if (workerOwnsRecurring && schedule.type !== 'once') return false
        return true
      })
      .slice(0, MAX_AGENTS_PER_TICK)

    const dueCount = dueAgents.length
    const ranIds: string[] = []

    for (const agent of dueAgents) {
      // I2 — advance lastExecutedAt BEFORE running so that even a persistently
      // failing (or throwing) agent does not re-fire on every tick. The whole
      // per-agent body is wrapped so one agent can never abort the tick.
      try {
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

        // Attribute the run to the agent's owner when set; otherwise the org's
        // oldest active member (shared agents have no single owner).
        const owner = agent.userId
          ? await prisma.user.findFirst({
              where: { id: agent.userId, organizationId: agent.organizationId, isActive: true },
            })
          : null
        const user =
          owner ||
          (await prisma.user.findFirst({
            where: { organizationId: agent.organizationId, isActive: true },
            orderBy: { createdAt: 'asc' },
          }))

        if (!user) {
          apiLogger.error('cron/dispatch: no active user found, skipping agent', {
            agentId: agent.id,
            organizationId: agent.organizationId,
          })
          continue
        }

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
          await runAgentExecution({
            executionId: execution.id,
            agentId: agent.id,
            organizationId: agent.organizationId,
            userId: user.id,
            input,
          })
          ranIds.push(agent.id)
        } catch (error) {
          apiLogger.error('cron/dispatch: agent execution failed', {
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
    // systemPrisma: global scheduling scan — reads active flows across all orgs by design (CRON_SECRET-gated).
    const flows = await systemPrisma.flow.findMany({
      where: { status: 'ACTIVE' },
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { startedAt: true, status: true } } },
      take: 100,
    })
    const ranFlowIds: string[] = []
    for (const flow of flows) {
      try {
        const trigger = flow.trigger as { type?: string; schedule?: AgentSchedule; input?: string } | null
        const schedule = trigger?.schedule
        if (!trigger || trigger.type !== 'schedule' || !schedule || typeof schedule !== 'object') continue
        // Only PUBLISHED flows run on a schedule — a draft-only flow does not fire.
        if (flow.publishedGraph == null) continue
        if (!isDue(schedule, flow.runs[0]?.startedAt ?? null, now)) continue
        // Overlap guard: a still-active previous run means skip this tick —
        // a slow flow must never stack concurrent scheduled executions. A
        // `waiting` run older than 24h stops blocking (blocksSchedule): it
        // stays answerable, but an unanswered approval/question must not
        // wedge the schedule forever.
        const lastRun = flow.runs[0]
        if (lastRun && blocksSchedule(lastRun, now)) {
          apiLogger.warn('cron/dispatch: flow run still active, skipping tick', { flowId: flow.id })
          continue
        }
        if (ranFlowIds.length >= MAX_FLOWS_PER_TICK) break
        // Trigger-level filter: a scheduled trigger's "input" is its stored
        // default — gate on that same value before creating a run.
        if (!triggerConditionPasses(trigger, parseFlowInput(trigger.input ?? ''))) continue
        const owner = flow.userId
          ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
          : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
        if (!owner) continue
        // Queue-durable in production (EXECUTION_MODE=queue): a burst of due
        // schedules enqueues instead of executing serially inside this
        // request; inline in dev/CI — behavior there is unchanged.
        await dispatchFlowExecution({
          flowId: flow.id,
          organizationId: flow.organizationId,
          userId: owner.id,
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
      for (const run of dueWaits) {
        try {
          const userId =
            run.userId ??
            (await prisma.user.findFirst({ where: { organizationId: run.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } }))?.id
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
