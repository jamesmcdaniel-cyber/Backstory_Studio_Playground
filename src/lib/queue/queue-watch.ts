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
 * consumer loss, dead letters, and stranded activity-dispatch claims (see
 * below) are independent incident classes (a worker fleet can die with an
 * empty DLQ, jobs can dead-letter with a perfectly healthy fleet, and a
 * stranded claim can happen with both of the other two healthy), so they
 * each get an independent gate:
 *   - condition newly unhealthy, no cooldown key set  -> alert, set the key (TTL below)
 *   - condition still unhealthy, cooldown key set     -> stay quiet for THIS condition
 *   - condition healthy                               -> clear THIS condition's key
 * A single shared key would let one condition's alert suppress another's for
 * up to an hour — e.g. a consumer-loss alert firing, then dead letters
 * appearing 10 minutes later, going unreported until the shared cooldown
 * lapsed. Per-condition keys mean each incident class alerts on its own
 * edge regardless of the others' cooldown state.
 * Clearing on recovery (rather than just letting the TTL lapse) means a
 * flap — recovers, then breaks again — alerts again immediately instead of
 * waiting out the rest of an hour-long window for a NEW incident.
 *
 * The third condition — stranded `ActivityTriggerClaim` rows — is not a
 * queue-plane signal at all (it reads Postgres, not Redis/BullMQ), but it
 * lives here rather than in a fourth cron route because it needs exactly the
 * same edge-triggered/cooldown machinery this file already has, and because
 * it's the PROACTIVE half of the same story src/lib/activity/dispatch.ts's
 * `STALE_CLAIM_MS` doc comment tells: that module's own WARN only fires if
 * something happens to redeliver the same event again; this sweep finds a
 * stranded claim on its own cron cadence even if nothing ever does.
 */
import { probeQueueConsumers, type QueueConsumerCheck } from './consumer-probe'
import { STALE_CLAIM_MS } from '@/lib/activity/dispatch'
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
  strandedActivityClaims: 'queue-watch:alert-cooldown:stranded-activity-claims',
} as const

/**
 * How many `ActivityTriggerClaim` rows are still `'claimed'` past
 * `STALE_CLAIM_MS` right now — dispatchActivityEvent's exactly-once claim
 * create happens strictly before the run it guards, so a claim this old with
 * no dispatched/failed row to show for it means a crash left it stranded
 * between the two. systemPrisma: a platform-wide count across every org's
 * claims, cron/owner-alert-only — no tenant to scope it by.
 */
export async function countStaleActivityTriggerClaims(now: Date = new Date()): Promise<number> {
  return systemPrisma.activityTriggerClaim.count({
    where: { status: 'claimed', createdAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
  })
}

export type QueueWatchDeps = {
  probe: () => Promise<QueueConsumerCheck>
  countStrandedActivityClaims: () => Promise<number>
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
  countStrandedActivityClaims: () => countStaleActivityTriggerClaims(),
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
 * Pure verdict: is the stranded-activity-claim condition alertable right now,
 * and why. `staleMinutes` is folded into the message so an on-call reader
 * doesn't have to go look up STALE_CLAIM_MS to know what "stale" means here.
 */
export function strandedActivityClaimsReason(count: number): string | null {
  if (count <= 0) return null
  const staleMinutes = Math.round(STALE_CLAIM_MS / 60_000)
  return `${count} activity-dispatch claim(s) stuck in 'claimed' for over ${staleMinutes}m — a dispatch likely crashed before starting the run`
}

/**
 * Pure verdict over an already-computed probe result: is EITHER queue-plane
 * condition alertable, and why (both, when both are). Exists for the
 * combined summary string and for callers that only care whether anything is
 * wrong at all — the cooldown state machine in runQueueWatch evaluates each
 * condition independently rather than using this. Deliberately excludes the
 * stranded-claims condition: that one has no `QueueConsumerCheck` to read a
 * verdict from (see strandedActivityClaimsReason instead) — this function's
 * signature is queue-probe-shaped, not "every condition this file knows
 * about."
 */
export function queueWatchReason(check: QueueConsumerCheck): string | null {
  const reasons = [consumerLossReason(check), deadLettersReason(check)].filter((r): r is string => Boolean(r))
  return reasons.length > 0 ? reasons.join('; ') : null
}

async function deliverAlert(reason: string, detail: Record<string, unknown>, deps: QueueWatchDeps): Promise<void> {
  // Never let a failed audit/notify attempt take the whole check down — the
  // cron route still needs to report the unhealthy condition either way.
  apiLogger.error('queue watch: alertable condition detected', { reason, ...detail })
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
          detail: { reason, ...detail },
        })
        .catch(() => undefined)
    }),
  )
}

/**
 * Evaluate one condition against its own cooldown key: clear on recovery,
 * alert-and-set on a fresh trip, stay quiet while still within cooldown.
 * Returns whether THIS condition fired a new alert this tick. `detail` is
 * whatever this condition wants logged/audited alongside the reason — the
 * queue-probe conditions pass the probe's own fields, the stranded-claims
 * condition passes its count.
 */
async function watchCondition(
  reason: string | null,
  cooldownKey: string,
  detail: Record<string, unknown>,
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
  await deliverAlert(reason, detail, deps)
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
  const strandedClaimCount = await deps.countStrandedActivityClaims().catch(() => 0)

  const consumerReason = consumerLossReason(check)
  const dlqReason = deadLettersReason(check)
  const strandedClaimsReason = strandedActivityClaimsReason(strandedClaimCount)

  const queueDetail = { stranded: check.stranded, deadLetters: check.deadLetters, heartbeat: check.heartbeat }
  const consumerAlerted = await watchCondition(consumerReason, COOLDOWN_KEYS.consumerLoss, queueDetail, deps)
  const dlqAlerted = await watchCondition(dlqReason, COOLDOWN_KEYS.deadLetters, queueDetail, deps)
  const strandedClaimsAlerted = await watchCondition(
    strandedClaimsReason,
    COOLDOWN_KEYS.strandedActivityClaims,
    { strandedActivityClaims: strandedClaimCount },
    deps,
  )

  const reasons = [consumerReason, dlqReason, strandedClaimsReason].filter((r): r is string => Boolean(r))
  return {
    unhealthy: reasons.length > 0,
    alerted: consumerAlerted || dlqAlerted || strandedClaimsAlerted,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    check,
  }
}
