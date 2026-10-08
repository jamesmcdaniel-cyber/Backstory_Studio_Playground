import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'

/**
 * How an agent's external trigger secret is verified.
 *
 * The secret is stored as a SHA-256 hash in `AgentTask.metadata.triggerSecretHash`
 * (minted by the trigger-secret route). Before hashing existed the plaintext
 * sat in `metadata.triggerSecret`, and the trigger route kept honouring it
 * with a constant-time compare — which meant a database read (a backup, a
 * support query, an export) handed over a live credential for every agent
 * that had never rotated. That fallback is gone: a row still holding only a
 * plaintext secret is refused with a message naming the migration.
 */
export type TriggerSecretVerdict = 'ok' | 'invalid' | 'legacy_plaintext'

export const LEGACY_TRIGGER_SECRET_MESSAGE =
  "This agent's trigger secret is stored in a legacy plaintext format and is no longer accepted. " +
  'An administrator can migrate it in place with `npx tsx scripts/encrypt-trigger-secrets.ts`, ' +
  "or regenerate the secret from the agent's trigger settings."

export function verifyAgentTriggerSecret(provided: string, metadata: Record<string, unknown>): TriggerSecretVerdict {
  const hash = typeof metadata.triggerSecretHash === 'string' ? metadata.triggerSecretHash : null
  if (hash) return timingSafeEqualHex(hashToken(provided), hash) ? 'ok' : 'invalid'
  if (typeof metadata.triggerSecret === 'string' && metadata.triggerSecret.length > 0) return 'legacy_plaintext'
  return 'invalid'
}

/** True when a row still carries only the pre-hashing plaintext secret. */
export function hasLegacyPlaintextTriggerSecret(metadata: Record<string, unknown>): boolean {
  return typeof metadata.triggerSecretHash !== 'string' && typeof metadata.triggerSecret === 'string' && metadata.triggerSecret.length > 0
}
