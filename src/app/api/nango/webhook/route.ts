import { NextRequest, NextResponse } from 'next/server'
import { getNangoClient, nangoConfigured } from '@/lib/nango/client'
import { syncOrgNangoConnections } from '@/lib/nango/mirror'
import { MIN_INTEGRATIONS_FOR_TEMPLATES } from '@/lib/integrations/integration-count'
import { maybeGenerateOnGateClear } from '@/lib/templates/generation-queue'
import { apiLogger } from '@/lib/logger'
import { systemPrisma } from '@/lib/prisma'
import { providerSignalOutboxEvent } from '@/lib/outbox'
import { rateLimit } from '@/lib/ratelimit'
import { readRequestTextLimited, RequestBodyTooLargeError } from '@/lib/net/request-body'

export const runtime = 'nodejs'
const NANGO_WEBHOOK_MAX_BYTES = 2_000_000

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
  // No secret key configured → nothing can be verified or mirrored; ack so Nango
  // doesn't retry against a deployment that isn't wired up yet.
  if (!nangoConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'nango-unconfigured' })
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const limited = await rateLimit(`nango-webhook:${ip}`, { limit: 120, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) return NextResponse.json({ ok: false, error: 'Rate limit exceeded' }, { status: 429 })

  let raw: string
  try {
    raw = await readRequestTextLimited(request, NANGO_WEBHOOK_MAX_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ ok: false, error: 'Webhook body is too large' }, { status: 413 })
    }
    throw error
  }
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
  if (body.type === 'sync' || body.type === 'forward') {
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : undefined
    const providerConfigKey = typeof body.providerConfigKey === 'string' ? body.providerConfigKey : undefined
    if (connectionId && providerConfigKey) {
      try {
        // systemPrisma: org-less webhook — resolve the owning org from the mirror.
        const conn = await systemPrisma.nangoConnection.findFirst({ where: { connectionId }, select: { organizationId: true } })
        if (!conn) {
          // A provider event for a connection we have no mirror row for is a
          // DROPPED event — without this line it vanished without a trace
          // (webhook acked ok, no signal emitted, no flow ran).
          apiLogger.warn('nango provider event dropped — no mirror row for connection', { connectionId, providerConfigKey })
        }
        if (conn) {
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
              records: body.records ?? body.data ?? body.payload ?? null,
            }),
          })
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
