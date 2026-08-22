/**
 * Alerting seam over the queue plane's consumer probe.
 *
 * /api/health already computes the signal (probeQueueConsumers,
 * consumer-probe.ts) but only reports it to whoever happens to fetch the
 * endpoint — an uptime monitor, or a human watching a runbook. This module is
 * the other half: a periodic check (driven by the /api/cron/queue-watch
 * route) that turns "consumer lost" or "dead letters piling up" into a
 * notification landing on the platform owner, without anyone needing to be
 * looking at the time it happens.
 *
 * Edge-triggered with a cooldown, not level-triggered: the underlying
 * condition can persist for hours (a stuck worker fleet nobody has fixed yet)
 * and re-alerting every tick (every cron interval) would be noise nobody
 * reads. State is one cache key (see cache.ts — Redis-backed in production,
 * so the cooldown survives across serverless invocations):
 *   - unhealthy + no cooldown key set  -> alert, then set the key (TTL below)
 *   - unhealthy + cooldown key set     -> stay quiet, already alerted
 *   - healthy                          -> clear the key
 * Clearing on recovery (rather than just letting the TTL lapse) means a
 * flap — recovers, then breaks again — alerts again immediately instead of
 * waiting out the rest of an hour-long window for a NEW incident.
 */
import { probeQueueConsumers, type QueueConsumerCheck } from './consumer-probe'
import { cacheGet, cacheSet, cacheDelete } from '@/lib/cache'
import { systemPrisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { notify } from '@/lib/notifications/service'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { PLATFORM_OWNER_EMAILS } from '@/lib/authz/platform-owner'

/** How long a fired alert suppresses a re-fire for the SAME ongoing incident. */
export const QUEUE_WATCH_COOLDOWN_MS = Number(process.env.QUEUE_WATCH_COOLDOWN_MS) || 60 * 60 * 1000

const COOLDOWN_KEY = 'queue-watch:alert-cooldown'

export type QueueWatchDeps = {
  probe: () => Promise<QueueConsumerCheck>
  cacheGetFn: (key: string) => Promise<boolean | null>
  cacheSetFn: (key: string, value: boolean, ttlMs: number) => Promise<void>
  cacheDeleteFn: (key: string) => Promise<void>
  /** Platform owner rows to notify — one per PLATFORM_OWNER_EMAILS address that
   *  has actually signed in (a fresh clone may have neither yet). */
  findOwners: () => Promise<Array<{ id: string; organizationId: string | null }>>
  notifyFn: typeof notify
  recordAuditFn: typeof recordAudit
}

const defaultDeps: QueueWatchDeps = {
  probe: probeQueueConsumers,
  cacheGetFn: (key) => cacheGet<boolean>(key),
  cacheSetFn: (key, value, ttlMs) => cacheSet(key, value, ttlMs),
  cacheDeleteFn: (key) => cacheDelete(key),
  findOwners: async () =>
    systemPrisma.user.findMany({
      where: { email: { in: [...PLATFORM_OWNER_EMAILS], mode: 'insensitive' } },
      select: { id: true, organizationId: true },
    }),
  notifyFn: notify,
  recordAuditFn: recordAudit,
}

export type QueueWatchResult = {
  unhealthy: boolean
  alerted: boolean
  /** Human-readable summary of what tripped the check. Undefined when healthy. */
  reason?: string
  check: QueueConsumerCheck
}

/**
 * Pure verdict over an already-computed probe result: is this an alertable
 * condition, and why. Unconfigured (inline mode / build phase) is never
 * alertable — the queue plane isn't in play.
 */
export function queueWatchReason(check: QueueConsumerCheck): string | null {
  if (!check.configured) return null
  const reasons: string[] = []
  if (!check.ok) {
    reasons.push(
      check.stranded.length > 0
        ? `no consumer for queue(s) with waiting jobs: ${check.stranded.join(', ')}`
        : 'queue consumer check failed',
    )
  }
  if (check.deadLetters && check.deadLetters.total > 0) {
    reasons.push(`${check.deadLetters.total} job(s) in dead-letter queue(s): ${check.deadLetters.queues.join(', ')}`)
  }
  return reasons.length > 0 ? reasons.join('; ') : null
}

async function deliverAlert(reason: string, check: QueueConsumerCheck, deps: QueueWatchDeps): Promise<void> {
  // Never let a failed audit/notify attempt take the whole check down — the
  // cron route still needs to report the unhealthy condition either way.
  apiLogger.error('queue watch: alertable condition detected', { reason, stranded: check.stranded, deadLetters: check.deadLetters })
  captureError(new Error(`queue watch alert: ${reason}`), { scope: 'queue-watch' })

  let owners: Array<{ id: string; organizationId: string | null }> = []
  try {
    owners = await deps.findOwners()
  } catch {
    owners = []
  }
  const targets = owners.filter(
    (owner): owner is { id: string; organizationId: string } => typeof owner.organizationId === 'string',
  )
  await Promise.all(
    targets.map(async (owner) => {
        await deps
          .notifyFn({
            organizationId: owner.organizationId,
            userId: owner.id,
            type: 'platform.queue.alert',
            level: 'error',
            title: 'Queue plane needs attention',
            body: reason,
            link: '/admin',
          })
          .catch(() => undefined)
        await deps
          .recordAuditFn({
            organizationId: owner.organizationId,
            action: 'platform.queue.alert',
            actorUserId: owner.id,
            actorKind: 'system',
            resourceType: 'queue',
            detail: { reason, stranded: check.stranded, deadLetters: check.deadLetters, heartbeat: check.heartbeat },
          })
          .catch(() => undefined)
    }),
  )
}

/**
 * One watch tick: probe, decide, and (edge-triggered, cooldown-gated) alert.
 * Called from /api/cron/queue-watch; every dependency is injectable so the
 * decision logic (and the cooldown state machine) is unit-testable without a
 * database or Redis.
 */
export async function runQueueWatch(overrides: Partial<QueueWatchDeps> = {}): Promise<QueueWatchResult> {
  const deps: QueueWatchDeps = { ...defaultDeps, ...overrides }
  const check = await deps.probe()
  const reason = queueWatchReason(check)

  if (!reason) {
    // Recovery (or was never unhealthy): clear so the NEXT incident, whenever
    // it starts, alerts immediately rather than inheriting a stale cooldown.
    await deps.cacheDeleteFn(COOLDOWN_KEY).catch(() => undefined)
    return { unhealthy: false, alerted: false, check }
  }

  const alreadyAlerted = await deps.cacheGetFn(COOLDOWN_KEY).catch(() => null)
  if (alreadyAlerted) {
    return { unhealthy: true, alerted: false, reason, check }
  }

  // Set the cooldown BEFORE delivering: a slow/failing notify must not leave
  // the window open for a concurrent or immediately-following tick to also
  // fire — one incident, one alert, even under retry.
  await deps.cacheSetFn(COOLDOWN_KEY, true, QUEUE_WATCH_COOLDOWN_MS).catch(() => undefined)
  await deliverAlert(reason, check, deps)
  return { unhealthy: true, alerted: true, reason, check }
}
