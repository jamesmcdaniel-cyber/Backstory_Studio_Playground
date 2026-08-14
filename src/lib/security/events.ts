/**
 * Security-event spine.
 *
 * Rejections used to be silent. A 401, a 403, a 429 or a bad webhook signature
 * returned its status and left nothing behind — no log line, no audit row, no
 * counter. That made an attack the one class of traffic the platform could not
 * see: credential stuffing, a permission-probing sweep across routes, or an
 * AI-quota abuse burst all produce 4xx, and 4xx never reached Sentry (which by
 * design only receives 5xx, see api-handler.ts).
 *
 * Every rejection now lands here, and this module does three things:
 *
 *   1. Emits ONE structured, greppable log line — always, even anonymously.
 *   2. Writes an audit row when the actor's organization is known.
 *   3. Counts the event against a per-subject threshold and raises an email
 *      alert the first time that threshold is crossed.
 *
 * Recording must never break the response it describes: everything here
 * swallows its own failures. A rejected request is still a rejected request if
 * the audit write fails.
 */

import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'
import { rateLimit } from '@/lib/ratelimit'
import { alertSecurityThreshold } from './alerts'

export type SecurityEventKind =
  /** 401 — absent, expired, or unusable session on a gated route. */
  | 'auth.failed'
  /** 403 — authenticated, but a permission/entitlement/MFA/SSO gate refused. */
  | 'auth.forbidden'
  /** 401 on a token-authenticated surface: trigger secret, HMAC, SCIM, API key. */
  | 'auth.token_invalid'
  /** 429 — a rate limit or spend ceiling rejected the call. */
  | 'abuse.rate_limited'
  /** 413 — request body over the route's ceiling. */
  | 'abuse.body_too_large'

/**
 * How many events of a kind, from one subject, within the window before the
 * event is worth waking someone for.
 *
 * These are tuned to be quiet under normal product use and loud under a sweep.
 * `auth.forbidden` sits low because a legitimate user does not walk into twenty
 * permission denials in five minutes — a script enumerating routes does.
 * `abuse.rate_limited` sits high because a runaway client loop trips it
 * harmlessly and repeatedly; only sustained pressure is interesting.
 */
const THRESHOLDS: Record<SecurityEventKind, { limit: number; windowMs: number }> = {
  'auth.failed': { limit: 20, windowMs: 5 * 60_000 },
  'auth.forbidden': { limit: 20, windowMs: 5 * 60_000 },
  'auth.token_invalid': { limit: 10, windowMs: 5 * 60_000 },
  'abuse.rate_limited': { limit: 60, windowMs: 5 * 60_000 },
  'abuse.body_too_large': { limit: 20, windowMs: 5 * 60_000 },
}

/** Audit actions, one per kind, so the audit log is queryable by attack shape. */
const AUDIT_ACTIONS: Record<SecurityEventKind, string> = {
  'auth.failed': 'security.auth_failed',
  'auth.forbidden': 'security.permission_denied',
  'auth.token_invalid': 'security.token_invalid',
  'abuse.rate_limited': 'security.rate_limited',
  'abuse.body_too_large': 'security.body_too_large',
}

export interface SecurityEventInput {
  kind: SecurityEventKind
  /** Request path, for the log line and the audit row. Never the query string. */
  path: string
  method: string
  /** Caller IP, best effort. Use `clientIp(request)`. */
  ip?: string | null
  /** Known actor, when the rejection happened after identification. */
  userId?: string | null
  organizationId?: string | null
  /**
   * What the threshold counts. Defaults to the user id when known, else the IP
   * — so one authenticated account sweeping routes is counted as one subject
   * rather than smeared across whatever IPs it dialled from.
   */
  subject?: string | null
  /** Extra context for the log line and audit row. Must not carry secrets. */
  detail?: Record<string, unknown>
}

/** First hop of x-forwarded-for, the caller as the edge saw them. */
export function clientIp(request: { headers: Headers }): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

/**
 * Path only — never the query string, which on these surfaces can carry the
 * very token that was rejected.
 */
export function requestPath(request: { url: string }): string {
  try {
    return new URL(request.url).pathname
  } catch {
    return 'unknown'
  }
}

/**
 * Record a security-relevant rejection. Awaited by callers (the request is
 * already refused, so the latency is free) but never able to throw into them.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    const ip = input.ip ?? 'unknown'
    const subject = input.subject || input.userId || ip

    // (1) Always a log line. This is the layer that works with no database, no
    // Redis and no email configured, so it is the one that must not be
    // conditional. The `security.` prefix is the grep/alert-rule anchor.
    apiLogger.warn(`security.${input.kind}`, {
      path: input.path,
      method: input.method,
      ip,
      userId: input.userId ?? undefined,
      organizationId: input.organizationId ?? undefined,
      ...input.detail,
    })

    // (2) Audit row, when we know whose workspace this was. Anonymous 401s have
    // no organization to attach to and are covered by the log line alone.
    if (input.organizationId) {
      await recordAudit({
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS[input.kind],
        actorUserId: input.userId ?? null,
        actorKind: input.userId ? 'user' : 'system',
        resourceType: 'route',
        resourceId: input.path,
        ip,
        detail: { method: input.method, ...input.detail },
      })
    }

    // (3) Threshold. Reuses the rate limiter as a counter: `ok: false` is
    // exactly "this subject crossed N in the window", which is the condition
    // worth alerting on. Same backend caveat as everywhere else — with no
    // shared Redis this counts per instance (see assertRateLimitBackend).
    const threshold = THRESHOLDS[input.kind]
    const counted = await rateLimit(`sec:${input.kind}:${subject}`, threshold)
    if (!counted.ok) {
      await alertSecurityThreshold({
        kind: input.kind,
        subject,
        threshold: threshold.limit,
        windowMs: threshold.windowMs,
        path: input.path,
        ip,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
      })
    }
  } catch (error) {
    // Recording a rejection must never become a second failure.
    apiLogger.error('security event recording failed', {
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Convenience wrapper for the token-authenticated surfaces — trigger secrets,
 * HMAC webhooks, SCIM bearers, workspace API keys, the cron secret.
 *
 * These routes are deliberately outside `withAuthenticatedApi` (see
 * UNGATED_ROUTES), so they would otherwise be the one part of the perimeter
 * with no rejection signal at all — which is backwards, since a token surface
 * is exactly what an attacker can hammer without needing an account first.
 *
 * Takes a plain `Request` because most of these handlers are given one.
 * The subject is the credential surface plus the IP: the token itself must
 * never become a counter key, and a failed token has no identity to attribute.
 */
export async function recordTokenRejection(
  request: Request,
  detail: { surface: string; reason: string; organizationId?: string | null },
): Promise<void> {
  const path = requestPath(request)
  const ip = clientIp(request)
  await recordSecurityEvent({
    kind: 'auth.token_invalid',
    path,
    method: request.method,
    ip,
    organizationId: detail.organizationId ?? null,
    subject: `${detail.surface}:${ip}`,
    detail: { surface: detail.surface, reason: detail.reason },
  })
}

/** Exposed for tests so threshold behaviour can be asserted without re-deriving it. */
export function securityThreshold(kind: SecurityEventKind): { limit: number; windowMs: number } {
  return THRESHOLDS[kind]
}
