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
 * reads. State is ONE CACHE KEY PER CONDITION (see cache.ts — Redis-backed in
 * production, so the cooldown survives across serverless invocations) —
 * consumer loss and dead letters are independent incident classes (a worker
 * fleet can die with an empty DLQ, or jobs can dead-letter with a perfectly
 * healthy fleet), so they get independent gates:
 *   - condition newly unhealthy, no cooldown key set  -> alert, set the key (TTL below)
 *   - condition still unhealthy, cooldown key set     -> stay quiet for THIS condition
 *   - condition healthy                               -> clear THIS condition's key
 * A single shared key would let one condition's alert suppress the other's
 * for up to an hour — e.g. a consumer-loss alert firing, then dead letters
 * appearing 10 minutes later, going unreported until the shared cooldown
 * lapsed. Per-condition keys mean each incident class alerts on its own
 * edge regardless of the other's cooldown state.
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

/** One cooldown cache key per independent incident class — see file header. */
const COOLDOWN_KEYS = {
  consumerLoss: 'queue-watch:alert-cooldown:consumer-loss',
  deadLetters: 'queue-watch:alert-cooldown:dead-letters',
} as const

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
  /** True iff at least one condition fired a NEW alert this tick (i.e. wasn't
   *  already inside its own cooldown). A tick can be unhealthy without
   *  alerting (both conditions already alerted and still within cooldown). */
  alerted: boolean
  /** Human-readable summary of every CURRENTLY unhealthy condition, joined —
   *  not just the ones that alerted this tick. Undefined when healthy. */
  reason?: string
  check: QueueConsumerCheck
}

/** Pure verdict: is the consumer-loss condition alertable right now, and why. */
export function consumerLossReason(check: QueueConsumerCheck): string | null {
  if (!check.configured || check.ok) return null
  return check.stranded.length > 0
    ? `no consumer for queue(s) with waiting jobs: ${check.stranded.join(', ')}`
    : 'queue consumer check failed'
}

/** Pure verdict: is the dead-letter condition alertable right now, and why. */
export function deadLettersReason(check: QueueConsumerCheck): string | null {
  if (!check.configured || !check.deadLetters || check.deadLetters.total <= 0) return null
  return `${check.deadLetters.total} job(s) in dead-letter queue(s): ${check.deadLetters.queues.join(', ')}`
}

/**
 * Pure verdict over an already-computed probe result: is EITHER condition
 * alertable, and why (both, when both are). Exists for the combined summary
 * string and for callers that only care whether anything is wrong at all —
 * the cooldown state machine in runQueueWatch evaluates each condition
 * independently rather than using this.
 */
export function queueWatchReason(check: QueueConsumerCheck): string | null {
  const reasons = [consumerLossReason(check), deadLettersReason(check)].filter((r): r is string => Boolean(r))
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
 * Evaluate one condition against its own cooldown key: clear on recovery,
 * alert-and-set on a fresh trip, stay quiet while still within cooldown.
 * Returns whether THIS condition fired a new alert this tick.
 */
async function watchCondition(
  reason: string | null,
  cooldownKey: string,
  check: QueueConsumerCheck,
  deps: QueueWatchDeps,
): Promise<boolean> {
  if (!reason) {
    // Recovery (or was never unhealthy): clear so the NEXT incident of THIS
    // condition, whenever it starts, alerts immediately rather than
    // inheriting a stale cooldown.
    await deps.cacheDeleteFn(cooldownKey).catch(() => undefined)
    return false
  }

  const alreadyAlerted = await deps.cacheGetFn(cooldownKey).catch(() => null)
  if (alreadyAlerted) return false

  // Set the cooldown BEFORE delivering: a slow/failing notify must not leave
  // the window open for a concurrent or immediately-following tick to also
  // fire — one incident, one alert, even under retry.
  await deps.cacheSetFn(cooldownKey, true, QUEUE_WATCH_COOLDOWN_MS).catch(() => undefined)
  await deliverAlert(reason, check, deps)
  return true
}

/**
 * One watch tick: probe, decide per condition, and (edge-triggered,
 * cooldown-gated, independently per condition) alert. Called from
 * /api/cron/queue-watch; every dependency is injectable so the decision
 * logic (and the cooldown state machine) is unit-testable without a database
 * or Redis.
 */
export async function runQueueWatch(overrides: Partial<QueueWatchDeps> = {}): Promise<QueueWatchResult> {
  const deps: QueueWatchDeps = { ...defaultDeps, ...overrides }
  const check = await deps.probe()

  const consumerReason = consumerLossReason(check)
  const dlqReason = deadLettersReason(check)

  const consumerAlerted = await watchCondition(consumerReason, COOLDOWN_KEYS.consumerLoss, check, deps)
  const dlqAlerted = await watchCondition(dlqReason, COOLDOWN_KEYS.deadLetters, check, deps)

  const reasons = [consumerReason, dlqReason].filter((r): r is string => Boolean(r))
  return {
    unhealthy: reasons.length > 0,
    alerted: consumerAlerted || dlqAlerted,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    check,
  }
}
