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
  'invitations/lookup',                   // pre-auth: resolves an invite token
  'health',                               // public liveness probe
  'peopleai/callback',                    // OAuth redirect, validated by state
  // Session-only by design: the wrapper's entitlement gate would 403 exactly
  // the users who need this page to tell them they are not yet entitled.
  'peopleai/status',
  'mcp-connections/oauth/callback',       // OAuth redirect, validated by state
  'flows/[id]/trigger',                   // per-flow trigger token
  'flows/[id]/runs/[runId]/resume',       // per-run resume token
  'signals/people-ai',                    // HMAC-signed webhook
  'nango/webhook',                        // HMAC-signed webhook
  'agents/[id]/trigger',                  // per-agent trigger token
  'scim/v2/Users',                        // SCIM bearer token
  'scim/v2/Users/[id]',                   // SCIM bearer token
]
