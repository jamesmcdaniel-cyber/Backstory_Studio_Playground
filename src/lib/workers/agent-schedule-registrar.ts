import { createQueue, QUEUE_NAMES } from '@/lib/queue/config'
import { prisma, systemPrisma } from '@/lib/prisma'

type Schedule = {
  type?: string
  time?: string
  cron?: string
  timezone?: string
  isActive?: boolean
}

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

/**
 * Injectable seams — production uses the real clients; tests stub the DB and
 * queue edges so reconciliation is assertable without Redis or Postgres (same
 * pattern as dead-letter.ts's DeadLetterDeps).
 */
export interface ScheduleRegistrarDeps {
  agents: { findMany: () => Promise<any[]> }
  users: { findFirst: (args: any) => Promise<any> }
  /** A thunk, so the Redis connection is still opened lazily (after the read). */
  queue: () => {
    removeJobScheduler: (id: string) => Promise<unknown>
    upsertJobScheduler: (id: string, repeat: unknown, job: unknown) => Promise<unknown>
    close: () => Promise<unknown>
  }
}

function defaultDeps(): ScheduleRegistrarDeps {
  return {
    // systemPrisma: worker scheduler reconciles ACTIVE agents across all orgs by design.
    agents: { findMany: () => systemPrisma.agentTask.findMany() },
    users: { findFirst: (args) => prisma.user.findFirst(args) },
    queue: () => createQueue(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION) as unknown as ReturnType<ScheduleRegistrarDeps['queue']>,
  }
}

export async function registerAgentSchedules(deps: ScheduleRegistrarDeps = defaultDeps()) {
  const agents = await deps.agents.findMany()
  const queue = deps.queue()
  let registered = 0
  let failed = 0

  try {
    for (const agent of agents) {
      const schedulerId = `agent:${agent.id}`
      const schedule = agent.schedule as Schedule
      const repeat = agent.status === 'ACTIVE' && schedule.isActive ? repeatFor(schedule) : null

      try {
        if (!repeat) {
          await queue.removeJobScheduler(schedulerId)
          continue
        }

        // Scheduled runs execute as the agent's owner when set; otherwise as the
        // org's oldest active member (shared agents have no single owner).
        const owner = agent.userId
          ? await deps.users.findFirst({
              where: { id: agent.userId, organizationId: agent.organizationId, isActive: true },
            })
          : null
        const user =
          owner ||
          (await deps.users.findFirst({
            where: { organizationId: agent.organizationId, isActive: true },
            orderBy: { createdAt: 'asc' },
          }))
        if (!user) continue

        await queue.upsertJobScheduler(schedulerId, repeat, {
          name: 'execute-scheduled-agent',
          data: {
            agentId: agent.id,
            organizationId: agent.organizationId,
            userId: user.id,
            input: agent.objective,
          },
        })
        registered += 1
      } catch {
        // An invalid cron expression on one agent must not break reconciliation
        // for the rest of the fleet.
        failed += 1
      }
    }
  } finally {
    await queue.close()
  }

  return { registered, failed }
}
