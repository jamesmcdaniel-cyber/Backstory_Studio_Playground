import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveIceServers } from '@/lib/flows/ice-config'

// GET /api/flows/huddle-ice — WebRTC ICE config for the voice huddle.
// Credentials are minted server-side per call (Cloudflare short-lived creds,
// falling back to static TURN_* env, then STUN-only) and reach only
// authenticated users — never the client bundle. The org id is passed as
// Cloudflare's customIdentifier so relay usage is attributable per workspace.
export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  iceServers: await resolveIceServers(
    {
      CLOUDFLARE_TURN_KEY_ID: process.env.CLOUDFLARE_TURN_KEY_ID,
      CLOUDFLARE_TURN_API_TOKEN: process.env.CLOUDFLARE_TURN_API_TOKEN,
      TURN_URL: process.env.TURN_URL,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
      TURN_SECRET: process.env.TURN_SECRET,
    },
    { customIdentifier: auth.organizationId },
  ),
}), { permission: 'flow.read' })
