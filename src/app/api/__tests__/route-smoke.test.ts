import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NextRequest } from 'next/server'

// ── Static route-auth guards ──────────────────────────────────────────────
//
// These read the route tree as SOURCE and need no database, so they sit outside
// the TEST_DB block below: they are the check that a new unauthenticated route
// cannot ship, and a guard that only runs in CI-mode is not running on the gate
// most edits are made against.

const staticApiDir = fileURLToPath(new URL('..', import.meta.url))

const walkRouteFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkRouteFiles(full))
    else if (entry.name === 'route.ts') out.push(full)
  }
  return out
}

const routeNames = () =>
  walkRouteFiles(staticApiDir).map((file) => ({
    route: path.relative(staticApiDir, path.dirname(file)),
    source: readFileSync(file, 'utf8'),
  }))

// POST/PUT/PATCH/DELETE handlers that authenticate by signature/secret/bearer/
// OAuth state instead of a session — each vetted in a security audit.
const mutatingExempt = new Set([
  // The token endpoint IS the authentication step, so it cannot sit behind
  // authentication. It authenticates the caller itself: constant-time client
  // secret comparison, one uniform invalid_client answer so it cannot be used
  // to enumerate client ids, and IP rate limiting that fails closed.
  'v1/token',
  // CSP violation reports: browsers post these with no credentials, and a
  // violation can fire on a page whose session is exactly what broke. Carries no
  // authority — it only writes a log line — and is rate limited fail-closed per
  // client, size capped, and never echoes input back.
  'csp-report',
  'nango/webhook',       // Nango webhook signature (verifyIncomingWebhookRequest)
  'flows/[id]/trigger',  // per-flow webhook secret (constant-time)
  'agents/[id]/trigger', // per-agent trigger secret (constant-time)
  'cron/dispatch',       // CRON_SECRET, fail-closed
  'cron/retention',      // CRON_SECRET, fail-closed
  'signals/people-ai',   // People.ai HMAC signature, verified against the TARGET org's secret
  'flows/[id]/runs/[runId]/resume', // wait-node webhook callback: hashed resume token is the capability (never the run id), consumed atomically
  // SCIM 2.0 provisioning: every handler calls authenticateScim(request),
  // which validates a hashed bearer ScimToken and resolves the org from it.
  'scim/v2/Users',
  'scim/v2/Users/[id]',
  'scim/v2/Groups/[id]',
  // Public API: every handler calls authenticatePublicApi(request, scope),
  // which validates a hashed ApiKey and enforces a per-route scope.
  'v1/flows',
  'v1/flows/[id]',
  'v1/flows/[id]/run',
])

// GET handlers that are deliberately not wrapped in withAuthenticatedApi. Reads
// were previously unchecked here, which left the read half of the surface to
// convention — a new unauthenticated GET could disclose tenant data unnoticed.
const readExempt = new Set([
  'health',                         // public readiness probe: no tenant data
  'invitations/lookup',             // public invite preview: token length clamped + fail-closed per-client budget
  'cron/dispatch',                  // CRON_SECRET, fail-closed
  'cron/retention',                 // CRON_SECRET, fail-closed
  'mcp-connections/oauth/callback', // OAuth state/PKCE cookie minted by the authenticated start route
  'peopleai/callback',              // authenticated-encryption state cookie, bound to user + org
  // Session-authenticated, but deliberately NOT through withAuthenticatedApi:
  // both must answer for a user who has not yet cleared the entitlement /
  // Backstory MCP gates, since resolving that is what these two surfaces are
  // FOR. Each calls getAuthWithUser() and 401s (or bounces) without a session.
  'peopleai/status',
  'peopleai/connect',
  // Hashed bearer credentials that resolve the tenant from the token itself.
  'scim/v2/Users',
  'scim/v2/Users/[id]',
  'scim/v2/Groups',
  'scim/v2/Groups/[id]',
  'v1/flows',
  'v1/flows/[id]',
])

test('every mutating route is authenticated or an allowlisted signature/secret route', () => {
  const offenders: string[] = []
  for (const { route, source } of routeNames()) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      if (!new RegExp(`export (const ${method}\\b|async function ${method}\\b)`).test(source)) continue
      const authed = new RegExp(`export const ${method} = withAuthenticatedApi`).test(source)
      if (!authed && !mutatingExempt.has(route)) offenders.push(`${route}:${method}`)
    }
  }
  assert.deepEqual(
    offenders.sort(),
    [],
    `Unauthenticated mutating route(s): ${offenders.join(', ')}. Wrap in withAuthenticatedApi, or add to mutatingExempt with justification.`,
  )
})

test('every GET route is authenticated or an allowlisted public/secret route', () => {
  const offenders: string[] = []
  for (const { route, source } of routeNames()) {
    if (!/export (const GET\b|async function GET\b)/.test(source)) continue
    if (/export const GET = withAuthenticatedApi/.test(source)) continue
    if (!readExempt.has(route)) offenders.push(route)
  }
  assert.deepEqual(
    offenders.sort(),
    [],
    `Unauthenticated GET route(s): ${offenders.join(', ')}. Wrap in withAuthenticatedApi, or add to readExempt with a justification comment.`,
  )
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off' // seam skips gates anyway; belt-and-suspenders

  let prisma: any
  let seeded: any
  let agentId: string
  let flowId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const agent = await prisma.agentTask.create({
      data: { description: 'a', objective: 'o', status: 'ACTIVE', agentType: 'assistant', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    agentId = agent.id
    const flow = await prisma.flow.create({
      data: { name: 'Smoke flow', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    flowId = flow.id
  })

  after(async () => {
    // Guard: if before() threw (seed failure), seeded is undefined — don't
    // throw a secondary error over the real one.
    if (seeded) await seeded.cleanup()
  })

  const req = (path: string) => new NextRequest(new URL(`http://test${path}`))

  // (handler import, request) — every authenticated GET route that doesn't
  // need a request body or a live external call (see report for skips).
  const cases: Array<{ name: string; run: () => Promise<Response> }> = [
    { name: 'GET /api/agent-templates', run: async () => (await import('../agent-templates/route')).GET(req('/api/agent-templates')) },
    { name: 'GET /api/notifications', run: async () => (await import('../notifications/route')).GET(req('/api/notifications')) },
    { name: 'GET /api/snapshot', run: async () => (await import('../snapshot/route')).GET(req('/api/snapshot')) },
    { name: 'GET /api/template-proposals', run: async () => (await import('../template-proposals/route')).GET(req('/api/template-proposals')) },
    { name: 'GET /api/flows', run: async () => (await import('../flows/route')).GET(req('/api/flows')) },
    { name: 'GET /api/flows/runs', run: async () => (await import('../flows/runs/route')).GET(req('/api/flows/runs')) },
    { name: 'GET /api/flows/[id]/collaborators', run: async () => (await import('../flows/[id]/collaborators/route')).GET(req(`/api/flows/${flowId}/collaborators`)) },
    { name: 'GET /api/flow-templates', run: async () => (await import('../flow-templates/route')).GET(req('/api/flow-templates')) },
    { name: 'GET /api/catalogue/submissions', run: async () => (await import('../catalogue/submissions/route')).GET(req('/api/catalogue/submissions')) },
    // A built-in id: resolvable in any org with no seeded row behind it.
    { name: 'GET /api/flow-templates/[id]', run: async () => (await import('../flow-templates/[id]/route')).GET(req('/api/flow-templates/summarize-extract')) },
    // 404s for a built-in id (no stored row) — smoke only asserts < 500.
    { name: 'GET /api/flow-templates/[id]/versions', run: async () => (await import('../flow-templates/[id]/versions/route')).GET(req('/api/flow-templates/summarize-extract/versions')) },
    { name: 'GET /api/agents', run: async () => (await import('../agents/route')).GET(req('/api/agents')) },
    { name: 'GET /api/agents/activity', run: async () => (await import('../agents/activity/route')).GET(req('/api/agents/activity')) },
    { name: 'GET /api/workspace-folders', run: async () => (await import('../workspace-folders/route')).GET(req('/api/workspace-folders')) },
    { name: 'GET /api/approvals', run: async () => (await import('../approvals/route')).GET(req('/api/approvals')) },
    { name: 'GET /api/audit/export', run: async () => (await import('../audit/export/route')).GET(req('/api/audit/export')) },
    { name: 'GET /api/auth/context', run: async () => (await import('../auth/context/route')).GET(req('/api/auth/context')) },
    { name: 'GET /api/flows/tool-catalog', run: async () => (await import('../flows/tool-catalog/route')).GET(req('/api/flows/tool-catalog')) },
    { name: 'GET /api/http-credentials', run: async () => (await import('../http-credentials/route')).GET(req('/api/http-credentials')) },
    { name: 'GET /api/flows/huddle-ice', run: async () => (await import('../flows/huddle-ice/route')).GET(req('/api/flows/huddle-ice')) },
    { name: 'GET /api/flows/[id]/huddle/notes', run: async () => (await import('../flows/[id]/huddle/notes/route')).GET(req(`/api/flows/${flowId}/huddle/notes`)) },
    { name: 'GET /api/granola/notes', run: async () => (await import('../granola/notes/route')).GET(req('/api/granola/notes')) },
    { name: 'GET /api/integrations/available', run: async () => (await import('../integrations/available/route')).GET(req('/api/integrations/available')) },
    { name: 'GET /api/integrations/count', run: async () => (await import('../integrations/count/route')).GET(req('/api/integrations/count')) },
    { name: 'GET /api/integrations/granola', run: async () => (await import('../integrations/granola/route')).GET(req('/api/integrations/granola')) },
    // Dynamic [provider] segment: the handler reads the provider off the path,
    // so the request URL is what selects it — exercise a real one.
    { name: 'GET /api/integrations/credentials/[provider]', run: async () => (await import('../integrations/credentials/[provider]/route')).GET(req('/api/integrations/credentials/slack')) },
    { name: 'GET /api/mcp-connections', run: async () => (await import('../mcp-connections/route')).GET(req('/api/mcp-connections')) },
    // 404s for an unknown connection id (no row, so no server is contacted) —
    // smoke only asserts < 500.
    { name: 'GET /api/mcp-connections/[id]/tools', run: async () => (await import('../mcp-connections/[id]/tools/route')).GET(req('/api/mcp-connections/nonexistent/tools')) },
    { name: 'GET /api/mcp-connections/oauth/start', run: async () => (await import('../mcp-connections/oauth/start/route')).GET(req('/api/mcp-connections/oauth/start')) },
    { name: 'GET /api/organizations/members', run: async () => (await import('../organizations/members/route')).GET(req('/api/organizations/members')) },
    { name: 'GET /api/quarantine', run: async () => (await import('../quarantine/route')).GET(req('/api/quarantine')) },
    { name: 'GET /api/organizations/invitations', run: async () => (await import('../organizations/invitations/route')).GET(req('/api/organizations/invitations')) },
    // nango/integrations, nango/status: skipped — no NANGO_SECRET_KEY in the
    // test env, so both deliberately throw a 503 ApiError (NANGO_UNAVAILABLE)
    // before any network call. Correct behavior, but 503 >= 500 trips this
    // suite's strict <500 threshold; this is the "needs an external service"
    // skip category, not a guard/logic bug.
    { name: 'GET /api/organizations', run: async () => (await import('../organizations/route')).GET(req('/api/organizations')) },
    { name: 'GET /api/peopleai/webhook-secret', run: async () => (await import('../peopleai/webhook-secret/route')).GET(req('/api/peopleai/webhook-secret')) },
    { name: 'GET /api/push/key', run: async () => (await import('../push/key/route')).GET(req('/api/push/key')) },
    { name: 'GET /api/search', run: async () => (await import('../search/route')).GET(req('/api/search?q=smoke')) },
    { name: 'GET /api/setup/status', run: async () => (await import('../setup/status/route')).GET(req('/api/setup/status')) },
    { name: 'GET /api/signal-subscriptions', run: async () => (await import('../signal-subscriptions/route')).GET(req('/api/signal-subscriptions')) },
    { name: 'GET /api/signals', run: async () => (await import('../signals/route')).GET(req('/api/signals')) },
    { name: 'GET /api/signals/custom', run: async () => (await import('../signals/custom/route')).GET(req('/api/signals/custom')) },
    { name: 'GET /api/skills', run: async () => (await import('../skills/route')).GET(req('/api/skills')) },
    { name: 'GET /api/usage', run: async () => (await import('../usage/route')).GET(req('/api/usage')) },
    { name: 'GET /api/workflows/executions', run: async () => (await import('../workflows/executions/route')).GET(req('/api/workflows/executions')) },
    // Dynamic [id] routes — real seeded ids.
    { name: 'GET /api/agents/[id]/knowledge', run: async () => (await import('../agents/[id]/knowledge/route')).GET(req(`/api/agents/${agentId}/knowledge`)) },
    { name: 'GET /api/agents/[id]/memories', run: async () => (await import('../agents/[id]/memories/route')).GET(req(`/api/agents/${agentId}/memories`)) },
    // granola/notes/[id]: skipped — with no Granola key configured for the
    // seeded org, the route deliberately throws a 503 ApiError
    // (INTEGRATION_UNAVAILABLE) before touching the network. Same
    // "needs an external service" skip category as the Nango routes above.
    { name: 'GET /api/flows/[id]', run: async () => (await import('../flows/[id]/route')).GET(req(`/api/flows/${flowId}`)) },
    { name: 'GET /api/flows/[id]/runs', run: async () => (await import('../flows/[id]/runs/route')).GET(req(`/api/flows/${flowId}/runs`)) },
    { name: 'GET /api/flows/[id]/versions', run: async () => (await import('../flows/[id]/versions/route')).GET(req(`/api/flows/${flowId}/versions`)) },
    { name: 'GET /api/flows/[id]/trigger-secret', run: async () => (await import('../flows/[id]/trigger-secret/route')).GET(req(`/api/flows/${flowId}/trigger-secret`)) },
    { name: 'GET /api/files/[id]', run: async () => (await import('../files/[id]/route')).GET(req('/api/files/nonexistent')) },
    // Incident regressions: these 500'd under the tenant guard before the sweep.
    { name: 'GET /api/agents/[id]/chat/sessions', run: async () => (await import('../agents/[id]/chat/sessions/route')).GET(req(`/api/agents/${agentId}/chat/sessions`)) },
    { name: 'GET /api/agents/[id]/chat', run: async () => (await import('../agents/[id]/chat/route')).GET(req(`/api/agents/${agentId}/chat`)) },
    { name: 'GET /api/api-keys', run: async () => (await import('../api-keys/route')).GET(req('/api/api-keys')) },
    { name: 'GET /api/flows/[id]/export', run: async () => (await import('../flows/[id]/export/route')).GET(req(`/api/flows/${flowId}/export`)) },
    { name: 'GET /api/organizations/scim-tokens', run: async () => (await import('../organizations/scim-tokens/route')).GET(req('/api/organizations/scim-tokens')) },
    { name: 'GET /api/organizations/security', run: async () => (await import('../organizations/security/route')).GET(req('/api/organizations/security')) },
    { name: 'GET /api/privacy/export', run: async () => (await import('../privacy/export/route')).GET(req('/api/privacy/export')) },
  ]

  for (const c of cases) {
    test(`${c.name} does not 500`, async () => {
      const res = await c.run()
      assert.ok(res.status < 500, `${c.name} returned ${res.status}: ${await res.clone().text().catch(() => '')}`)
    })
  }

  // Seam sentinel: one authed route asserted to 200. The reachability loop
  // above tolerates 401/403/404, so a silently-inactive test-auth seam (every
  // route real-authing to 401) would still pass it — this is the tripwire
  // that makes that failure mode loud instead.
  test('the test-auth seam is actually active (sentinel route returns 200)', async () => {
    const res = await (await import('../flows/route')).GET(req('/api/flows'))
    assert.equal(res.status, 200, `GET /api/flows returned ${res.status} — the injected auth context is not reaching the routes`)
  })

  // Routes deliberately not invoked, with the reason. A withAuthenticatedApi
  // GET route absent from BOTH `cases` and this list fails the completeness
  // test below — so a newly-added route can't silently ship untested (the
  // exact blind spot behind the 2026-07-10 tenant-guard incident).
  const skipped: Array<{ route: string; reason: string }> = [
    { route: 'nango/integrations', reason: 'needs NANGO_SECRET_KEY — throws 503 before any network call' },
    { route: 'nango/status', reason: 'needs NANGO_SECRET_KEY — throws 503 before any network call' },
    { route: 'granola/notes/[id]', reason: 'needs a Granola key — throws 503 before any network call' },
    // The seeded smoke org is a customer workspace, so it holds no
    // catalogue.review permission and this route correctly 403s. Reviewer
    // behavior is covered against a real internal org in
    // src/app/api/catalogue/__tests__/review.db.test.ts.
    { route: 'catalogue/review', reason: 'reviewer-only — 403 for the smoke org by design' },
    { route: 'catalogue/entries', reason: 'reviewer-only — 403 for the smoke org by design' },
    { route: 'catalogue/staff', reason: 'reviewer-only — 403 for the smoke org by design' },
    { route: 'admin/domains', reason: 'reviewer-only — 403 for the smoke org by design' },
    { route: 'admin/costs', reason: 'reviewer-only — 403 for the smoke org by design' },
    // Operator-only, so the smoke org gets a 403 by design. Covered instead by
    // admin/__tests__/users-route.db.test.ts, which seeds a real operator.
    { route: 'admin/users', reason: 'operator-only — 403 for the smoke org by design' },
  ]

  // Completeness self-check: enumerate every route.ts whose GET is wrapped in
  // withAuthenticatedApi and require each to be covered or explicitly skipped.
  // NOTE: session-auth GET routes that read getAuthWithUser() directly instead
  // of withAuthenticatedApi (peopleai/status, peopleai/connect, peopleai/callback)
  // are outside this set by construction — the seam can't reach them; that
  // boundary is documented in the WS-R6 plan, not enforced here.
  test('every withAuthenticatedApi GET route is covered or explicitly skipped', () => {
    const apiDir = fileURLToPath(new URL('..', import.meta.url))
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (entry.name === 'route.ts') out.push(full)
      }
      return out
    }
    const authedGetRoutes = walk(apiDir)
      .filter((file) => /export const GET = withAuthenticatedApi/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(apiDir, path.dirname(file)))
    const covered = new Set(cases.map((c) => c.name.replace(/^GET \/api\//, '')))
    const skippedSet = new Set(skipped.map((s) => s.route))
    const uncovered = authedGetRoutes.filter((route) => !covered.has(route) && !skippedSet.has(route)).sort()
    assert.deepEqual(
      uncovered,
      [],
      `Authenticated GET route(s) with no smoke case: ${uncovered.join(', ')}. Add a case above, or add a documented skip.`,
    )
  })

}
