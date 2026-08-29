import { NextRequest, NextResponse } from 'next/server'
import { apiLogger } from '@/lib/logger'
import { verifySlackSignature } from '@/lib/activity/slack-verify'
import { findSlackWorkspaceByTeamId, resolveSigningSecretForOrg } from '@/lib/integrations/slack'
import { parseCommandPayload, teamIdFromCommandBody } from '@/lib/slack/command'
import { dispatchSlackCommand } from '@/lib/slack/command-dispatch'
import { clientIp, recordTokenRejection } from '@/lib/security/events'
import { readRequestTextLimited, RequestBodyError, requestBodyErrorResponse } from '@/lib/server/request-body'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'

/**
 * Slack slash-command receiver — the surface behind `/dealcheck`.
 *
 * A slash command is NOT an Events API delivery. The body is form-encoded, has
 * no envelope, and the reply goes to a one-shot `response_url` rather than a
 * channel. Only the signature scheme is shared, which is why this is its own
 * route rather than a branch in slack/events.
 *
 * ── The three-second rule shapes everything here ──────────────────────────────
 *
 * Slack shows the user a visible timeout error if this endpoint has not
 * responded in 3 seconds. An agent run takes far longer than that, so the run
 * is NEVER awaited: this handler verifies, acks, and starts the work
 * fire-and-forget. Everything after the ack — identity lookup, binding
 * resolution, failure reporting — reaches the user through `response_url`,
 * because by then nobody is reading the HTTP response.
 *
 * That also means the ack cannot say whether the command will succeed. It says
 * the request was received; the answer, or the reason there isn't one, arrives
 * separately. An ack that claimed success would be a lie roughly as often as an
 * agent's tools are misconfigured.
 *
 * ── No connection oracle ─────────────────────────────────────────────────────
 *
 * An unknown `team_id`, a workspace with no signing secret, and a signature
 * that fails to verify all return the SAME response. Splitting them would let
 * an attacker learn which Slack workspaces are connected to Backstory purely
 * from response text, which is the enumeration hole slack/events already closed
 * for events; the same reasoning applies verbatim here, including the rate
 * limit being keyed identically across all three so the 429 boundary is not an
 * oracle either.
 *
 * Unlike slack/events, this route DOES return 401 on a failed verification. The
 * two are not inconsistent: there, a 200 ack was needed so Slack's retry
 * machinery did not treat rejection as an outage and redeliver. A slash command
 * has no retry semantics to protect, and a real user is waiting — so a rejected
 * request says so rather than pretending it worked.
 */

const ADMISSION_LIMIT = { limit: 300, windowMs: 60_000, failureMode: 'closed' } as const
const REJECTED_LIMIT = { limit: 30, windowMs: 60_000, failureMode: 'closed' } as const
const SLACK_COMMAND_MAX_BODY_BYTES = 100_000

function tooMany(retryAfterMs?: number) {
  return NextResponse.json(
    { response_type: 'ephemeral', text: 'Too many requests right now — try again in a moment.' },
    { status: 429, headers: { 'retry-after': String(Math.ceil((retryAfterMs ?? 1_000) / 1_000)) } },
  )
}

/** The one response every unverifiable request gets, whatever made it unverifiable. */
function rejected() {
  return NextResponse.json(
    { response_type: 'ephemeral', text: 'This command could not be verified.' },
    { status: 401 },
  )
}

function ack(text: string) {
  // Ephemeral: the acknowledgement is for the person who typed the command.
  // The ANSWER goes in_channel later (see finishSlackCommand) — a shared deal
  // inspection is useful to the channel; "on it…" is not.
  return NextResponse.json({ response_type: 'ephemeral', text })
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const admitted = await rateLimit(`slack-commands:${ip}`, ADMISSION_LIMIT)
  if (!admitted.ok) return tooMany(admitted.retryAfterMs)

  // Raw bytes FIRST — the signature covers the exact bytes Slack signed, so
  // nothing may parse or re-encode the body before this read.
  let rawBody: string
  try {
    rawBody = await readRequestTextLimited(request, SLACK_COMMAND_MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyError) return requestBodyErrorResponse(error)
    throw error
  }

  const reject = async (reason: string) => {
    // Keyed identically for every rejection cause, so which branch fired is not
    // observable from where the 429 boundary falls.
    const allowed = await rateLimit(`slack-commands-rejected:${ip}`, REJECTED_LIMIT)
    if (!allowed.ok) return tooMany(allowed.retryAfterMs)
    await recordTokenRejection(request, { surface: 'slack-commands', reason })
    return rejected()
  }

  const teamId = teamIdFromCommandBody(rawBody)
  if (!teamId) return reject('missing_team_id')

  const credential = await findSlackWorkspaceByTeamId(teamId)
  if (!credential) {
    apiLogger.warn('slack command dropped — team_id matches no connected workspace', { teamId })
    return reject('unknown_team')
  }

  const signingSecret = await resolveSigningSecretForOrg(credential)
  if (!signingSecret) return reject('no_signing_secret')

  const verified = verifySlackSignature({
    signingSecret,
    timestampHeader: request.headers.get('x-slack-request-timestamp'),
    signatureHeader: request.headers.get('x-slack-signature'),
    rawBody,
    now: new Date(),
  })
  if (!verified) {
    // ERROR, not WARN: this IS a connected workspace, so a failed signature is
    // either a misconfigured secret or a forged request. Worth a human looking.
    apiLogger.error('slack command verification failed for a connected workspace', { teamId })
    return reject('invalid_signature')
  }

  const payload = parseCommandPayload(rawBody)
  if (!payload) {
    // Verified but not a command shape. Acked rather than 400'd: an authentic
    // delivery we do not recognise is our gap, not the caller's error.
    return ack('That command could not be read.')
  }

  // Slack's own id for this invocation. `trigger_id` is unique per invocation
  // and is what makes a retried delivery — Slack resends when it does not see
  // an ack — collide on the execution's idempotency key instead of starting a
  // second billed run.
  const invocationId = new URLSearchParams(rawBody).get('trigger_id')?.trim() || `${teamId}:${payload.slackUserId}:${Date.now()}`

  const organizationId = credential.organizationId
  // NOT awaited. Identity, binding and dispatch all happen after the ack and
  // report themselves through response_url.
  void dispatchSlackCommand({ organizationId, payload, invocationId }).catch((error) => {
    apiLogger.error('slack command dispatch failed', {
      organizationId,
      command: payload.command,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  return ack(`Working on /${payload.command}… the answer will appear here shortly.`)
}
