import { createHash } from 'node:crypto'

export const FLOW_WEBHOOK_MAX_BODY_BYTES = 1_000_000
export const FLOW_WEBHOOK_MAX_SKEW_MS = 5 * 60_000

export type WebhookReplayHeaders = { deliveryId: string; timestampMs: number }

/**
 * Replay protection is OPT-IN (FLOW_WEBHOOK_REQUIRE_REPLAY_PROTECTION=true).
 * It used to default ON in production, which 400'd every sender that cannot
 * emit custom headers — i.e. virtually all third-party webhook producers — so
 * webhook triggers looked dead in prod. The secret is a bearer token: an
 * attacker who can capture a request to replay it already holds the secret,
 * so mandatory replay headers added little defense for what they cost.
 * Senders that DO provide the headers still get validation + dedupe.
 */
export function requireWebhookReplayProtection(): boolean {
  return process.env.FLOW_WEBHOOK_REQUIRE_REPLAY_PROTECTION === 'true'
}

export function parseWebhookReplayHeaders(
  headers: Pick<Headers, 'get'>,
  nowMs = Date.now(),
): { value?: WebhookReplayHeaders; error?: string } {
  const deliveryId = (headers.get('x-trigger-delivery-id') || '').trim()
  const timestamp = (headers.get('x-trigger-timestamp') || '').trim()
  if (!deliveryId && !timestamp && !requireWebhookReplayProtection()) return {}
  if (!deliveryId || !timestamp) {
    return { error: 'Webhook requests require x-trigger-delivery-id and x-trigger-timestamp headers.' }
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(deliveryId)) return { error: 'Webhook delivery id is invalid.' }
  const raw = Number(timestamp)
  const timestampMs = raw < 10_000_000_000 ? raw * 1000 : raw
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > FLOW_WEBHOOK_MAX_SKEW_MS) {
    return { error: 'Webhook timestamp is outside the allowed five-minute window.' }
  }
  return { value: { deliveryId, timestampMs } }
}

export function webhookPayloadHash(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

export function parseWebhookBody(bytes: Buffer, contentType: string): unknown {
  if (bytes.length > FLOW_WEBHOOK_MAX_BODY_BYTES) throw new Error('Webhook body is too large.')
  const text = bytes.toString('utf8')
  if (contentType.toLowerCase().includes('application/json')) {
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new Error('Webhook body is not valid JSON.')
    }
  }
  return text
}
