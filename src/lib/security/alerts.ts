/**
 * Security alert delivery.
 *
 * The platform already had transactional mail (Resend, used for invitations)
 * and an append-only audit log. What it did not have was anything connecting a
 * burst of rejections to a human — so the delivery mechanism existed and was
 * simply never wired to a security event. This is that wire.
 *
 * Configuration:
 *   SECURITY_ALERT_EMAIL   comma-separated recipients. Unset ⇒ log-only, which
 *                          is a deliberate no-op rather than an error: a fresh
 *                          clone and every preview deploy run without it.
 *   RESEND_API_KEY         already required for invitations; sendEmail returns
 *                          false without it rather than throwing.
 *   SECURITY_ALERT_COOLDOWN_MS  per (kind, subject) silence window, default 1h.
 *
 * Alerts are deduped, not queued. An attack sustained for an hour produces one
 * email per subject per kind, not one per request — the point is to be told
 * something is happening, and the audit log holds the detail.
 */

import { apiLogger } from '@/lib/logger'
import { rateLimit } from '@/lib/ratelimit'
import type { SecurityEventKind } from './events'

/**
 * Per (kind, subject) silence window. An hour is long enough that a sustained
 * attack cannot flood the inbox, short enough that a fresh alert arrives while
 * the incident is still live.
 */
const COOLDOWN_MS = Math.max(60_000, Number(process.env.SECURITY_ALERT_COOLDOWN_MS) || 60 * 60_000)

export interface SecurityAlert {
  kind: SecurityEventKind
  subject: string
  threshold: number
  windowMs: number
  path: string
  ip: string
  userId: string | null
  organizationId: string | null
}

type AlertSender = (alert: SecurityAlert) => Promise<void>

let sender: AlertSender | null = null

/** Test seam, mirroring setErrorReporter in observability/sentry.ts. */
export function setSecurityAlertSender(next: AlertSender | null): void {
  sender = next
}

export function securityAlertRecipients(): string[] {
  return (process.env.SECURITY_ALERT_EMAIL || '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
}

/**
 * Raise an alert for a crossed threshold, at most once per cooldown window.
 *
 * The cooldown reuses the rate limiter with `limit: 1` — the first call in the
 * window returns ok, every later one does not, which is precisely "send once".
 * Never throws: an alerting failure must not turn a refused request into a 500.
 */
export async function alertSecurityThreshold(alert: SecurityAlert): Promise<void> {
  try {
    const allowed = await rateLimit(`secalert:${alert.kind}:${alert.subject}`, {
      limit: 1,
      windowMs: COOLDOWN_MS,
    })
    if (!allowed.ok) return

    // Logged at error level regardless of whether mail is configured, so a
    // crossed threshold is visible to log-based alerting too.
    apiLogger.error(`security.alert ${alert.kind}`, {
      subject: alert.subject,
      threshold: alert.threshold,
      windowMinutes: Math.round(alert.windowMs / 60_000),
      path: alert.path,
      ip: alert.ip,
      userId: alert.userId ?? undefined,
      organizationId: alert.organizationId ?? undefined,
    })

    if (sender) {
      await sender(alert)
      return
    }

    const recipients = securityAlertRecipients()
    if (recipients.length === 0) return

    // Imported lazily: the email module pulls the org-credential chain, and
    // this path runs at most once an hour per subject.
    const { sendEmail } = await import('@/lib/integrations/email')
    const subjectLine = `[Backstory] ${describe(alert.kind)} — ${alert.threshold}+ in ${Math.round(alert.windowMs / 60_000)}m`
    await Promise.all(
      recipients.map((to) =>
        sendEmail({ to, subject: subjectLine, text: body(alert) }).catch((error: unknown) => {
          apiLogger.error('security alert email failed', {
            to,
            error: error instanceof Error ? error.message : String(error),
          })
        }),
      ),
    )
  } catch (error) {
    apiLogger.error('security alert failed', {
      kind: alert.kind,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function describe(kind: SecurityEventKind): string {
  switch (kind) {
    case 'auth.failed':
      return 'Repeated authentication failures'
    case 'auth.forbidden':
      return 'Repeated permission denials'
    case 'auth.token_invalid':
      return 'Repeated invalid tokens'
    case 'abuse.rate_limited':
      return 'Sustained rate limiting'
    case 'abuse.body_too_large':
      return 'Repeated oversized requests'
  }
}

function body(alert: SecurityAlert): string {
  return [
    `${describe(alert.kind)} crossed the alert threshold.`,
    '',
    `Event:        ${alert.kind}`,
    `Subject:      ${alert.subject}`,
    `Threshold:    ${alert.threshold} in ${Math.round(alert.windowMs / 60_000)} minutes`,
    `Last path:    ${alert.path}`,
    `Last IP:      ${alert.ip}`,
    `User:         ${alert.userId ?? '(anonymous)'}`,
    `Organization: ${alert.organizationId ?? '(unknown)'}`,
    '',
    `Further alerts for this subject and event are suppressed for ${Math.round(COOLDOWN_MS / 60_000)} minutes.`,
    'Full detail is in the audit log (action starts with "security.") and in the',
    'server logs (grep for "security.").',
  ].join('\n')
}
