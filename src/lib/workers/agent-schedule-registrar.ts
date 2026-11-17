import { createQueue, QUEUE_NAMES } from '@/lib/queue/config'
import { systemPrisma } from '@/lib/prisma'
import { runObjective, runSchedule } from '@/lib/agents/publish'
import { resolveRunOwners, type OwnedCandidate } from '@/lib/scheduling/owners'

type Schedule = {
  type?: string
  time?: string
  cron?: string
  timezone?: string
  isActive?: boolean
}

/** Every scheduler this registrar owns is named `agent:<agentTaskId>`. */
const SCHEDULER_PREFIX = 'agent:'

/**
 * Translate a stored agent schedule into a BullMQ repeat option, or null when
 * the agent should have no scheduler at all.
 *
 * Exported for tests: this is the whole cadence-to-cron translation, and a
 * silent regression here means schedules that quietly stop firing.
 */
export function repeatFor(schedule: Schedule) {
  const timezone = schedule.timezone || 'UTC'
  if (schedule.type === 'cron' && schedule.cron) return { pattern: schedule.cron, tz: timezone }
  if (schedule.type === 'hourly') return { pattern: '0 * * * *', tz: timezone }
  if (schedule.type === 'daily' || schedule.type === 'weekly') {
    const [hour = '9', minute = '0'] = String(schedule.time || '09:00').split(':')
    const day = schedule.type === 'weekly' ? '1' : '*'
    return { pattern: `${Number(minute)} ${Number(hour)} * * ${day}`, tz: timezone }
  }
  return null
}

/** The agent fields reconciliation reads. */
export interface RegistrarAgent extends OwnedCandidate {
  status: string
  quarantinedAt?: Date | null
  description: string
  objective: string
  schedule?: unknown
  publishedConfig?: unknown
  organization?: { kind: string } | null
}

/**
 * Injectable seams — production uses the real clients; tests stub the DB and
 * queue edges so reconciliation is assertable without Redis or Postgres (same
 * pattern as dead-letter.ts's DeadLetterDeps).
 */
export interface ScheduleRegistrarDeps {
  agents: {
    findMany: () => Promise<RegistrarAgent[]>
    /** Which of these ids still have a row — the orphan sweep's re-check. */
    existingIds: (ids: string[]) => Promise<string[]>
  }
  /** The scheduler's attribution rule; see src/lib/scheduling/owners.ts. */
  owners: (candidates: OwnedCandidate[]) => Promise<Map<string, string>>
  /** A thunk, so the Redis connection is still opened lazily (after the read). */
  queue: () => {
    removeJobScheduler: (id: string) => Promise<unknown>
    upsertJobScheduler: (id: string, repeat: unknown, job: unknown) => Promise<unknown>
    /** Optional so a stub without it still reconciles; orphans are then left. */
    getJobSchedulers?: () => Promise<Array<{ key: string; id?: string | null }>>
    close: () => Promise<unknown>
  }
}

function defaultDeps(): ScheduleRegistrarDeps {
  return {
    // systemPrisma: worker scheduler reconciles ACTIVE agents across all orgs by design.
    agents: {
      findMany: () =>
        systemPrisma.agentTask.findMany({
          select: {
            id: true,
            organizationId: true,
            userId: true,
            status: true,
            quarantinedAt: true,
            description: true,
            objective: true,
            schedule: true,
            publishedConfig: true,
            organization: { select: { kind: true } },
          },
        }),
      existingIds: async (ids) =>
        (await systemPrisma.agentTask.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((row) => row.id),
    },
    owners: resolveRunOwners,
    queue: () => {
      const queue = createQueue(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION)
      return {
        removeJobScheduler: (id) => queue.removeJobScheduler(id),
        upsertJobScheduler: (id, repeat, job) =>
          queue.upsertJobScheduler(id, repeat as Parameters<typeof queue.upsertJobScheduler>[1], job as Parameters<typeof queue.upsertJobScheduler>[2]),
        getJobSchedulers: () => queue.getJobSchedulers(0, -1, true),
        close: () => queue.close(),
      }
    },
  }
}

/**
 * The repeat option an agent should be armed with right now, or null.
 *
 * - The PUBLISHED schedule for a published agent (runSchedule): reading the
 *   live row let a draft cadence edit re-arm a published agent unreviewed.
 * - Quarantined work (owner deprovisioned) waits to be claimed.
 * - A demo sandbox never arms: it is a clone of a real workspace, and arming
 *   its copy re-ran the source org's whole scheduled fleet, with real model
 *   spend, once per sandbox. The clone disarms on copy too (demo/snapshot.ts);
 *   this is the backstop for one created before that, or re-armed inside one.
 */
export function armedRepeat(agent: RegistrarAgent) {
  if (agent.status !== 'ACTIVE' || agent.quarantinedAt) return null
  if (agent.organization?.kind === 'demo') return null
  const schedule = (runSchedule(agent) ?? {}) as Schedule
  return schedule.isActive ? repeatFor(schedule) : null
}

export async function registerAgentSchedules(deps: ScheduleRegistrarDeps = defaultDeps()) {
  const agents = await deps.agents.findMany()
  const queue = deps.queue()
  let registered = 0
  let failed = 0

  try {
    const armed: Array<{ agent: RegistrarAgent; repeat: NonNullable<ReturnType<typeof repeatFor>> }> = []
    for (const agent of agents) {
      const repeat = armedRepeat(agent)
      if (repeat) {
        armed.push({ agent, repeat })
        continue
      }
      try {
        await queue.removeJobScheduler(`${SCHEDULER_PREFIX}${agent.id}`)
      } catch {
        failed += 1
      }
    }

    // One batched attribution for the pass, by the same rule as the dispatch
    // tick. The per-agent lookup this replaces filtered the owner on isActive
    // in SQL, so a SUSPENDED owner looked the same as a missing one and the
    // agent fell back to the org's oldest member — running a removed person's
    // automation under a colleague's identity.
    let owners: Map<string, string> | null = null
    try {
      owners = await deps.owners(armed.map(({ agent }) => agent))
    } catch {
      // Leave every existing scheduler as it is rather than tear the fleet
      // down over a read failure; the next pass (60s) reconciles.
      failed += armed.length
    }

    for (const { agent, repeat } of owners ? armed : []) {
      const schedulerId = `${SCHEDULER_PREFIX}${agent.id}`
      try {
        const userId = owners!.get(agent.id)
        if (!userId) {
          // Deprovisioned named owner, or no active member at all: nothing may
          // run it, so nothing may stay armed for it either.
          await queue.removeJobScheduler(schedulerId)
          continue
        }
        await queue.upsertJobScheduler(schedulerId, repeat, {
          name: 'execute-scheduled-agent',
          data: {
            agentId: agent.id,
            organizationId: agent.organizationId,
            userId,
            // The published objective: the runtime seeds the run with this, so
            // the draft's would override what was published.
            input: runObjective(agent),
          },
        })
        registered += 1
      } catch {
        // An invalid cron expression on one agent must not break reconciliation
        // for the rest of the fleet.
        failed += 1
      }
    }

    // A HARD-deleted agent (org teardown, cascade) has no row left for the
    // loop above to visit, so its scheduler fired forever into a runtime that
    // refused it. Remove any `agent:` scheduler with no row behind it.
    if (queue.getJobSchedulers) {
      try {
        const known = new Set(agents.map((agent) => agent.id))
        const unknown = (await queue.getJobSchedulers())
          .map((scheduler) => scheduler.key || scheduler.id || '')
          .filter((id) => id.startsWith(SCHEDULER_PREFIX) && !known.has(id.slice(SCHEDULER_PREFIX.length)))
        // Re-checked against the table, not just this pass's snapshot: every
        // worker machine runs this registrar, and an agent created after OUR
        // read may already have been armed by another — removing it would cost
        // its first run.
        const stillThere = unknown.length
          ? new Set(await deps.agents.existingIds(unknown.map((id) => id.slice(SCHEDULER_PREFIX.length))))
          : new Set<string>()
        for (const id of unknown) {
          if (stillThere.has(id.slice(SCHEDULER_PREFIX.length))) continue
          await queue.removeJobScheduler(id).catch(() => undefined)
        }
      } catch {
        // Best effort: orphans cost a refused job each, never a wrong run.
      }
    }
  } finally {
    await queue.close()
  }

  return { registered, failed }
}
