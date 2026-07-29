import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { iceServersFromEnv } from '@/lib/flows/ice-config'

// GET /api/flows/huddle-ice — WebRTC ICE config for the voice huddle. TURN
// creds live in env (TURN_URL/TURN_USERNAME/TURN_CREDENTIAL) and reach only
// authenticated users at call time — never the client bundle. STUN-only until
// the env vars are set; enabling a relay is a Vercel env change, no deploy.
export const GET = withAuthenticatedApi(async () => ({
  success: true,
  iceServers: iceServersFromEnv({
    TURN_URL: process.env.TURN_URL,
    TURN_USERNAME: process.env.TURN_USERNAME,
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
  }),
}), { permission: 'flow.read' })
