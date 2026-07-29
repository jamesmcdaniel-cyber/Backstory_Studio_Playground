import { pushEnabled } from '@/lib/notifications/push'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

// Tells the client whether web push is configured and hands it the VAPID
// public key needed to subscribe.
export const GET = withAuthenticatedApi(async () => ({
  success: true,
  enabled: pushEnabled(),
  publicKey: process.env.VAPID_PUBLIC_KEY || null,
}), { permission: null })
