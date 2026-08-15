/**
 * Anomaly detection over credential use.
 *
 * Nobody notices a leaked credential from the credential itself — it keeps
 * working, which is the whole problem. What changes is the PATTERN of use, and
 * the `credential.used` / `credential.use_failed` events now record enough to
 * see that change.
 *
 * ── What is deliberately NOT detected here ─────────────────────────────────
 *
 * "A credential contacted a new host" is the canonical example, and it is
 * already impossible in this system: HttpCredential is pinned to `allowedHost`
 * and refuses any other destination, and MCP/Nango credentials are bound to one
 * provider. Re-implementing that check as detection would report a class of
 * event that cannot occur and quietly imply the others are covered too.
 *
 * So the signals here are the ones that remain possible:
 *
 *   NEW ACTOR      a credential suddenly used by someone who never used it
 *   NEW CONSUMER   used by a flow or surface it has never been used from
 *   VOLUME SPIKE   used far more in the recent window than its own baseline
 *   FAILURE BURST  repeatedly rejected — revoked upstream, or being probed
 *
 * ── Why periodic rather than inline ────────────────────────────────────────
 *
 * Detecting at use time means a baseline query on every credential read — a
 * database round trip inside every flow step, to catch something that is not
 * urgent to the millisecond. This runs on the dispatch tick instead, which is
 * the right latency for "someone should look at this today".
 */

import { systemPrisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { apiLogger } from '@/lib/logger'
import { CREDENTIAL_USED, CREDENTIAL_USE_FAILED } from '@/lib/credentials/audit'

/** How far back "recent" reaches. */
export const RECENT_WINDOW_MS = 60 * 60 * 1000
/** The baseline the recent window is judged against. */
export const BASELINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/**
 * A credential must have been used at least this many times in the baseline
 * before a spike means anything. Without a floor, the second-ever use of a
 * credential is a 100% increase and every new integration alerts on its first
 * busy hour — which is how a detector gets muted.
 */
const MIN_BASELINE_USES = 20

/** Recent volume must exceed the baseline hourly rate by this factor. */
const SPIKE_FACTOR = 8

/** Consecutive failures before a burst is called. */
const FAILURE_BURST_THRESHOLD = 10

export type AnomalyKind = 'new_actor' | 'new_consumer' | 'volume_spike' | 'failure_burst'

export interface CredentialAnomaly {
  kind: AnomalyKind
  organizationId: string
  credentialKind: string
  credentialId: string
  /** One line for whoever reads the alert. */
  summary: string
  detail: Record<string, unknown>
}

interface UseRow {
  resourceType: string | null
  resourceId: string | null
  actorUserId: string | null
  detail: unknown
  createdAt: Date
}

function consumerOf(row: UseRow): string | null {
  const detail = row.detail && typeof row.detail === 'object' ? (row.detail as Record<string, unknown>) : {}
  return typeof detail.consumer === 'string' ? detail.consumer : null
}

function key(row: UseRow): string {
  return `${row.resourceType ?? 'unknown'}:${row.resourceId ?? 'unknown'}`
}

/**
 * Compare the recent window against the baseline and return what changed.
 *
 * Pure apart from the two reads, and exported separately from the alerting so
 * the thresholds can be exercised without a database.
 */
export async function detectCredentialAnomalies(params: {
  organizationId: string
  now?: Date
}): Promise<CredentialAnomaly[]> {
  const now = params.now ?? new Date()
  const recentSince = new Date(now.getTime() - RECENT_WINDOW_MS)
  const baselineSince = new Date(now.getTime() - BASELINE_WINDOW_MS)

  // systemPrisma: the sweep runs per-org from the cron tick, which has no user
  // session to establish tenant context; the organizationId filter is explicit.
  const rows = (await systemPrisma.auditEvent.findMany({
    where: {
      organizationId: params.organizationId,
      action: { in: [CREDENTIAL_USED, CREDENTIAL_USE_FAILED] },
      createdAt: { gte: baselineSince },
    },
    select: { action: true, resourceType: true, resourceId: true, actorUserId: true, detail: true, createdAt: true },
    // Bounded: a pathological workspace must not pull an unbounded result set
    // into memory on a cron tick.
    take: 20_000,
    orderBy: { createdAt: 'desc' },
  })) as Array<UseRow & { action: string }>

  const byCredential = new Map<string, Array<UseRow & { action: string }>>()
  for (const row of rows) {
    const id = key(row)
    const bucket = byCredential.get(id)
    if (bucket) bucket.push(row)
    else byCredential.set(id, [row])
  }

  const anomalies: CredentialAnomaly[] = []

  for (const [id, events] of byCredential) {
    const [credentialKind, credentialId] = id.split(':')
    const uses = events.filter((row) => row.action === CREDENTIAL_USED)
    const recent = uses.filter((row) => row.createdAt >= recentSince)
    const baseline = uses.filter((row) => row.createdAt < recentSince)

    // ── New actor ─────────────────────────────────────────────────────────
    const baselineActors = new Set(baseline.map((row) => row.actorUserId).filter(Boolean))
    const recentActors = new Set(recent.map((row) => row.actorUserId).filter(Boolean))
    const newActors = [...recentActors].filter((actor) => !baselineActors.has(actor))
    // Only meaningful once there IS a baseline: on a credential with no history
    // every actor is new, which says nothing.
    if (newActors.length && baselineActors.size > 0) {
      anomalies.push({
        kind: 'new_actor',
        organizationId: params.organizationId,
        credentialKind,
        credentialId,
        summary: `${credentialKind} ${credentialId} was used by ${newActors.length} person(s) who had never used it before.`,
        detail: { newActors, knownActors: baselineActors.size },
      })
    }

    // ── New consumer ──────────────────────────────────────────────────────
    const baselineConsumers = new Set(baseline.map(consumerOf).filter(Boolean))
    const recentConsumers = new Set(recent.map(consumerOf).filter(Boolean))
    const newConsumers = [...recentConsumers].filter((consumer) => !baselineConsumers.has(consumer))
    if (newConsumers.length && baselineConsumers.size > 0) {
      anomalies.push({
        kind: 'new_consumer',
        organizationId: params.organizationId,
        credentialKind,
        credentialId,
        summary: `${credentialKind} ${credentialId} was used from a surface it had never been used from: ${newConsumers.join(', ')}.`,
        detail: { newConsumers, knownConsumers: [...baselineConsumers] },
      })
    }

    // ── Volume spike ──────────────────────────────────────────────────────
    if (baseline.length >= MIN_BASELINE_USES) {
      const baselineHours = Math.max(1, (BASELINE_WINDOW_MS - RECENT_WINDOW_MS) / (60 * 60 * 1000))
      const baselineRate = baseline.length / baselineHours
      if (baselineRate > 0 && recent.length > baselineRate * SPIKE_FACTOR) {
        anomalies.push({
          kind: 'volume_spike',
          organizationId: params.organizationId,
          credentialKind,
          credentialId,
          summary:
            `${credentialKind} ${credentialId} was used ${recent.length} times in the last hour, ` +
            `against a usual ${baselineRate.toFixed(1)}/hour.`,
          detail: { recentUses: recent.length, baselineHourlyRate: Number(baselineRate.toFixed(2)) },
        })
      }
    }

    // ── Failure burst ─────────────────────────────────────────────────────
    const recentFailures = events.filter(
      (row) => row.action === CREDENTIAL_USE_FAILED && row.createdAt >= recentSince,
    )
    if (recentFailures.length >= FAILURE_BURST_THRESHOLD) {
      anomalies.push({
        kind: 'failure_burst',
        organizationId: params.organizationId,
        credentialKind,
        credentialId,
        summary:
          `${credentialKind} ${credentialId} failed ${recentFailures.length} times in the last hour — ` +
          'it may have been revoked upstream, or the encryption key may have changed.',
        detail: { failures: recentFailures.length },
      })
    }
  }

  return anomalies
}

/**
 * Record every anomaly to the audit log.
 *
 * Audit rather than a security event: these are not rejections, and filing them
 * as `auth.failed`-style events would pollute the thresholds that page someone
 * for an actual attack. A credential behaving unusually is something to review,
 * and reviewing happens in the audit log.
 */
export async function reportCredentialAnomalies(anomalies: CredentialAnomaly[]): Promise<void> {
  for (const anomaly of anomalies) {
    await recordAudit({
      organizationId: anomaly.organizationId,
      action: `credential.anomaly.${anomaly.kind}`,
      actorKind: 'system',
      resourceType: anomaly.credentialKind,
      resourceId: anomaly.credentialId,
      detail: { summary: anomaly.summary, ...anomaly.detail },
    })
  }
}

/**
 * One sweep across every workspace with recent credential activity.
 *
 * Scoped to orgs that actually used a credential in the window, so the cost
 * tracks real activity rather than the size of the customer list. Never throws
 * into the tick: a detector that can break the scheduler is worse than one that
 * misses a window.
 */
export async function sweepCredentialAnomalies(now: Date = new Date()): Promise<{
  organizations: number
  anomalies: number
}> {
  try {
    const since = new Date(now.getTime() - RECENT_WINDOW_MS)
    // systemPrisma: cross-org sweep from the CRON_SECRET-gated tick.
    const active = await systemPrisma.auditEvent.findMany({
      where: { action: { in: [CREDENTIAL_USED, CREDENTIAL_USE_FAILED] }, createdAt: { gte: since } },
      select: { organizationId: true },
      distinct: ['organizationId'],
      take: 500,
    })

    let total = 0
    for (const { organizationId } of active) {
      const anomalies = await detectCredentialAnomalies({ organizationId, now })
      await reportCredentialAnomalies(anomalies)
      total += anomalies.length
    }

    return { organizations: active.length, anomalies: total }
  } catch (error) {
    apiLogger.error('credential anomaly sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { organizations: 0, anomalies: 0 }
  }
}
