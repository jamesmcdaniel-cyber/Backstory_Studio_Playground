/**
 * The documented skips for mutating-route-smoke.test.ts, kept in their own
 * module so the smoke file stays clear of the tsx test-file size cliff. The
 * completeness and honesty tests that read this list live in that file.
 */

/**
 * Handlers deliberately not invoked here, each with the reason. Anything not
 * in `cases` and not listed here fails the completeness test below.
 *
 * Every rationale must take ONE of two forms, and the honesty test at the
 * bottom enforces it mechanically:
 *
 *   'covered by <repo-relative test file>[ — note]'
 *       The named file must exist, must import THIS route's module, and must
 *       name THIS method. Anything less is a claim, not coverage.
 *
 *   'no coverage: <reason>'
 *       An admission. Perfectly allowed — a handler that dials a live model or
 *       a live third party may genuinely not be reachable from here — but it
 *       has to READ as the gap it is, so nobody mistakes it for tested code.
 *
 * The grammar exists because the loose prose it replaced was wrong in a way
 * nobody could see. 'covered by the flows execution tests' guarded
 * flows/[id]/execute — whose free-tier ceiling lives in the ROUTE, while those
 * tests call startFlowExecution directly. Deleting the ceiling was a green
 * build. The same was true of the agent-run and Nango-integration ceilings, and
 * of both privacy deletion routes, which cited 'privacy service tests' against
 * a src/lib/privacy/delete.ts that no test imported at all.
 */
export const SKIPS: Record<string, string> = {
  'share/artifacts/[token]/copilot:POST': 'covered by src/lib/artifacts/__tests__/guest-copilot.db.test.ts — a public route (no session to install); open and ask are driven there through POST with the visitor cookie',
  'slack/commands:POST': 'covered by src/app/api/slack/commands/__tests__/route.db.test.ts — the handler needs a real HMAC over the exact raw body, which the shared JSON smoke fixture cannot produce',
  'demo/enter:POST': 'covered by src/lib/demo/__tests__/session.db.test.ts — enter clones a whole workspace, which the smoke fixture is not shaped for',
  'demo/exit:POST': 'covered by src/lib/demo/__tests__/session.db.test.ts — exit tears down the demo org created there',
  'v1/agents/executions/[id]/reply:POST': 'covered by src/lib/agents/external/__tests__/external-agents.db.test.ts — an external agent\'s key plus a live single-use reply token, which only a dispatched run can mint; wrong/reused/expired tokens and the completed run are asserted there',
  'v1/agents/executions/[id]/progress:POST': 'covered by src/lib/agents/external/__tests__/external-agents.db.test.ts — same two credentials as a reply; the narrated progress line is asserted there',
  'v1/token:POST': 'no coverage: the client-credentials grant is exercised as a service (client-credentials.db.test.ts), but this route wrapper is never invoked',
  'agents/[id]/execute:POST': 'covered by src/app/api/__tests__/free-tier-enforcement.db.test.ts — the daily-run ceiling, with the queue seam stubbed off',
  'agents/[id]/chat:POST': 'no coverage: streams a live model turn',
  'agents/[id]/runs/[runId]:POST': 'no coverage: resumes a run against a live model',
  'agents/[id]/trigger:POST': 'no coverage: per-agent trigger secret — flows/__tests__/trigger-secret.db.test.ts covers the FLOW route, not this one',
  'agents/draft:POST': 'no coverage: drafts an agent with a live model',
  'agents/role-labels:POST': 'no coverage: generates role labels with a live model',
  'chat:POST': 'no coverage: live model turn',
  'librarian:POST': 'no coverage: live model turn',
  'flows/copilot:POST': 'no coverage: live model turn',
  'flows/copilot/chat:POST': 'no coverage: live model turn',
  'flows/code-assist:POST': 'no coverage: live model turn',
  'flow-templates/draft-notes:POST': 'no coverage: live model turn',
  'integrations/ai-search:POST': 'no coverage: live model turn',
  'templates/ai-search:POST': 'no coverage: live model turn',
  'playbooks/salesai-upsell:POST': 'no coverage: live model turn against People.ai',
  'flows/[id]/execute:POST': 'covered by src/app/api/__tests__/free-tier-enforcement.db.test.ts — the daily-run ceiling, with the queue seam stubbed off',
  'flows/[id]/runs/[runId]/resume:POST': 'covered by src/app/api/flows/__tests__/resume-callback.db.test.ts',
  'flows/[id]/trigger:POST': 'covered by src/app/api/flows/__tests__/trigger-route.db.test.ts',
  'flows/[id]/huddle/segment:POST': 'no coverage: multipart audio upload to a transcription provider',
  'flows/signals/[name]:POST': 'no coverage: signal fan-out — features/flows/__tests__/signals.test.ts covers the matching rules, not this route',
  'signals/people-ai:POST': 'covered by src/app/api/signals/people-ai/__tests__/receiver.test.ts',
  'nango/webhook:POST': 'no coverage: Nango-signed external webhook',
  'slack/events:POST': 'no coverage: Slack-signed external webhook — own coverage: src/app/api/slack/events/__tests__/route.db.test.ts',
  'nango/session-token:POST': 'covered by src/app/api/__tests__/free-tier-enforcement.db.test.ts — the integration ceiling, against a fake Nango on localhost',
  'nango/connections/[integrationId]/verify:POST': 'no coverage: calls Nango live',
  'integrations/granola/test:POST': 'no coverage: calls Granola live',
  'mcp-connections/discover:POST': 'no coverage: probes a live MCP server',
  'mcp-connections/test:POST': 'no coverage: probes a live MCP server',
  'scim/v2/Users:POST': 'no coverage: SCIM bearer-token provisioning — src/lib/scim/server.ts is imported by no test',
  'scim/v2/Users/[id]:PATCH': 'no coverage: SCIM bearer-token provisioning — src/lib/scim/server.ts is imported by no test',
  'scim/v2/Users/[id]:DELETE': 'no coverage: SCIM bearer-token provisioning — src/lib/scim/server.ts is imported by no test',
  'scim/v2/Groups/[id]:PATCH': 'no coverage: SCIM group membership — src/lib/scim/server.ts is imported by no test',
  'api-keys:POST': 'no coverage: returns a one-time plaintext credential — src/lib/public-api/auth.ts is imported by no test',
  'api-keys:DELETE': 'no coverage: credential lifecycle — src/lib/public-api/auth.ts is imported by no test',
  'flows/import:POST': 'covered by src/app/api/flows/__tests__/import-route.db.test.ts',
  'privacy/account:DELETE': 'covered by src/app/api/__tests__/privacy-delete.db.test.ts — the confirmation gate plus the owner and last-owner refusals',
  'privacy/workspace:DELETE': 'covered by src/app/api/__tests__/privacy-delete.db.test.ts — the confirmation gate',
  'v1/flows:POST': 'no coverage: API-key-authenticated import — private-flow-visibility.db.test.ts invokes GET on this module, never POST',
  'v1/flows/[id]:PUT': 'covered by src/app/api/flows/__tests__/private-flow-visibility.db.test.ts',
  'v1/flows/[id]:DELETE': 'covered by src/app/api/flows/__tests__/private-flow-visibility.db.test.ts',
  'v1/flows/[id]/run:POST': 'no coverage: API-key-authenticated live flow execution',
  'mcp:POST': 'no coverage: API-key-authenticated MCP server — the protocol layer it dispatches through is covered by src/lib/mcp/server/__tests__/',
  'organizations/domains:POST': 'no coverage: starts a DNS TXT challenge — admin/__tests__/domains-route.db.test.ts covers the PLATFORM domain route, not this one',
  'organizations/domains:DELETE': 'no coverage: domain lifecycle — admin/__tests__/domains-route.db.test.ts covers the PLATFORM domain route, not this one',
  'organizations/domains/[id]/verify:POST': 'no coverage: resolves live DNS to check the TXT challenge',
  'organizations/scim-tokens:POST': 'no coverage: returns a one-time plaintext bearer token, and no test invokes this route',
  'organizations/scim-tokens:DELETE': 'no coverage: SCIM token lifecycle, and no test invokes this route',
  'organizations/security:PATCH': 'no coverage: changes MFA/SSO enforcement, and no test invokes this route',
  'organizations/ai-policy:PATCH': 'covered by src/app/api/organizations/ai-policy/__tests__/route.test.ts',
  // Self-service factor removal. Not invocable from here: it lists and deletes
  // through the Supabase service-role admin API, which is unreachable in a test
  // run — the cited file drives that through its production-inert seam, so the
  // route's own guards (not a stub of them) are what it exercises.
  'auth/mfa/factors:DELETE': 'covered by src/app/api/auth/__tests__/mfa-factors-route.db.test.ts — both refusals (STEP_UP_REQUIRED, LAST_FACTOR) plus the audited removal',
  // Reviewer-only, like the catalogue routes: the smoke org holds no
  // catalogue.review permission, so invoking them from HERE would only ever
  // produce a 403 that never reaches the handler body. They are driven from a
  // reviewer fixture instead. The security-critical logic (domain
  // normalization, the public-provider blocklist) is additionally unit-tested
  // in src/lib/auth/__tests__/allowed-domain.test.ts.
  'admin/domains:POST': 'covered by src/app/api/admin/__tests__/domains-route.db.test.ts',
  'admin/domains:PATCH': 'covered by src/app/api/admin/__tests__/domains-route.db.test.ts',
  // Operator-only, and every branch acts on someone else's account.
  'admin/users/[id]/actions:POST': 'covered by src/app/api/admin/__tests__/users-route.db.test.ts',
  // Operator-only bench trigger: the smoke org holds no platform.administer,
  // so invoking it here would only ever produce a 403 — and its body wants a
  // Redis queue. The customer-edition 404 and permission gate are covered by
  // edition-gates.test.ts + the platform-administer route walk.
  'admin/models/bench:POST': 'covered by src/app/api/__tests__/edition-gates.test.ts',
  // Operator-only backfill trigger, same posture as bench above: needs a
  // live Redis queue in queue mode, and the smoke org holds no
  // platform.administer. The customer-edition 404 is covered by
  // edition-gates.test.ts; core persistence/idempotency/cap behavior is
  // covered by src/lib/activity/__tests__/backfill.db.test.ts.
  'admin/activity/backfill:POST': 'covered by src/app/api/__tests__/edition-gates.test.ts',
  // Operator-only, and its body needs a live Redis rather than a database: the
  // smoke org holds no platform.administer, so invoking it here would only
  // ever produce a 403. The gate is covered in
  // src/app/api/admin/queue/__tests__/dead-letters-route.test.ts and the
  // handler's operations in src/lib/queue/__tests__/dead-letter-admin*.test.ts
  // (including a real Redis round-trip behind TEST_REDIS_URL).
  'admin/queue/dead-letters:POST': 'covered by src/app/api/admin/queue/__tests__/dead-letters-route.test.ts (gate) + src/lib/queue/__tests__/dead-letter-admin.test.ts (operations)',
  // Direct-to-storage uploads need Supabase Storage, which the smoke env
  // does not have: both routes answer 501 DIRECT_UPLOAD_UNAVAILABLE before
  // touching anything (the browser then falls back to multipart). Same
  // posture as the Nango routes' 503. The storage layer they call is covered
  // in src/lib/files/__tests__.
  'files/upload-url:POST': 'no coverage: needs SUPABASE_SERVICE_ROLE_KEY — answers 501 DIRECT_UPLOAD_UNAVAILABLE before any storage call; the storage helpers it wraps are unit-tested',
  'files/[id]/complete:POST': 'no coverage: needs SUPABASE_SERVICE_ROLE_KEY — answers 501 DIRECT_UPLOAD_UNAVAILABLE before any storage call; the storage helpers it wraps are unit-tested',
}
