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
 * The dead-letter condition needs one thing more than a cooldown. Nothing
 * consumes a DLQ, so its count is CUMULATIVE: a job parked once sits there
 * until an operator drops or replays it, which means "total > 0" is true
 * forever after the first failure and re-alerted on every cooldown lapse —
 * the same "8 job(s) in dead-letter queue(s)" notification every 65 minutes,
 * for weeks, describing nothing new. So the alertable edge for THIS condition
 * is growth, not presence: the last observed total is kept in its own cache
 * key (DEAD_LETTER_BASELINE_KEY) and an alert requires the total to have
 * risen above it. A standing backlog goes quiet after one alert; the next job
 * to dead-letter alerts immediately, even while the old ones are still
 * parked. The condition still reports unhealthy the whole time — that is the
 * LEVEL, which /api/health and this route's response both still carry; only
 * the notification is edge-gated. If the baseline key is ever lost (eviction,
 * a cache flush) the worst case is one re-alert for an existing backlog.
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
import { probeQueueConsumers, queuePressureVerdict, type QueueConsumerCheck } from './consumer-probe'
import { STALE_CLAIM_MS } from '@/lib/activity/dispatch'
import { cacheGet, cacheGetNumber, cacheSet, cacheDelete } from '@/lib/cache'
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
  queuePressure: 'queue-watch:alert-cooldown:queue-pressure',
  strandedActivityClaims: 'queue-watch:alert-cooldown:stranded-activity-claims',
} as const

/**
 * Last observed dead-letter total — the bar a new alert has to clear. Not a
 * cooldown key: it is not about time at all, and it must outlive one (a
 * backlog nobody drains stays quiet for as long as it stays the same size).
 */
export const DEAD_LETTER_BASELINE_KEY = 'queue-watch:dead-letter-baseline'

/** Long enough that a quiet backlog never re-alerts on TTL alone. */
const DEAD_LETTER_BASELINE_TTL_MS = 30 * 24 * 60 * 60 * 1000

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
  /** Last dead-letter total this watch saw, or null when it has none on record. */
  readDeadLetterBaseline: () => Promise<number | null>
  writeDeadLetterBaseline: (total: number) => Promise<void>
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
  readDeadLetterBaseline: () => cacheGetNumber(DEAD_LETTER_BASELINE_KEY),
  writeDeadLetterBaseline: (total) => cacheSet(DEAD_LETTER_BASELINE_KEY, total, DEAD_LETTER_BASELINE_TTL_MS),
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

/** Backlog growth with live consumers: queue depth and oldest-job age catch
 * capacity exhaustion before it becomes consumer loss or dead-lettering. */
export function queuePressureReason(check: QueueConsumerCheck): string | null {
  if (!check.configured || !check.reports) return null
  const pressure = queuePressureVerdict(check.reports)
  return pressure.reason ? `queue backlog pressure — ${pressure.reason}` : null
}

/**
 * Pure verdict: has the dead-letter backlog GROWN since the last tick, and by
 * how much — the alertable edge for a condition whose level never recovers on
 * its own (see the file header). `baseline` is the total this watch last
 * recorded; 0 for a watch that has never seen one, which makes a first
 * observation of any backlog alertable.
 *
 * Says both numbers: how many are new (what happened) and how many are parked
 * in total (what an operator is walking into at /admin/queue).
 */
export function newDeadLettersReason(check: QueueConsumerCheck, baseline: number): string | null {
  if (!check.configured || !check.deadLetters) return null
  const total = check.deadLetters.total
  const added = total - Math.max(0, baseline)
  if (total <= 0 || added <= 0) return null
  return `${added} new job(s) dead-lettered — ${total} now parked in: ${check.deadLetters.queues.join(', ')}`
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
  const reasons = [consumerLossReason(check), queuePressureReason(check), deadLettersReason(check)].filter((r): r is string => Boolean(r))
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
          link: '/admin/queue',
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
  const pressureReason = queuePressureReason(check)
  // Level (does a backlog exist?) and edge (did it grow?) are different
  // questions for this condition — the first is what we REPORT, the second is
  // the only thing worth NOTIFYING about. See the file header.
  const dlqReason = deadLettersReason(check)
  const dlqBaseline = (await deps.readDeadLetterBaseline().catch(() => null)) ?? 0
  const dlqGrowthReason = newDeadLettersReason(check, dlqBaseline)
  const strandedClaimsReason = strandedActivityClaimsReason(strandedClaimCount)

  const queueDetail = { stranded: check.stranded, deadLetters: check.deadLetters, heartbeat: check.heartbeat }
  const consumerAlerted = await watchCondition(consumerReason, COOLDOWN_KEYS.consumerLoss, queueDetail, deps)
  const pressureAlerted = await watchCondition(
    pressureReason,
    COOLDOWN_KEYS.queuePressure,
    { ...queueDetail, reports: check.reports },
    deps,
  )
  const dlqAlerted = await watchCondition(
    dlqGrowthReason,
    COOLDOWN_KEYS.deadLetters,
    { ...queueDetail, deadLetterBaseline: dlqBaseline },
    deps,
  )
  // Record what we saw AFTER deciding, and on every change in either
  // direction: growth so the same jobs never alert twice, and shrinkage
  // (an operator drained the queue at /admin/queue) so the next job to park
  // is once again above the bar.
  const dlqTotal = check.deadLetters?.total
  if (check.configured && typeof dlqTotal === 'number' && dlqTotal !== dlqBaseline) {
    await deps.writeDeadLetterBaseline(dlqTotal).catch(() => undefined)
  }
  const strandedClaimsAlerted = await watchCondition(
    strandedClaimsReason,
    COOLDOWN_KEYS.strandedActivityClaims,
    { strandedActivityClaims: strandedClaimCount },
    deps,
  )

  const reasons = [consumerReason, pressureReason, dlqReason, strandedClaimsReason].filter((r): r is string => Boolean(r))
  return {
    unhealthy: reasons.length > 0,
    alerted: consumerAlerted || pressureAlerted || dlqAlerted || strandedClaimsAlerted,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    check,
  }
}
