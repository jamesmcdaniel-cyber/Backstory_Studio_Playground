/**
 * Slack REST API integration
 *
 * Exposes one agent tool — post_message — that lets agents post messages to a
 * Slack channel during a run.
 *
 * Token resolution (per organization, see org-credential.ts):
 *  1. The workspace's own bot token from integration_secrets (provider 'slack').
 *  2. SLACK_BOT_TOKEN from the environment — reachable ONLY by internal/partner
 *     workspaces. A customer org without its own token does not get the tool.
 *
 * This used to read SLACK_BOT_TOKEN unconditionally, which meant every
 * workspace's agents posted into one Slack workspace with one bot identity —
 * org A's agent could read and write org B's channels.
 *
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { resolveOrgCredential, type ResolvedCredential } from './org-credential'
import { demoFetchOr } from '@/lib/demo/transport'
import { systemPrisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/crypto/secrets'
import { apiLogger } from '@/lib/logger'

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage'

export const SLACK_PROVIDER = 'slack'

// ---------------------------------------------------------------------------
// Per-org token resolution
// ---------------------------------------------------------------------------

export async function getSlackToken(organizationId: string): Promise<ResolvedCredential | null> {
  return resolveOrgCredential({
    organizationId,
    provider: SLACK_PROVIDER,
    envValue: process.env.SLACK_BOT_TOKEN,
  })
}

export async function slackConfigured(organizationId: string): Promise<boolean> {
  return Boolean(await getSlackToken(organizationId))
}

/** The workspace's own signing secret, or (internal/partner only) the env fallback. */
export async function getSlackSigningSecret(organizationId: string): Promise<ResolvedCredential | null> {
  return resolveOrgCredential({
    organizationId,
    provider: SLACK_PROVIDER,
    field: 'signingSecret',
    envValue: process.env.SLACK_SIGNING_SECRET,
    context: { consumer: 'integration.slack.events_receiver' },
  })
}

// ---------------------------------------------------------------------------
// Events API receiver: org resolution
// ---------------------------------------------------------------------------
//
// The Events API receiver (src/app/api/slack/events/route.ts) is the ONE
// place this integration crosses tenant boundaries on purpose: an inbound
// Slack delivery carries a `team_id`, not an organization id, so the
// receiver has to search across every workspace's saved Slack credential to
// find the one that owns it — hence `systemPrisma` (bypasses RLS) rather
// than the org-scoped `prisma` every other function in this file uses.

/** Everything the Events API receiver needs for one workspace's Slack credential. */
export interface SlackWorkspaceCredential {
  organizationId: string
  /** Decrypted signing secret, if this org has saved its own (see below for the env fallback). */
  ownSigningSecret: string | null
  /** The workspace's own posting identity — becomes `opts.botUserId` for `normalizeSlackEvent`. */
  botUserId: string | null
  teamId: string | null
}

function readSlackAuthConfig(authConfig: unknown): Record<string, unknown> {
  return authConfig && typeof authConfig === 'object' && !Array.isArray(authConfig) ? (authConfig as Record<string, unknown>) : {}
}

function toWorkspaceCredential(row: { organizationId: string; authConfig: unknown }): SlackWorkspaceCredential {
  const cfg = readSlackAuthConfig(row.authConfig)
  let ownSigningSecret: string | null = null
  if (typeof cfg.signingSecret === 'string') {
    try {
      ownSigningSecret = decryptSecret(cfg.signingSecret)
    } catch {
      // Undecryptable (rotated ENCRYPTION_KEY) — treat as absent, same
      // degrade-not-throw rule as readOrgSecret in org-credential.ts.
      ownSigningSecret = null
    }
  }
  return {
    organizationId: row.organizationId,
    ownSigningSecret,
    botUserId: typeof cfg.botUserId === 'string' ? cfg.botUserId : null,
    teamId: typeof cfg.teamId === 'string' ? cfg.teamId : null,
  }
}

/**
 * Every org whose ACTIVE Slack credential currently claims `teamId`, ordered
 * deterministically (`organizationId` ascending — arbitrary but stable, NOT
 * insertion order, which an unordered `findMany` does not guarantee across
 * calls). The credential-save path (see the credentials route) rejects a new
 * claim on a `team_id` another org already holds, so this should only ever
 * return 0 or 1 rows in practice; it still scans and reports every claimant
 * rather than assuming that, both because the guard postdates this code (an
 * older collision could already exist) and because a race between two
 * concurrent saves is not fully closed by an application-level check (see the
 * credentials route's own comment on that gap).
 */
async function claimantsForTeamId(teamId: string): Promise<{ organizationId: string; authConfig: unknown }[]> {
  const rows = await systemPrisma.integrationSecret.findMany({
    where: { provider: SLACK_PROVIDER, isActive: true },
    select: { organizationId: true, authConfig: true },
    orderBy: { organizationId: 'asc' },
  })
  return rows.filter((row) => toWorkspaceCredential(row).teamId === teamId)
}

/**
 * Resolve the organization that owns a Slack `team_id`, for an `event_callback`
 * delivery (which always carries one). There is no dedicated index for this —
 * the set of workspaces with a saved Slack credential is small, so a full
 * table scan filtered in application code is simpler and safer than trusting
 * a JSON-path query's semantics on an encrypted-blob column; revisit with a
 * dedicated column + index if this ever shows up as a hot path in practice.
 */
export async function findSlackWorkspaceByTeamId(teamId: string): Promise<SlackWorkspaceCredential | null> {
  if (!teamId) return null
  const claimants = await claimantsForTeamId(teamId)
  if (claimants.length > 1) {
    // Defense in depth: this should be unreachable once the credential-save
    // path's conflict check is in place, but if it ever IS reached (a
    // collision that predates the guard, or a race the guard didn't close),
    // every event for BOTH orgs silently routing to a nondeterministic
    // winner is exactly the failure mode that guard exists to prevent — so
    // this stays loud (error-level, Sentry-visible) rather than quietly
    // resolving to whichever row sorts first.
    apiLogger.error('slack team_id claimed by more than one organization', {
      teamId,
      organizationIds: claimants.map((row) => row.organizationId),
    })
  }
  return claimants.length > 0 ? toWorkspaceCredential(claimants[0]) : null
}

/**
 * Does any org OTHER than `excludeOrganizationId` already claim `teamId`?
 * Used by the credential-save path to reject a new claim on a `team_id`
 * another workspace already owns — without this, `findSlackWorkspaceByTeamId`
 * would silently pick ONE of the colliding orgs (see `claimantsForTeamId`)
 * with no error, no audit trail, and every event misrouted to whichever org
 * happened to sort first.
 *
 * This is a check-then-act, not a database constraint (there's no unique
 * index on `authConfig`'s `teamId` field — it lives inside an opaque JSON
 * blob), so two saves for the same never-before-seen `team_id` racing each
 * other could theoretically both pass this check before either commits. That
 * residual gap is exactly why `findSlackWorkspaceByTeamId` keeps its own
 * defense-in-depth logging above rather than trusting this guard alone.
 */
export async function findConflictingSlackOrg(teamId: string, excludeOrganizationId: string): Promise<string | null> {
  if (!teamId) return null
  const claimants = await claimantsForTeamId(teamId)
  const conflict = claimants.find((row) => row.organizationId !== excludeOrganizationId)
  return conflict?.organizationId ?? null
}

/**
 * Every active Slack credential in the system, for the ONE case that carries
 * no `team_id` to look up by: the `url_verification` handshake Slack sends
 * when a workspace's Events API request URL is first saved. That request
 * proves control of an app's endpoint, not an authenticated action on an
 * org's data, so verifying its signature against whichever configured
 * workspace's secret matches (rather than a pre-resolved org) is enough to
 * gate the echo — no ActivityEvent or outbox row is ever written from it.
 *
 * `limit`, when given, caps how many rows are fetched (ordered the same
 * deterministic way as `claimantsForTeamId`) — see the route's own comment on
 * why an unauthenticated caller must not be able to force an unbounded number
 * of HMAC computations per request.
 */
export async function allSlackWorkspaceCredentials(limit?: number): Promise<SlackWorkspaceCredential[]> {
  const rows = await systemPrisma.integrationSecret.findMany({
    where: { provider: SLACK_PROVIDER, isActive: true },
    select: { organizationId: true, authConfig: true },
    orderBy: { organizationId: 'asc' },
    ...(limit != null ? { take: limit } : {}),
  })
  return rows.map(toWorkspaceCredential)
}

/**
 * The signing secret to verify an already-resolved organization's Slack
 * delivery with: its own saved secret, else the env fallback IF this org's
 * kind is permitted to use it (internal/partner — see org-credential.ts).
 * Only reachable once `findSlackWorkspaceByTeamId` has already named the org;
 * this does not itself resolve org from `team_id`.
 */
export async function resolveSigningSecretForOrg(credential: SlackWorkspaceCredential): Promise<string | null> {
  if (credential.ownSigningSecret) return credential.ownSigningSecret
  const envSecret = process.env.SLACK_SIGNING_SECRET
  if (!envSecret) return null
  const resolved = await getSlackSigningSecret(credential.organizationId)
  return resolved?.value ?? null
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function slackTools(): ToolDefinition[] {
  return [
    {
      name: 'post_message',
      description:
        'Post a message to a Slack channel. `channel` is a channel id or name (e.g. "#revenue" or "C012AB3CD"); `text` supports Slack mrkdwn.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['channel', 'text'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// SlackToolClient
// ---------------------------------------------------------------------------

export class SlackToolClient {
  // The resolved per-org token is injected at construction (see getSlackToken),
  // exactly like GranolaToolClient, so tool execution never reads global state —
  // which is what made the token workspace-agnostic in the first place.
  constructor(private readonly token: string) {}

  // Satisfies the McpToolClient interface in execute-agent.ts:
  //   executeTool(serverUrl, name, args): Promise<any>
  // Returns the parsed JSON object directly — the same shape as
  // GranolaToolClient.executeTool, so the run loop's JSON.stringify(result)
  // wrapping is identical for all integrations.
  async executeTool(
    _serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const token = this.token
    if (!token) throw new Error('Slack bot token is not configured')

    if (name === 'post_message') {
      const response = await demoFetchOr('slack', () => fetch(SLACK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: args.channel,
          text: args.text,
        }),
        signal: AbortSignal.timeout(30_000),
      }))

      // Slack always returns HTTP 200 even on failure; we must inspect body.ok
      const body = (await response.json()) as Record<string, unknown>
      if (body.ok !== true) {
        throw new Error(`Slack API error: ${body.error ?? 'unknown'}`)
      }

      return body
    }

    throw new Error(`Unknown Slack tool: ${name}`)
  }
}
