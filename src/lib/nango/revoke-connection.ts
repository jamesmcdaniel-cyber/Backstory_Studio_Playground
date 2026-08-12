import { z } from 'zod'
import { getNangoClient, nangoConfigured } from './client'
import { recordAudit } from '@/lib/audit'

/**
 * Delete one OAuth grant at Nango.
 *
 * Throwing is how the outbox learns to retry, so failures must NOT be swallowed
 * here — a silently-swallowed error would leave the grant live at the provider
 * while the queue reported success, which is the exact invisible-credential
 * problem the revocation spine exists to close.
 */

const payloadSchema = z.object({
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  userId: z.string().min(1),
})

export async function handleCredentialRevoke(organizationId: string, payload: unknown): Promise<void> {
  const { connectionId, providerConfigKey, userId } = payloadSchema.parse(payload)

  // Nothing to revoke upstream in an install with no Nango — treat as done
  // rather than retrying eight times against a client that cannot exist.
  if (!nangoConfigured()) return

  await getNangoClient().deleteConnection(providerConfigKey, connectionId)

  await recordAudit({
    organizationId,
    action: 'credential.revoked',
    actorKind: 'system',
    actorUserId: userId,
    resourceType: 'nango_connection',
    resourceId: connectionId,
    detail: { providerConfigKey, upstream: true },
  })
}
