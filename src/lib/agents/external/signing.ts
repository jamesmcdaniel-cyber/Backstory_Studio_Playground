/**
 * Signing a task delivered to an external agent, and the verifier a receiver
 * (and our own tests) runs.
 *
 * The algorithm is the audit stream's, deliberately — one documented scheme,
 * not two: HMAC-SHA256 over `${timestamp}.${body}` with the agent's signing
 * secret, hex-encoded, in `x-backstory-signature`, the unix timestamp in
 * `x-backstory-timestamp`. The timestamp is signed WITH the body so a captured
 * delivery cannot be replayed later; receivers reject anything older than
 * five minutes.
 */

import { randomBytes } from 'node:crypto'
import { signStreamDelivery, verifyStreamDelivery, STREAM_SIGNATURE_TOLERANCE_SECONDS } from '@/lib/audit/stream'
import {
  EXTERNAL_DELIVERY_HEADER,
  EXTERNAL_EVENT_HEADER,
  EXTERNAL_SIGNATURE_HEADER,
  EXTERNAL_TIMESTAMP_HEADER,
} from './types'

/** Signing secrets read as what they are in a log or a support thread. */
export const SIGNING_SECRET_PREFIX = 'bsw_'

export function mintSigningSecret(): string {
  return `${SIGNING_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** A fresh single-use reply token for one task. 192 bits, hex. */
export function mintReplyToken(): string {
  return randomBytes(24).toString('hex')
}

export const EXTERNAL_SIGNATURE_TOLERANCE_SECONDS = STREAM_SIGNATURE_TOLERANCE_SECONDS

export function signExternalDelivery(secret: string, body: string, timestampSeconds: number): string {
  return signStreamDelivery(secret, body, timestampSeconds)
}

/** The headers one delivery attempt carries. Re-signed per attempt (fresh timestamp). */
export function externalDeliveryHeaders(params: {
  secret: string
  body: string
  executionId: string
  nowSeconds?: number
}): Record<string, string> {
  const timestamp = params.nowSeconds ?? Math.floor(Date.now() / 1000)
  return {
    'content-type': 'application/json',
    'user-agent': 'Backstory-Agents/1.0',
    [EXTERNAL_EVENT_HEADER]: 'agent.task',
    [EXTERNAL_DELIVERY_HEADER]: params.executionId,
    [EXTERNAL_TIMESTAMP_HEADER]: String(timestamp),
    [EXTERNAL_SIGNATURE_HEADER]: signExternalDelivery(params.secret, params.body, timestamp),
  }
}

/** The documented verification, exactly as docs/external-agents.md describes it. */
export function verifyExternalDelivery(params: {
  secret: string
  body: string
  timestampSeconds: number
  signature: string
  nowSeconds: number
}): boolean {
  return verifyStreamDelivery(params)
}
