/**
 * Route files that deliberately do NOT go through withAuthenticatedApi.
 *
 * Each is unauthenticated or authenticated by another mechanism (a cron
 * secret, an OAuth callback's state parameter, an HMAC-signed webhook, or a
 * per-resource trigger token). Adding to this list is a security decision, so
 * the coverage test fails when a new bypass appears without being declared
 * here — silence is what let bypasses accumulate unnoticed before.
 */
export const UNGATED_ROUTES: readonly string[] = [
  'cron/retention',                       // CRON_SECRET header
  'cron/dispatch',                        // CRON_SECRET header
  'cron/queue-watch',                     // CRON_SECRET header
  'cron/indexer-sweep',                   // CRON_SECRET header
  'cron/adoption-rollup',                 // CRON_SECRET header
  'invitations/lookup',                   // pre-auth: resolves an invite token
  // The OAuth client-credentials token endpoint. It cannot sit behind
  // authentication because it IS the authentication step — it takes a client
  // id + secret and returns a short-lived access token. Self-authenticating:
  // constant-time secret comparison, one uniform invalid_client response so it
  // cannot be used to enumerate client ids, IP rate limiting that fails closed.
  'v1/token',
  'health',                               // public liveness probe
  // Browsers post CSP violation reports with no credentials, and a violation can
  // fire on a page whose session is what broke. Treated as untrusted anonymous
  // input: rate limited, size capped, never echoed.
  'csp-report',
  'peopleai/callback',                    // OAuth redirect, validated by state
  // Session-only by design: the wrapper's entitlement gate would 403 exactly
  // the users who need this page to tell them they are not yet entitled.
  'peopleai/status',
  'mcp-connections/oauth/callback',       // OAuth redirect, validated by state
  'slack/oauth/callback',                 // OAuth redirect, validated by the encrypted state cookie
  'flows/[id]/trigger',                   // per-flow trigger token
  'forms/[id]/submit',                    // public hosted form; published-form gate + per-flow/IP rate limit + bounded body
  'flows/[id]/runs/[runId]/resume',       // per-run resume token
  'flows/[id]/runs/[runId]/webhook-result', // per-flow trigger token; bounded result polling
  'signals/people-ai',                    // HMAC-signed webhook
  'nango/webhook',                        // HMAC-signed webhook
  'slack/events',                         // HMAC-signed webhook (per-workspace Slack signing secret)
  'agents/[id]/trigger',                  // per-agent trigger token
  'scim/v2/Users',                        // SCIM bearer token
  'scim/v2/Users/[id]',                   // SCIM bearer token
  'scim/v2/Groups',                       // SCIM bearer token
  'scim/v2/Groups/[id]',                  // SCIM bearer token
  'v1/flows',                             // workspace API key
  'v1/flows/[id]',                        // workspace API key
  'v1/flows/[id]/run',                    // workspace API key
  'mcp',                                  // workspace API key (MCP server; same admission as v1)
]
