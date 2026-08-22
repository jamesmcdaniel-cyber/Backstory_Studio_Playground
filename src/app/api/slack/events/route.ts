import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { apiLogger } from '@/lib/logger'
import { systemPrisma } from '@/lib/prisma'
import { normalizeSlackEvent } from '@/lib/activity/normalize'
import { verifySlackSignature } from '@/lib/activity/slack-verify'
import { activityDispatchOutboxEvent } from '@/lib/outbox'
import {
  allSlackWorkspaceCredentials,
  findSlackWorkspaceByTeamId,
  resolveSigningSecretForOrg,
  type SlackWorkspaceCredential,
} from '@/lib/integrations/slack'
import { clientIp, recordTokenRejection } from '@/lib/security/events'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'

/**
 * Slack Events API receiver.
 *
 * Slack's own budget for this endpoint is 3 seconds; everything here is
 * signature verification + one persistence write + one durable outbox row —
 * matching/dispatch NEVER happens inline (that's the Task 6 dispatcher,
 * woken by the outbox row this handler writes). See
 * docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md.
 *
 * ── Multi-tenant signing secret (the "per-workspace credential" design) ────
 *
 * Every other built-in integration in this codebase is workspace-owned (see
 * src/lib/integrations/org-credential.ts): a customer brings their own
 * credential, or the integration is off for them. Slack's Events API keeps
 * that model for signing secrets too — this is a BYO-Slack-App surface, not
 * a single Backstory-owned app every workspace installs into. Each
 * workspace creates its own Slack app, gets its own bot token AND its own
 * signing secret, and points that app's Events API request URL at this one
 * shared endpoint. `team_id` on an `event_callback` payload is how a
 * delivery is routed back to the org that owns it (see
 * findSlackWorkspaceByTeamId in src/lib/integrations/slack.ts) — there is no
 * other binding between a Slack workspace and a Backstory organization
 * today, so this is the mapping this route relies on and is documenting.
 *
 * `url_verification` (Slack's one-time handshake when a workspace's request
 * URL is first saved) carries no `team_id` at all, so there's no org to
 * resolve it against yet. It's still required to carry a valid signature
 * (this endpoint never trusts an unsigned request), verified against
 * whichever configured workspace's secret matches — see
 * allSlackWorkspaceCredentials. That request never causes a DB write beyond
 * this signature check; it only proves control of a registered app's
 * endpoint, not an authenticated action on any org's data.
 *
 * ── Failure modes (never a 500 to Slack) ───────────────────────────────────
 *
 * Every `team_id`-scoped failure — unknown team, an org with no signing
 * secret to verify with, or a signature that fails to verify — returns the
 * SAME `200 { ok: true }` ack. Those cases used to be split (401 for a known
 * org's bad signature, 200 for a `team_id` we'd never heard of), which made
 * the response code itself an oracle: an attacker could tell "this workspace
 * IS connected to Backstory" from "it is NOT" without any other signal, just
 * by trying candidate team ids. There is nothing operationally useful about
 * that distinction being visible to the caller — Slack does nothing
 * different with a 401 versus a 200 — so it is not surfaced. The real signal
 * moved to logs instead: an unknown `team_id` is WARN (routine — a
 * disconnected or never-connected workspace is not an incident); a KNOWN
 * team's signature failing is ERROR (Sentry-visible — that one is either a
 * misconfigured signing secret or a forged request, and is worth a human
 * looking at). `url_verification` (no `team_id` at all — see below) is not
 * part of this oracle, since there is no per-workspace state to distinguish
 * for it, and keeps returning 401 on a failed signature.
 *
 *  - Unparseable body: 200 ack (verified-but-inert, same as the Nango
 *    webhook's `unparseable` branch) once resolvable at all, else 400 (no
 *    team_id/type to act on before a secret can even be chosen).
 */

const ADMISSION_LIMIT = { limit: 600, windowMs: 60_000, failureMode: 'closed' } as const
const REJECTED_LIMIT = { limit: 30, windowMs: 60_000, failureMode: 'closed' } as const
/**
 * `url_verification` carries no `team_id`, so verifying it means trying every
 * configured workspace's own secret (see `resolveVerification` below) — an
 * O(N) HMAC computation per request, driven entirely by attacker-controlled
 * request volume, on a route with no session and no per-org gate. Two
 * mitigations, both because this handshake genuinely only ever happens once
 * per workspace during Slack app setup, never in steady-state traffic:
 *  - a MUCH tighter rate limit than the general admission gate, keyed
 *    separately so a legitimate `event_callback` flood from one IP never
 *    starves this bucket and vice versa.
 *  - a hard cap on how many stored secrets are even fetched to try, so the
 *    per-request cost has a fixed ceiling regardless of how many workspaces
 *    are configured system-wide.
 */
const URL_VERIFICATION_RATE_LIMIT = { limit: 5, windowMs: 60_000, failureMode: 'closed' } as const
const URL_VERIFICATION_TRIAL_CAP = 50

function tooMany(retryAfterMs?: number) {
  return NextResponse.json(
    { ok: false, error: 'Too many requests' },
    { status: 429, headers: { 'retry-after': String(Math.ceil((retryAfterMs ?? 1_000) / 1_000)) } },
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * Resolve the signing secret to verify this request with, and (for
 * `event_callback`) the organization it belongs to.
 *
 *  - `team_id` present → exactly one org's credential is tried (the one
 *    `team_id` names). No match → `{ outcome: 'unknown-team' }`; a match
 *    that fails to verify (missing secret OR bad signature) →
 *    `{ outcome: 'team-verification-failed' }` — deliberately NOT split into
 *    separate cases, so the route can't accidentally respond to them
 *    differently and reopen the enumeration oracle these two used to be
 *    (see the file-level doc comment).
 *  - `team_id` absent (`url_verification`) → every configured workspace's
 *    secret is tried, up to `URL_VERIFICATION_TRIAL_CAP`, until one verifies
 *    (see the file-level doc comment for why this is safe: no org-scoped
 *    action follows from this branch). A signature that matches none of them
 *    is `{ outcome: 'url-verification-failed' }` — kept distinct from the
 *    team_id branch's failure because there is no per-workspace connection
 *    state to leak here in the first place.
 */
async function resolveVerification(
  body: Record<string, unknown>,
  headers: { timestampHeader: string | null; signatureHeader: string | null; rawBody: string; now: Date },
): Promise<
  | { outcome: 'verified'; organizationId: string | null; credential: SlackWorkspaceCredential | null }
  | { outcome: 'unknown-team' }
  | { outcome: 'team-verification-failed' }
  | { outcome: 'url-verification-failed' }
> {
  const teamId = typeof body.team_id === 'string' ? body.team_id : null

  if (teamId) {
    const credential = await findSlackWorkspaceByTeamId(teamId)
    if (!credential) return { outcome: 'unknown-team' }
    const signingSecret = await resolveSigningSecretForOrg(credential)
    if (!signingSecret) return { outcome: 'team-verification-failed' }
    const ok = verifySlackSignature({
      signingSecret,
      timestampHeader: headers.timestampHeader,
      signatureHeader: headers.signatureHeader,
      rawBody: headers.rawBody,
      now: headers.now,
    })
    if (!ok) return { outcome: 'team-verification-failed' }
    return { outcome: 'verified', organizationId: credential.organizationId, credential }
  }

  // No team_id: the url_verification handshake. Try every configured
  // workspace's own secret (env-fallback secrets are per-org and require an
  // org id to resolve, so they're not reachable from this branch — a purely
  // env-configured internal/partner secret with no IntegrationSecret row at
  // all cannot receive a url_verification handshake by this design; it must
  // save at least a bot token first), bounded by URL_VERIFICATION_TRIAL_CAP
  // so this branch's cost has a fixed ceiling regardless of how many
  // workspaces are configured system-wide. Fetching one extra row is how the
  // cap's own truncation is detected without a second query.
  const fetched = await allSlackWorkspaceCredentials(URL_VERIFICATION_TRIAL_CAP + 1)
  const truncated = fetched.length > URL_VERIFICATION_TRIAL_CAP
  if (truncated) {
    // Honest tradeoff, not a silent one: if the system ever has more
    // configured Slack workspaces than the cap, whichever ones sort AFTER
    // the cap in claimantsForTeamId's deterministic order cannot complete
    // their url_verification handshake through this branch until the count
    // drops back under the cap (or the cap is raised). That's an acceptable
    // cost for a handshake that happens once per workspace at setup time,
    // against the alternative of an unbounded per-request HMAC cost driven
    // entirely by request volume — but it's a real, visible limit, hence the
    // WARN rather than letting it pass unnoticed.
    apiLogger.warn('slack url_verification trial set capped', { cap: URL_VERIFICATION_TRIAL_CAP })
  }
  const candidates = truncated ? fetched.slice(0, URL_VERIFICATION_TRIAL_CAP) : fetched
  for (const credential of candidates) {
    if (!credential.ownSigningSecret) continue
    const ok = verifySlackSignature({
      signingSecret: credential.ownSigningSecret,
      timestampHeader: headers.timestampHeader,
      signatureHeader: headers.signatureHeader,
      rawBody: headers.rawBody,
      now: headers.now,
    })
    if (ok) return { outcome: 'verified', organizationId: null, credential }
  }
  return { outcome: 'url-verification-failed' }
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const admitted = await rateLimit(`slack-events:${ip}`, ADMISSION_LIMIT)
  if (!admitted.ok) return tooMany(admitted.retryAfterMs)

  // Raw bytes FIRST — signature verification covers the exact bytes Slack
  // signed, so nothing may parse/re-serialize the body before this read.
  const rawBody = await request.text()

  let body: Record<string, unknown>
  try {
    body = asRecord(JSON.parse(rawBody))
  } catch {
    // No team_id/type to resolve a secret or an action from at all — this is
    // not a webhook delivery shape we recognize, verified or not.
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const teamId = typeof body.team_id === 'string' ? body.team_id : null
  if (!teamId) {
    // The url_verification branch is the one attacker-triggerable O(N) crypto
    // path (see the constant's doc comment) — a much tighter, separately
    // keyed limit than general admission, since this handshake only ever
    // happens once per workspace at setup time.
    const allowedUrlVerification = await rateLimit(`slack-events-no-team:${ip}`, URL_VERIFICATION_RATE_LIMIT)
    if (!allowedUrlVerification.ok) return tooMany(allowedUrlVerification.retryAfterMs)
  }

  const timestampHeader = request.headers.get('x-slack-request-timestamp')
  const signatureHeader = request.headers.get('x-slack-signature')
  const resolution = await resolveVerification(body, { timestampHeader, signatureHeader, rawBody, now: new Date() })

  if (resolution.outcome === 'unknown-team') {
    // Signature can't even be attempted — nothing on our side names this
    // team_id. Never 500, never retried into: ack and move on. WARN, not
    // ERROR — a disconnected/never-connected workspace is routine, not an
    // incident (see the file-level doc comment on why this ack is
    // byte-identical to `team-verification-failed`'s below).
    apiLogger.warn('slack event dropped — team_id matches no connected workspace', { teamId: body.team_id })
    return NextResponse.json({ ok: true })
  }

  if (resolution.outcome === 'team-verification-failed') {
    const allowed = await rateLimit(`slack-events-rejected:${ip}`, REJECTED_LIMIT)
    if (!allowed.ok) return tooMany(allowed.retryAfterMs)
    await recordTokenRejection(request, { surface: 'slack-events', reason: 'invalid_signature' })
    // ERROR, not WARN: unlike an unknown team_id, this IS a connected
    // workspace — a signature that fails to verify for it is either a
    // misconfigured signing secret or a forged request, either of which is
    // worth a human looking at. The response is still the uniform 200 ack
    // (see the file-level doc comment): Slack's dashboard is not where this
    // gets diagnosed, logs are.
    apiLogger.error('slack event verification failed for a connected workspace', { teamId })
    return NextResponse.json({ ok: true })
  }

  if (resolution.outcome === 'url-verification-failed') {
    const allowed = await rateLimit(`slack-events-rejected:${ip}`, REJECTED_LIMIT)
    if (!allowed.ok) return tooMany(allowed.retryAfterMs)
    await recordTokenRejection(request, { surface: 'slack-events', reason: 'invalid_signature_url_verification' })
    // No team_id to leak connection status for — this stays a distinguishable
    // 401, unlike the two ack'd outcomes above.
    return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 })
  }

  // resolution.outcome === 'verified' from here on.
  const type = typeof body.type === 'string' ? body.type : null

  if (type === 'url_verification') {
    const challenge = typeof body.challenge === 'string' ? body.challenge : ''
    return NextResponse.json({ challenge })
  }

  if (type !== 'event_callback' || !resolution.organizationId) {
    // Verified, but not a shape this receiver acts on (or a url_verification-
    // style match with no org — event_callback always carries team_id, so
    // this combination shouldn't occur in practice). Ack without side
    // effects rather than erroring on an unrecognized-but-authentic delivery.
    return NextResponse.json({ ok: true, skipped: 'unhandled-type' })
  }

  const organizationId = resolution.organizationId
  const botUserId = resolution.credential?.botUserId ?? undefined

  try {
    const receivedAt = new Date()
    const normalized = normalizeSlackEvent(organizationId, body, { botUserId, receivedAt })
    if (!normalized) {
      apiLogger.warn('slack event dropped — no recognizable event in envelope', { organizationId })
      return NextResponse.json({ ok: true, skipped: 'unnormalizable' })
    }

    let activityEventId: string
    try {
      const created = await systemPrisma.activityEvent.create({
        data: {
          organizationId,
          source: normalized.source,
          sourceEventId: normalized.sourceEventId,
          kind: normalized.kind,
          occurredAt: normalized.occurredAt,
          actorExternalId: normalized.actorExternalId,
          // Slack workspace credentials are org-shared (one bot token per
          // workspace, not per user), so every event from it is org-visible —
          // same convention as the Nango webhook's org-shared (null userId)
          // connections.
          ownerUserId: null,
          visibility: 'org',
          selfOrigin: normalized.selfOrigin,
          chainDepth: normalized.chainDepth,
          subject: normalized.subject as Prisma.InputJsonValue,
          payload: normalized.payload as Prisma.InputJsonValue,
        },
        select: { id: true },
      })
      activityEventId = created.id
    } catch (error) {
      // P2002 on [organizationId, source, sourceEventId] = a retry
      // (Slack resends on anything but a 200, and tolerates `x-slack-retry-num`
      // deliveries the same way). The first delivery already wrote the
      // outbox row below, so this ack needs no second one — a redelivery is
      // fully idempotent without a lookup back to the original row's id.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
      return NextResponse.json({ ok: true })
    }

    try {
      // Durable handoff: matching/dispatch happens out-of-band (Task 6), never
      // inline — this route's entire job past persistence is to hand the
      // event id off durably and return within Slack's 3s budget.
      await systemPrisma.outboxEvent.create({
        data: activityDispatchOutboxEvent({
          organizationId,
          activityEventId,
          source: normalized.source,
          sourceEventId: normalized.sourceEventId,
        }),
      })
    } catch (error) {
      // Same P2002-as-ack reasoning as above, on the outbox's own
      // [organizationId, dedupeKey] unique constraint.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    }
  } catch (error) {
    apiLogger.error('slack event handling failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    // Verified request, our-side failure: ack anyway. Slack has no bounded
    // retry budget worth trusting over our own outbox/cron reconciliation,
    // and a 5xx here would just retry into the same failure.
  }

  return NextResponse.json({ ok: true })
}
