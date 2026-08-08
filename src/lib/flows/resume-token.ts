import { createHmac } from 'node:crypto'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'

function resumeKey(): string {
  const key = process.env.FLOW_RESUME_TOKEN_KEY || process.env.ENCRYPTION_KEY
  if (!key && process.env.NODE_ENV === 'production') {
    throw new Error('FLOW_RESUME_TOKEN_KEY or ENCRYPTION_KEY is required in production')
  }
  return key || 'backstory-local-resume-key'
}

/** Deterministic capability: recoverable by workers, never stored in plaintext. */
export function flowResumeToken(runId: string): string {
  return createHmac('sha256', resumeKey()).update(`flow-resume:${runId}`).digest('base64url')
}

export function flowResumeTokenHash(runId: string): string {
  return hashToken(flowResumeToken(runId))
}

export function flowResumeTokenValid(runId: string, provided: string, expectedHash: string): boolean {
  if (!provided || provided.length > 256) return false
  return timingSafeEqualHex(hashToken(provided), expectedHash) && timingSafeEqualHex(expectedHash, flowResumeTokenHash(runId))
}
