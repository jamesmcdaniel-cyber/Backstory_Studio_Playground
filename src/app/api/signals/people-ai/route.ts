import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { rateLimit } from '@/lib/ratelimit'
import { verifySignature } from '@/lib/signals/verify'
import { mapEventToSignal } from '@/lib/signals/map'
import { routeSignal } from '@/lib/signals/router'
import { flowSignalOutboxEvent } from '@/lib/outbox'
import { captureError } from '@/lib/observability/sentry'
import { decryptSecret } from '@/lib/crypto/secrets'
import { recordTokenRejection } from '@/lib/security/events'

export const runtime = 'nodejs'
export const maxDuration = 1800

/**
 * People.ai SalesAI webhook receiver (registered via POST /v1/salesai/webhooks).
 * Public endpoint: HMAC-verified, rate-limited, deduped, and fast — the signal
 * is persisted and 202 returned immediately; routing (which may run agents)
 * happens after the response.
 *
 * Tenant resolution: the payload's team/org id → Organization.peopleAiTeamId.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const limited = await rateLimit(`signals:${ip}`, { limit: 120, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })
  }

  const globalSecret = process.env.PEOPLE_AI_WEBHOOK_SECRET || null
  const rawBody = await request.text()
  // SEAM: header name per SalesAI webhook registration docs; both common
  // conventions accepted.
  const header =
    request.headers.get('x-peopleai-signature') ||
    request.headers.get('x-pai-signature') ||
    request.headers.get('x-signature')

  // Parse BEFORE verifying only to discover which org's secret governs this
  // delivery — the payload stays untrusted until the HMAC check passes.
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON payload' }, { status: 400 })
  }

  const record = payload as Record<string, unknown>
  const teamId = [record.team_id, record.org_id, (record.data as Record<string, unknown> | undefined)?.team_id]
    .map((value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : null))
    .find(Boolean)
  const organization = teamId
    ? await prisma.organization.findUnique({
        where: { peopleAiTeamId: teamId },
        select: { id: true, peopleAiWebhookSecret: true },
      })
    : null

  // Per-org secret binds authenticity to tenancy: a signature is only valid
  // if produced with the TARGET org's own secret. Orgs that haven't minted
  // one yet fall back to the global secret. An org WITH a secret never
  // accepts the global one — otherwise the global secret would still reach
  // every tenant.
  const orgSecret = organization?.peopleAiWebhookSecret
    ? decryptSecret(organization.peopleAiWebhookSecret)
    : null
  const secret = orgSecret ?? globalSecret
  if (!secret) {
    return NextResponse.json(
      { success: false, error: 'Signal webhooks are not configured for this environment.' },
      { status: 503 },
    )
  }
  if (!verifySignature({ rawBody, header, secret })) {
    await recordTokenRejection(request, { surface: 'signals-webhook', reason: 'invalid_hmac' })
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  const mapped = mapEventToSignal(payload)
  if (!mapped) {
    // Unknown event type — acknowledge so People.ai doesn't retry forever.
    return NextResponse.json({ success: true, ignored: true }, { status: 202 })
  }

  if (!organization) {
    apiLogger.warn('signal dropped: no workspace for team', { teamId: teamId ?? null, type: mapped.type })
    return NextResponse.json({ success: true, dropped: true }, { status: 202 })
  }

  let signal
  try {
    signal = await prisma.signal.create({
      data: {
        organizationId: organization.id,
        type: mapped.type,
        accountId: mapped.accountId,
        opportunityId: mapped.opportunityId,
        stakeholderId: mapped.stakeholderId,
        payload: mapped.payload as Prisma.InputJsonObject,
        dedupeKey: mapped.dedupeKey,
        provenanceUrl: mapped.provenanceUrl,
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Replay of an event we already hold — acknowledged, not re-routed.
      return NextResponse.json({ success: true, duplicate: true }, { status: 200 })
    }
    throw error
  }

  // Flow signal triggers hear the event too — durably. Agent routing (below)
  // is fire-and-forget after the response; flows get an outbox row instead,
  // so a crash or transient failure is retried by the outbox loop rather than
  // lost behind the 202. Failure here must not lose the agent path: log and go on.
  try {
    await prisma.outboxEvent.create({
      data: flowSignalOutboxEvent({
        organizationId: organization.id,
        aggregateId: signal.id,
        dedupeKey: `flow-signal:${signal.id}`,
        signal: {
          signal: `people-ai.${mapped.type}`,
          payload: {
            signalId: signal.id,
            type: mapped.type,
            accountId: mapped.accountId,
            opportunityId: mapped.opportunityId,
            stakeholderId: mapped.stakeholderId,
            payload: mapped.payload,
          },
        },
      }),
    })
  } catch (error) {
    apiLogger.error('people-ai signal: flow outbox enqueue failed', {
      signalId: signal.id,
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { path: '/api/signals/people-ai', signalId: signal.id, stage: 'flow-outbox' })
  }

  // Route after the response so the webhook returns fast even in inline mode.
  const runRouting = () =>
    routeSignal(signal.id).catch((error) => {
      apiLogger.error('signal routing failed', {
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
      })
      captureError(error, { path: '/api/signals/people-ai', signalId: signal.id })
    })
  try {
    after(runRouting)
  } catch {
    // Outside a Next request context (tests): fire-and-forget.
    void runRouting()
  }

  return NextResponse.json({ success: true, signalId: signal.id }, { status: 202 })
}
