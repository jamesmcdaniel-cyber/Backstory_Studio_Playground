import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getNangoClient, nangoConfigured, NANGO_ORG_TAG } from '@/lib/nango/client'
import { syncOrgNangoConnections } from '@/lib/nango/mirror'
import { MIN_INTEGRATIONS_FOR_TEMPLATES } from '@/lib/integrations/integration-count'
import { maybeGenerateOnGateClear } from '@/lib/templates/generation-queue'
import { apiLogger } from '@/lib/logger'
import { systemPrisma } from '@/lib/prisma'
import { providerSignalOutboxEvent } from '@/lib/outbox'
import { normalizeNangoForward } from '@/lib/activity/normalize'
import { clientIp, recordTokenRejection } from '@/lib/security/events'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'

/**
 * Rate limits, keyed by client IP and split on signature validity.
 *
 * This is the only unauthenticated ingress in the app that does database work,
 * and it is not covered by the central write budget in api-handler (it is a
 * raw route handler). Two gates:
 *
 *  - ADMISSION runs before the HMAC check, so a flood cannot even buy the
 *    signature verification. It is set well above Nango's real burst rate (a
 *    sync can fan out a batch of events) so a legitimate delivery never trips.
 *  - REJECTED runs after a failed verification. A caller that cannot sign is
 *    not a webhook, and gets a much smaller allowance — this is the gate that
 *    stops signature-guessing and unauthenticated log/DB churn.
 *
 * Both fail CLOSED: dropping a webhook costs one reconciliation (the next
 * event or a page-view sync repairs the mirror), while leaving an open,
 * unauthenticated endpoint uncapped during a Redis outage costs more.
 */
const ADMISSION_LIMIT = { limit: 600, windowMs: 60_000, failureMode: 'closed' } as const
const REJECTED_LIMIT = { limit: 30, windowMs: 60_000, failureMode: 'closed' } as const

function tooMany(retryAfterMs?: number) {
  return NextResponse.json(
    { ok: false, error: 'Too many requests' },
    { status: 429, headers: { 'retry-after': String(Math.ceil((retryAfterMs ?? 1_000) / 1_000)) } },
  )
}

/**
 * Nango connection-lifecycle webhook. Nango calls this when an account is
 * connected, refreshed, or errors. It keeps the `nango_connections` mirror the
 * agent runtime reads in sync WITHOUT waiting for a user to reopen the
 * integrations page — so a scheduled/headless run can resolve a freshly
 * connected account immediately.
 *
 * Authenticated by the Nango webhook signature (verifyIncomingWebhookRequest,
 * keyed by NANGO_SECRET_KEY) rather than a session — same "verify then act"
 * shape as the People.ai and flow-trigger webhooks. Configure the endpoint URL
 * in the Nango dashboard (Environment Settings → Webhooks); Nango signs it with
 * the same environment secret key the backend client already uses.
 *
 * Always returns 200 on a verified request (even when we choose not to act), so
 * transient errors on our side don't trigger Nango's retry/backoff — the next
 * event or a page-view sync will reconcile.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const admitted = await rateLimit(`nango-webhook:${ip}`, ADMISSION_LIMIT)
  if (!admitted.ok) return tooMany(admitted.retryAfterMs)

  // No secret key configured → nothing can be verified or mirrored; ack so Nango
  // doesn't retry against a deployment that isn't wired up yet.
  if (!nangoConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'nango-unconfigured' })
  }

  const raw = await request.text()
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  let verified = false
  try {
    verified = getNangoClient().verifyIncomingWebhookRequest(raw, headers)
  } catch (error) {
    apiLogger.error('nango webhook verification threw', {
      error: error instanceof Error ? error.message : String(error),
    })
    verified = false
  }
  if (!verified) {
    const allowed = await rateLimit(`nango-webhook-rejected:${ip}`, REJECTED_LIMIT)
    if (!allowed.ok) return tooMany(allowed.retryAfterMs)
    await recordTokenRejection(request, { surface: 'nango-webhook', reason: 'invalid_hmac' })
    return NextResponse.json({ ok: false, error: 'Invalid webhook signature' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Verified but unparseable — ack and move on.
    return NextResponse.json({ ok: true, skipped: 'unparseable' })
  }

  // Provider events (sync = new/updated records from a Nango sync; forward = a
  // provider webhook Nango forwards) become a flow signal `provider.<app>`, so a
  // flow with a signal trigger listening for that name runs with the event as
  // its input — "when a new record appears in <app>" as a push trigger. The org
  // isn't on these payloads, so it's resolved from the connection mirror row.
  //
  // Every delivery is ALSO persisted as an ActivityEvent — the durable,
  // queryable substrate this signal is derived from (see
  // docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md).
  // That row's unique key is `[organizationId, source, sourceEventId]`, so a
  // redelivered event (Nango retries on anything but a 200) hits P2002 and is
  // acked without a second row — no dedupe table needed on our side.
  if (body.type === 'sync' || body.type === 'forward') {
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : undefined
    const providerConfigKey = typeof body.providerConfigKey === 'string' ? body.providerConfigKey : undefined
    if (connectionId && providerConfigKey) {
      try {
        // systemPrisma: org-less webhook — resolve the owning org from the mirror.
        let conn = await systemPrisma.nangoConnection.findFirst({
          where: { connectionId },
          select: { organizationId: true, userId: true },
        })
        if (!conn) {
          // Mirror-less doesn't have to mean org-unresolvable: the connect
          // session that created this connection tagged it with the owning
          // org (session-token route, NANGO_ORG_TAG), and Nango still has
          // that tag even when our mirror row is missing (missed/raced auth
          // webhook, or a connection older than the mirror itself). One
          // bounded, best-effort lookup recovers it without waiting on a
          // full org-wide `syncOrgNangoConnections` (which needs the org id
          // as an INPUT, so it can't be the first step here, and would add a
          // second, unbounded-fanout network call to this hot path).
          try {
            const remote = await getNangoClient().getConnection(providerConfigKey, connectionId)
            const orgId = remote.tags?.[NANGO_ORG_TAG]
            if (typeof orgId === 'string' && orgId) {
              conn = { organizationId: orgId, userId: remote.end_user?.id ?? null }
            }
          } catch {
            // Best-effort only — fall through to the drop-WARN below if this
            // didn't resolve anything either.
          }
        }
        if (!conn) {
          // The ONLY remaining drop: no mirror row AND Nango itself has no
          // org tag for this connection (deleted upstream, never tagged, or
          // the lookup above failed). There is no organization to attribute
          // an ActivityEvent to, and every row in that table is tenant-scoped
          // by a NOT NULL organizationId — so persisting is not an option,
          // only recording that it happened is.
          apiLogger.warn('nango provider event dropped — connection unresolvable to any organization', { connectionId, providerConfigKey })
        } else {
          const receivedAt = new Date()
          const records = body.records ?? body.data ?? body.payload ?? null
          const normalized = normalizeNangoForward(conn.organizationId, providerConfigKey, records, { receivedAt })
          if (normalized) {
            try {
              await systemPrisma.activityEvent.create({
                data: {
                  organizationId: conn.organizationId,
                  source: normalized.source,
                  sourceEventId: normalized.sourceEventId,
                  kind: normalized.kind,
                  occurredAt: normalized.occurredAt,
                  actorExternalId: normalized.actorExternalId,
                  // A user-owned mirror (or resolved end_user) makes this
                  // event visible only to that person — same ownership split
                  // as the connection it came from; org-owned → null + 'org'.
                  ownerUserId: conn.userId,
                  visibility: conn.userId ? 'private' : 'org',
                  selfOrigin: normalized.selfOrigin,
                  chainDepth: normalized.chainDepth,
                  subject: normalized.subject as Prisma.InputJsonValue,
                  payload: normalized.payload as Prisma.InputJsonValue,
                },
              })
            } catch (error) {
              // P2002 on the [organizationId, source, sourceEventId] unique
              // key = a redelivery of an event we already have — ack it
              // without a second row. Anything else is a real failure.
              if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
            }
          }
          try {
            // Durable handoff: Nango never retries an acked delivery, so an
            // inline emit that failed used to lose the event forever. The
            // outbox loop (worker + cron fallback) delivers with retries.
            await systemPrisma.outboxEvent.create({
              data: providerSignalOutboxEvent({
                organizationId: conn.organizationId,
                connectionId,
                providerConfigKey,
                event: body.type,
                model: typeof body.model === 'string' ? body.model : undefined,
                records,
                // Falls back to a per-delivery random source/id pairing only in
                // the (unreachable in practice) case the normalizer returns
                // null — keeps this outbox row's dedupeKey well-formed instead
                // of throwing on a hot path over a defensive nullable type.
                source: normalized?.source ?? `nango:${providerConfigKey}`,
                sourceEventId: normalized?.sourceEventId ?? connectionId,
              }),
            })
          } catch (error) {
            // dedupeKey now derives from the same [source, sourceEventId] the
            // ActivityEvent row does, so a redelivery hits the outbox's own
            // `[organizationId, dedupeKey]` unique constraint here too — same
            // "already recorded, nothing more to do" case, not a failure.
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
          }
        }
      } catch (error) {
        apiLogger.error('nango provider-event signal failed', {
          connectionId,
          providerConfigKey,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return NextResponse.json({ ok: true })
  }

  // Only auth (connection lifecycle) events touch the mirror.
  if (body.type === 'auth') {
    const endUser = (body.endUser ?? null) as { organizationId?: string } | null
    const tags = (body.tags ?? null) as Record<string, string> | null
    // The connect session sets organization + tags.org_id, so the org is on the
    // payload — no extra Nango round-trip needed to scope the sync.
    const organizationId = endUser?.organizationId || tags?.org_id
    if (organizationId) {
      try {
        // Re-sync the whole org: upserts every current connection and reconciles
        // deletions, so this one handler covers creation, refresh, and removal.
        const connections = await syncOrgNangoConnections(organizationId)
        // On-connect learning trigger (headless path): once the org plausibly
        // meets the integration gate, kick a debounced generation check.
        if (Object.keys(connections).length >= MIN_INTEGRATIONS_FOR_TEMPLATES) {
          void maybeGenerateOnGateClear(organizationId).catch(() => undefined)
        }
        // Learn who each person is in Slack, now that their connection exists.
        // Fire-and-forget: a Slack outage must not fail the mirror sync, and
        // the next reconnect retries. Idempotent, so a re-sync costs nothing.
        void import('@/lib/slack/identity')
          .then(({ captureSlackIdentitiesForOrg }) => captureSlackIdentitiesForOrg(organizationId))
          .catch(() => undefined)
      } catch (error) {
        apiLogger.error('nango webhook mirror sync failed', {
          organizationId,
          connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      apiLogger.warn('nango auth webhook without an org tag — skipping mirror sync', {
        connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
      })
    }
  }

  return NextResponse.json({ ok: true })
}
