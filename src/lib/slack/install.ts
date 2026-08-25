/**
 * Backstory's own Slack app — OAuth v2 install helpers.
 *
 * Pure and I/O-free so URL construction and response parsing are testable
 * without a network or a database; the routes do the talking.
 *
 * Why an install flow at all: the BYO model failed operationally. The person
 * who created a workspace's Slack app leaves, nobody can reach its settings,
 * and the workspace has a bot it can neither administer nor replace. Backstory
 * owns one app instead, so no individual's departure can orphan it.
 */

/** Encrypted, httpOnly state cookie — mirrors OAUTH_COOKIE in src/lib/mcp/oauth-authcode.ts. */
export const SLACK_OAUTH_COOKIE = 'bslack_oauth'

/**
 * Bot scopes requested at install.
 *
 *  - app_mentions:read     receive @mentions at all
 *  - chat:write            post the reply
 *  - chat:write.customize  post it under the TEAMMATE's name and avatar; without
 *                          this every teammate looks like one generic bot
 *  - channels:history      conversations.history — the activity backfill's reads
 *  - channels:read         conversations.list — the backfill's channel enumeration
 *
 * The last two carry over from the BYO scope list in
 * docs/runbooks/activity-plane.md §5. Dropping them would leave installed
 * workspaces with a silently broken backfill.
 */
export const SLACK_BOT_SCOPES =
  'app_mentions:read,chat:write,chat:write.customize,channels:history,channels:read'

/** What the encrypted state cookie holds between the two legs of the flow. */
export interface SlackOAuthState {
  state: string
  organizationId: string
  userId: string
  /** Epoch ms the state was minted — see stateIsFresh. */
  issuedAt: number
  returnTo?: string
}

/** Ten minutes to finish consenting. */
export const SLACK_STATE_MAX_AGE_MS = 600_000

/**
 * Is this state still within its window?
 *
 * The cookie carries a maxAge, but that is enforced by the BROWSER — a captured
 * cookie replayed by anything else never sees it. Checking server-side is what
 * actually bounds how long a stolen state is worth stealing. A missing or
 * non-numeric issuedAt fails closed rather than being treated as fresh.
 */
export function stateIsFresh(issuedAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(issuedAt)) return false
  const age = now - issuedAt
  // Future-dated states are refused too: a clock skew large enough to produce
  // one is also large enough to make the age check meaningless.
  return age >= 0 && age <= SLACK_STATE_MAX_AGE_MS
}

export function buildSlackAuthorizeUrl(params: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL('https://slack.com/oauth/v2/authorize')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('scope', SLACK_BOT_SCOPES)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  return url.toString()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Read an `oauth.v2.access` response.
 *
 * Slack answers HTTP 200 even for a rejected exchange, so `ok` in the body is
 * the real result and the status code is not. All three fields are required:
 * a token with no teamId is unroutable — `findSlackWorkspaceByTeamId` is how an
 * inbound delivery finds its organization — and a missing botUserId breaks
 * `selfOrigin`, which is the loop guard that stops an agent answering itself.
 */
export function parseOAuthAccess(
  body: unknown,
): { botToken: string; teamId: string; botUserId: string } | null {
  const record = asRecord(body)
  if (!record || record.ok !== true) return null

  const botToken = typeof record.access_token === 'string' ? record.access_token : ''
  const botUserId = typeof record.bot_user_id === 'string' ? record.bot_user_id : ''
  const team = asRecord(record.team)
  const teamId = team && typeof team.id === 'string' ? team.id : ''

  if (!botToken || !botUserId || !teamId) return null
  return { botToken, teamId, botUserId }
}
