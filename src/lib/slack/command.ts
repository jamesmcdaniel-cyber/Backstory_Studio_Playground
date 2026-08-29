/**
 * Slash-command parsing.
 *
 * A slash command is a different Slack surface from the Events API, not a
 * variant of it: the body is form-encoded rather than JSON, there is no
 * envelope and no `event`, the handler has a 3-second budget, and the answer
 * goes to a one-shot `response_url` instead of a channel post. Nothing in the
 * events receiver applies except the signature check, which is why this is its
 * own module rather than a branch in there.
 *
 * Pure: parsing and normalization only, so the route's fast path stays a
 * signature check plus a lookup.
 */

export interface SlackCommandPayload {
  teamId: string
  /** Command WITHOUT its leading slash, lowercased — the binding key. */
  command: string
  /** Everything the user typed after the command. May be empty. */
  text: string
  slackUserId: string
  channelId: string
  channelName: string
  responseUrl: string
}

/**
 * Normalize a command to its binding key.
 *
 * Slack echoes the command exactly as the app registered it, so `/DealCheck`
 * and `/dealcheck` are the same command typed two ways. Lowercasing and
 * dropping the slash means a binding cannot depend on which one a workspace
 * happened to configure.
 */
export function normalizeCommand(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase()
}

/**
 * Read Slack's form-encoded command body.
 *
 * Returns null when the required fields are absent, which is how a request
 * that verified but is not a command delivery is told apart from one that is.
 */
export function parseCommandPayload(rawBody: string): SlackCommandPayload | null {
  const form = new URLSearchParams(rawBody)
  const command = normalizeCommand(form.get('command') ?? '')
  const teamId = (form.get('team_id') ?? '').trim()
  const slackUserId = (form.get('user_id') ?? '').trim()
  // response_url is what makes an answer possible at all — a command with no
  // way to reply is not worth starting a run for.
  const responseUrl = (form.get('response_url') ?? '').trim()
  if (!command || !teamId || !slackUserId || !responseUrl) return null

  return {
    teamId,
    command,
    text: (form.get('text') ?? '').trim(),
    slackUserId,
    channelId: (form.get('channel_id') ?? '').trim(),
    channelName: (form.get('channel_name') ?? '').trim(),
    responseUrl,
  }
}

/**
 * The `team_id` a form body claims, read WITHOUT committing to the rest of the
 * payload being well formed.
 *
 * The route needs this before it can choose a signing secret, i.e. before
 * anything in the body may be trusted. Kept separate from parseCommandPayload
 * so an unparseable-but-signed body cannot be mistaken for an unsigned one.
 */
export function teamIdFromCommandBody(rawBody: string): string | null {
  const teamId = new URLSearchParams(rawBody).get('team_id')?.trim()
  return teamId || null
}
