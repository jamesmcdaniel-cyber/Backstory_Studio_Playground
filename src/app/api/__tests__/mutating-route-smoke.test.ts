import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NextRequest } from 'next/server'

/**
 * Mutating routes have to RUN, not just be authenticated.
 *
 * route-smoke.test.ts covers this API's GET surface and — for POST/PUT/PATCH/
 * DELETE — asserts only that each handler is wrapped in withAuthenticatedApi.
 * That left 90 of 99 mutating handlers invoked by no test at all, and it is
 * exactly how `POST /api/flows/[id]/publish` shipped 500ing on every call: the
 * route was authenticated, so the guard was satisfied, and nothing ever called
 * it. Publishing was the only way to arm a webhook/schedule trigger, so the
 * whole triggering surface was dead.
 *
 * Each case sends a plausible body and asserts the handler RESPONDS rather than
 * crashing. A 4xx is a pass — validation, permissions and not-found are the
 * handler working. A 5xx or a thrown error is a defect: an unscoped query that
 * trips the tenant guard, a missing null-guard, an unhandled edge.
 *
 * The completeness test at the bottom fails when a new mutating handler is
 * added without either a case here or a documented skip.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'smoke-cron-secret'
}

let prisma: any
let seeded: any
let agentId: string
let flowId: string
let runId: string
let executionId: string
let connectionId: string
let notificationId: string

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  installTestAuth(seeded.auth)
  const org = seeded.organizationId
  const uid = seeded.userId

  agentId = (await prisma.agentTask.create({
    data: { description: 'smoke agent', objective: 'o', status: 'ACTIVE', visibility: 'shared', organizationId: org, userId: uid },
  })).id
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'out', type: 'output', data: { outputs: [{ name: 'ok', value: 'ran', type: 'text' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'out' }],
  }
  flowId = (await prisma.flow.create({
    data: { name: 'Smoke flow', organizationId: org, userId: uid, trigger: { type: 'manual' }, graph },
  })).id
  runId = (await prisma.flowRun.create({
    data: { flowId, organizationId: org, userId: uid, status: 'running', input: {}, trigger: { type: 'manual' } },
  })).id
  executionId = (await prisma.agentExecution.create({
    data: { agentTaskId: agentId, organizationId: org, userId: uid, status: 'running', trigger: 'manual', agentType: 'CUSTOM', input: {} },
  })).id
  connectionId = (await prisma.mcpConnection.create({
    data: { name: 'Smoke MCP', serverUrl: 'https://mcp.invalid.test/mcp', organizationId: org, userId: uid, authType: 'none', isActive: true },
  })).id
  notificationId = (await prisma.notification.create({
    data: { organizationId: org, userId: uid, type: 'smoke', level: 'info', title: 't', body: 'b' },
  })).id
})

after(async () => {
  if (!TEST_DB) return
  if (seeded) await seeded.cleanup()
})

const rq = (p: string, method: string, payload?: unknown) =>
  new NextRequest(new URL(`http://test${p}`), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  } as never)

/**
 * The second argument Next.js hands a dynamic route. Routes that read
 * `context.params` throw on `undefined` without it, so omitting it here
 * would report a crash this harness caused rather than one a caller would
 * hit. Required for every route matching `[id]` that reads its params from
 * the context rather than the URL.
 */
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) })

/**
 * name → handler. `route` is the path under src/app/api, used by the
 * completeness check to know which handlers are accounted for.
 */
type Case = { route: string; method: string; run: () => Promise<Response> }
const cases = (): Case[] => [
  { route: 'agents', method: 'POST', run: async () => (await import('../agents/route')).POST(rq('/api/agents', 'POST', { title: 'Smoke', instructions: 'do it' })) },
  { route: 'agents', method: 'PUT', run: async () => (await import('../agents/route')).PUT(rq('/api/agents', 'PUT', { id: agentId, title: 'Smoke renamed' })) },
  { route: 'agents', method: 'DELETE', run: async () => (await import('../agents/route')).DELETE(rq('/api/agents', 'DELETE', { id: 'missing' })) },
  { route: 'agents/[id]/trigger-secret', method: 'POST', run: async () => (await import('../agents/[id]/trigger-secret/route')).POST(rq(`/api/agents/${agentId}/trigger-secret`, 'POST', {})) },
  { route: 'agents/[id]/memories', method: 'PATCH', run: async () => (await import('../agents/[id]/memories/route')).PATCH(rq(`/api/agents/${agentId}/memories`, 'PATCH', { id: 'missing', status: 'dismissed' })) },
  { route: 'agents/[id]/memories', method: 'DELETE', run: async () => (await import('../agents/[id]/memories/route')).DELETE(rq(`/api/agents/${agentId}/memories`, 'DELETE', { all: true })) },
  { route: 'agents/[id]/knowledge', method: 'POST', run: async () => (await import('../agents/[id]/knowledge/route')).POST(rq(`/api/agents/${agentId}/knowledge`, 'POST', {})) },
  { route: 'agents/[id]/knowledge', method: 'DELETE', run: async () => (await import('../agents/[id]/knowledge/route')).DELETE(rq(`/api/agents/${agentId}/knowledge`, 'DELETE', { documentId: 'missing' })) },
  { route: 'agents/[id]/chat', method: 'PATCH', run: async () => (await import('../agents/[id]/chat/route')).PATCH(rq(`/api/agents/${agentId}/chat`, 'PATCH', { sessionId: 'missing', title: 'x' })) },
  { route: 'agents/[id]/runs/[runId]', method: 'DELETE', run: async () => (await import('../agents/[id]/runs/[runId]/route')).DELETE(rq(`/api/agents/${agentId}/runs/${executionId}`, 'DELETE', {})) },
  { route: 'workspace-folders', method: 'POST', run: async () => (await import('../workspace-folders/route')).POST(rq('/api/workspace-folders', 'POST', { name: 'Smoke public folder' })) },
  { route: 'workspace-folders', method: 'PATCH', run: async () => (await import('../workspace-folders/route')).PATCH(rq('/api/workspace-folders', 'PATCH', { id: 'missing', name: 'Renamed' })) },
  { route: 'workspace-folders', method: 'DELETE', run: async () => (await import('../workspace-folders/route')).DELETE(rq('/api/workspace-folders', 'DELETE', { id: 'missing' })) },

  // Unauthenticated by design — a browser posts violation reports with no
  // credentials. Must answer 204 to anything, including junk: a collector that
  // errors gets retried by the browser.
  { route: 'csp-report', method: 'POST', run: async () => (await import('../csp-report/route')).POST(rq('/api/csp-report', 'POST', { 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'inline' } })) },

  { route: 'agent-templates', method: 'POST', run: async () => (await import('../agent-templates/route')).POST(rq('/api/agent-templates', 'POST', { name: 'Smoke', instructions: 'do it' })) },
  { route: 'agent-templates', method: 'PUT', run: async () => (await import('../agent-templates/route')).PUT(rq('/api/agent-templates', 'PUT', { id: 'missing' })) },
  { route: 'agent-templates', method: 'DELETE', run: async () => (await import('../agent-templates/route')).DELETE(rq('/api/agent-templates', 'DELETE', { id: 'missing' })) },
  { route: 'skills', method: 'POST', run: async () => (await import('../skills/route')).POST(rq('/api/skills', 'POST', { name: 'Smoke skill', instructions: 'do it' })) },
  { route: 'skills', method: 'PUT', run: async () => (await import('../skills/route')).PUT(rq('/api/skills', 'PUT', { id: 'missing' })) },
  { route: 'skills', method: 'DELETE', run: async () => (await import('../skills/route')).DELETE(rq('/api/skills', 'DELETE', { id: 'missing' })) },

  { route: 'catalogue/submissions', method: 'POST', run: async () => (await import('../catalogue/submissions/route')).POST(rq('/api/catalogue/submissions', 'POST', {})) },
  { route: 'catalogue/submissions/[id]', method: 'DELETE', run: async () => (await import('../catalogue/submissions/[id]/route')).DELETE(rq('/api/catalogue/submissions/x', 'DELETE', {}), ctx({ id: 'x' })) },
  { route: 'catalogue/review/[id]', method: 'POST', run: async () => (await import('../catalogue/review/[id]/route')).POST(rq('/api/catalogue/review/x', 'POST', {}), ctx({ id: 'x' })) },
  { route: 'catalogue/staff', method: 'PATCH', run: async () => (await import('../catalogue/staff/route')).PATCH(rq('/api/catalogue/staff', 'PATCH', {})) },
  { route: 'catalogue/entries/[id]', method: 'DELETE', run: async () => (await import('../catalogue/entries/[id]/route')).DELETE(rq('/api/catalogue/entries/x', 'DELETE', {}), ctx({ id: 'x' })) },

  { route: 'flows', method: 'POST', run: async () => (await import('../flows/route')).POST(rq('/api/flows', 'POST', { name: 'Smoke created' })) },
  { route: 'flows', method: 'PUT', run: async () => (await import('../flows/route')).PUT(rq('/api/flows', 'PUT', { id: flowId, name: 'Smoke renamed', folder: 'Smoke' })) },
  { route: 'flows', method: 'DELETE', run: async () => (await import('../flows/route')).DELETE(rq('/api/flows', 'DELETE', { id: 'missing' })) },
  { route: 'flows/[id]/cancel', method: 'POST', run: async () => (await import('../flows/[id]/cancel/route')).POST(rq(`/api/flows/${flowId}/cancel`, 'POST', { flowRunId: runId })) },
  { route: 'flows/[id]/invite', method: 'POST', run: async () => (await import('../flows/[id]/invite/route')).POST(rq(`/api/flows/${flowId}/invite`, 'POST', {})) },
  { route: 'flows/[id]/publish', method: 'POST', run: async () => (await import('../flows/[id]/publish/route')).POST(rq(`/api/flows/${flowId}/publish`, 'POST', {})) },
  { route: 'flows/[id]/share', method: 'POST', run: async () => (await import('../flows/[id]/share/route')).POST(rq(`/api/flows/${flowId}/share`, 'POST', { enabled: true, role: 'view' })) },
  { route: 'flows/[id]/versions', method: 'POST', run: async () => (await import('../flows/[id]/versions/route')).POST(rq(`/api/flows/${flowId}/versions`, 'POST', { version: 1, action: 'restore' })) },
  { route: 'flows/[id]/trigger-secret', method: 'POST', run: async () => (await import('../flows/[id]/trigger-secret/route')).POST(rq(`/api/flows/${flowId}/trigger-secret`, 'POST', {})) },
  { route: 'flows/[id]/collaborators', method: 'DELETE', run: async () => (await import('../flows/[id]/collaborators/route')).DELETE(rq(`/api/flows/${flowId}/collaborators`, 'DELETE', { userId: 'missing' })) },
  { route: 'flows/[id]/huddle/summary', method: 'POST', run: async () => (await import('../flows/[id]/huddle/summary/route')).POST(rq(`/api/flows/${flowId}/huddle/summary`, 'POST', {})) },
  { route: 'flows/tool-options', method: 'POST', run: async () => (await import('../flows/tool-options/route')).POST(rq('/api/flows/tool-options', 'POST', {})) },

  { route: 'flow-templates', method: 'POST', run: async () => (await import('../flow-templates/route')).POST(rq('/api/flow-templates', 'POST', {})) },
  { route: 'flow-templates', method: 'PUT', run: async () => (await import('../flow-templates/route')).PUT(rq('/api/flow-templates', 'PUT', { id: 'missing' })) },
  { route: 'flow-templates', method: 'DELETE', run: async () => (await import('../flow-templates/route')).DELETE(rq('/api/flow-templates', 'DELETE', { id: 'missing' })) },
  { route: 'flow-templates/[id]/use', method: 'POST', run: async () => (await import('../flow-templates/[id]/use/route')).POST(rq('/api/flow-templates/summarize-extract/use', 'POST', {})) },
  { route: 'flow-templates/[id]/versions', method: 'POST', run: async () => (await import('../flow-templates/[id]/versions/route')).POST(rq('/api/flow-templates/summarize-extract/versions', 'POST', { version: 1, action: 'restore' })) },

  { route: 'mcp-connections', method: 'POST', run: async () => (await import('../mcp-connections/route')).POST(rq('/api/mcp-connections', 'POST', { name: 'x', serverUrl: 'https://mcp.invalid.test/mcp' })) },
  { route: 'mcp-connections', method: 'PUT', run: async () => (await import('../mcp-connections/route')).PUT(rq('/api/mcp-connections', 'PUT', { id: connectionId, isActive: false })) },
  { route: 'mcp-connections', method: 'DELETE', run: async () => (await import('../mcp-connections/route')).DELETE(rq('/api/mcp-connections', 'DELETE', { id: connectionId })) },
  { route: 'http-credentials', method: 'POST', run: async () => (await import('../http-credentials/route')).POST(rq('/api/http-credentials', 'POST', {})) },
  { route: 'http-credentials', method: 'PATCH', run: async () => (await import('../http-credentials/route')).PATCH(rq('/api/http-credentials', 'PATCH', { id: 'missing' })) },
  { route: 'http-credentials', method: 'DELETE', run: async () => (await import('../http-credentials/route')).DELETE(rq('/api/http-credentials', 'DELETE', { id: 'missing' })) },
  { route: 'integrations/credentials/[provider]', method: 'POST', run: async () => (await import('../integrations/credentials/[provider]/route')).POST(rq('/api/integrations/credentials/slack', 'POST', {})) },
  { route: 'integrations/credentials/[provider]', method: 'DELETE', run: async () => (await import('../integrations/credentials/[provider]/route')).DELETE(rq('/api/integrations/credentials/slack', 'DELETE', {})) },
  { route: 'integrations/granola', method: 'POST', run: async () => (await import('../integrations/granola/route')).POST(rq('/api/integrations/granola', 'POST', {})) },
  { route: 'integrations/granola', method: 'DELETE', run: async () => (await import('../integrations/granola/route')).DELETE(rq('/api/integrations/granola', 'DELETE', {})) },
  { route: 'nango/connections/[integrationId]', method: 'DELETE', run: async () => (await import('../nango/connections/[integrationId]/route')).DELETE(rq('/api/nango/connections/slack', 'DELETE', {})) },
  { route: 'peopleai/connect', method: 'DELETE', run: async () => (await import('../peopleai/connect/route')).DELETE(rq('/api/peopleai/connect', 'DELETE', {})) },
  { route: 'peopleai/webhook-secret', method: 'POST', run: async () => (await import('../peopleai/webhook-secret/route')).POST(rq('/api/peopleai/webhook-secret', 'POST', {})) },

  { route: 'organizations', method: 'PATCH', run: async () => (await import('../organizations/route')).PATCH(rq('/api/organizations', 'PATCH', { name: 'Smoke org' })) },
  { route: 'organizations/invitations', method: 'POST', run: async () => (await import('../organizations/invitations/route')).POST(rq('/api/organizations/invitations', 'POST', { email: 'smoke@example.test', role: 'USER' })) },
  { route: 'organizations/invitations/[id]', method: 'DELETE', run: async () => (await import('../organizations/invitations/[id]/route')).DELETE(rq('/api/organizations/invitations/x', 'DELETE', {})) },
  { route: 'organizations/members/[id]', method: 'PATCH', run: async () => (await import('../organizations/members/[id]/route')).PATCH(rq('/api/organizations/members/x', 'PATCH', { role: 'USER' })) },
  { route: 'organizations/members/[id]', method: 'DELETE', run: async () => (await import('../organizations/members/[id]/route')).DELETE(rq('/api/organizations/members/x', 'DELETE', {})) },
  { route: 'quarantine/[id]/claim', method: 'POST', run: async () => (await import('../quarantine/[id]/claim/route')).POST(rq('/api/quarantine/x/claim', 'POST', { kind: 'flow' })) },
  { route: 'invitations/accept', method: 'POST', run: async () => (await import('../invitations/accept/route')).POST(rq('/api/invitations/accept', 'POST', { token: 'missing' })) },

  { route: 'signal-subscriptions', method: 'POST', run: async () => (await import('../signal-subscriptions/route')).POST(rq('/api/signal-subscriptions', 'POST', {})) },
  { route: 'signal-subscriptions/[id]', method: 'PATCH', run: async () => (await import('../signal-subscriptions/[id]/route')).PATCH(rq('/api/signal-subscriptions/x', 'PATCH', { isActive: false })) },
  { route: 'signal-subscriptions/[id]', method: 'DELETE', run: async () => (await import('../signal-subscriptions/[id]/route')).DELETE(rq('/api/signal-subscriptions/x', 'DELETE', {})) },
  { route: 'signals/custom', method: 'POST', run: async () => (await import('../signals/custom/route')).POST(rq('/api/signals/custom', 'POST', {})) },
  { route: 'signals/custom', method: 'DELETE', run: async () => (await import('../signals/custom/route')).DELETE(rq('/api/signals/custom', 'DELETE', {})) },
  { route: 'signals/custom/[id]/run', method: 'POST', run: async () => (await import('../signals/custom/[id]/run/route')).POST(rq('/api/signals/custom/x/run', 'POST', {})) },
  { route: 'notifications/read', method: 'POST', run: async () => (await import('../notifications/read/route')).POST(rq('/api/notifications/read', 'POST', { id: notificationId })) },
  { route: 'push/subscribe', method: 'POST', run: async () => (await import('../push/subscribe/route')).POST(rq('/api/push/subscribe', 'POST', { endpoint: 'https://push.example.test/smoke', keys: { p256dh: 'a', auth: 'b' } })) },
  { route: 'push/subscribe', method: 'DELETE', run: async () => (await import('../push/subscribe/route')).DELETE(new NextRequest(new URL('http://test/api/push/subscribe?endpoint=https://push.example.test/smoke'), { method: 'DELETE' } as never)) },

  { route: 'approvals/[id]', method: 'POST', run: async () => (await import('../approvals/[id]/route')).POST(rq('/api/approvals/x', 'POST', {})) },
  { route: 'executions/[id]', method: 'DELETE', run: async () => (await import('../executions/[id]/route')).DELETE(rq(`/api/executions/${executionId}`, 'DELETE', {})) },
  { route: 'executions/[id]/reply', method: 'POST', run: async () => (await import('../executions/[id]/reply/route')).POST(rq(`/api/executions/${executionId}/reply`, 'POST', {})) },
  { route: 'files', method: 'POST', run: async () => (await import('../files/route')).POST(rq('/api/files', 'POST', {})) },
  { route: 'rag/backfill', method: 'POST', run: async () => (await import('../rag/backfill/route')).POST(rq('/api/rag/backfill', 'POST', {})) },
  { route: 'template-proposals/[id]/accept', method: 'POST', run: async () => (await import('../template-proposals/[id]/accept/route')).POST(rq('/api/template-proposals/missing/accept', 'POST', {})) },
  { route: 'template-proposals/[id]/dismiss', method: 'POST', run: async () => (await import('../template-proposals/[id]/dismiss/route')).POST(rq('/api/template-proposals/missing/dismiss', 'POST', {})) },

  // The unattended tick. It drives every scheduled agent/flow, poll trigger,
  // due wait, outbox batch, approval reap and health sweep — if it throws,
  // every schedule in the product silently stops, and nothing else calls it.
  { route: 'cron/dispatch', method: 'GET', run: async () => (await import('../cron/dispatch/route')).GET(new Request('http://test/api/cron/dispatch', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })) },
  { route: 'cron/retention', method: 'GET', run: async () => (await import('../cron/retention/route')).GET(new Request('http://test/api/cron/retention', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })) },
]

test('every mutating handler responds instead of crashing', { skip: !TEST_DB }, async () => {
  const crashes: string[] = []
  for (const c of cases()) {
    const label = `${c.method} /api/${c.route}`
    try {
      const res = await c.run()
      // 5xx is the failure signal. 503 is allowed: a handler that reports a
      // capability as unconfigured (transcription, a missing provider key) is
      // answering correctly, not crashing.
      if (res.status >= 500 && res.status !== 503) {
        crashes.push(`${label} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`)
      }
    } catch (error) {
      crashes.push(`${label} → threw: ${(error instanceof Error ? error.message : String(error)).slice(0, 220)}`)
    }
  }
  assert.deepEqual(crashes, [], `Mutating handler(s) crashed:\n${crashes.join('\n')}`)
})

test('cron/dispatch and cron/retention refuse a wrong secret', { skip: !TEST_DB }, async () => {
  const dispatch = await import('../cron/dispatch/route')
  const retention = await import('../cron/retention/route')
  const bad = (p: string) => new Request(`http://test${p}`, { headers: { authorization: 'Bearer wrong' } })
  assert.equal((await dispatch.GET(bad('/api/cron/dispatch'))).status, 401)
  assert.equal((await retention.GET(bad('/api/cron/retention'))).status, 401)
  assert.equal((await dispatch.GET(new Request('http://test/api/cron/dispatch'))).status, 401, 'and a missing secret')
})

/**
 * Handlers deliberately not invoked here, each with the reason. Anything not
 * in `cases` and not listed here fails the completeness test below.
 */
const SKIPS: Record<string, string> = {
  'v1/token:POST': 'client-credentials grant; covered by client-credentials.db.test.ts',
  'agents/[id]/execute:POST': 'runs an agent against a live model',
  'agents/[id]/chat:POST': 'streams a live model turn',
  'agents/[id]/runs/[runId]:POST': 'resumes a run against a live model',
  'agents/[id]/trigger:POST': 'per-agent secret path; covered by trigger-secret.db.test.ts',
  'agents/draft:POST': 'drafts an agent with a live model',
  'agents/role-labels:POST': 'generates role labels with a live model',
  'chat:POST': 'live model turn',
  'librarian:POST': 'live model turn',
  'flows/copilot:POST': 'live model turn',
  'flows/copilot/chat:POST': 'live model turn',
  'flows/code-assist:POST': 'live model turn',
  'flow-templates/draft-notes:POST': 'live model turn',
  'integrations/ai-search:POST': 'live model turn',
  'templates/ai-search:POST': 'live model turn',
  'playbooks/salesai-upsell:POST': 'live model turn against People.ai',
  'flows/[id]/execute:POST': 'runs a flow; covered by the flows execution tests',
  'flows/[id]/runs/[runId]/resume:POST': 'capability-URL callback; covered by the flows resume tests',
  'flows/[id]/trigger:POST': 'per-flow webhook secret; covered by the flows trigger tests',
  'flows/[id]/huddle/segment:POST': 'multipart audio upload to a transcription provider',
  'flows/signals/[name]:POST': 'signal fan-out; covered by the signals tests',
  'signals/people-ai:POST': 'HMAC-signed external webhook',
  'nango/webhook:POST': 'Nango-signed external webhook',
  'nango/session-token:POST': 'mints a live Nango session token',
  'nango/connections/[integrationId]/verify:POST': 'calls Nango live',
  'integrations/granola/test:POST': 'calls Granola live',
  'mcp-connections/discover:POST': 'probes a live MCP server',
  'mcp-connections/test:POST': 'probes a live MCP server',
  'scim/v2/Users:POST': 'SCIM bearer-token provisioning; covered by SCIM service tests',
  'scim/v2/Users/[id]:PATCH': 'SCIM bearer-token provisioning; covered by SCIM service tests',
  'scim/v2/Users/[id]:DELETE': 'SCIM bearer-token provisioning; covered by SCIM service tests',
  'scim/v2/Groups/[id]:PATCH': 'SCIM bearer-token group membership; covered by SCIM service tests',
  'api-keys:POST': 'returns a one-time plaintext credential; covered by public API auth tests',
  'api-keys:DELETE': 'credential lifecycle; covered by public API auth tests',
  'flows/import:POST': 'native package import; covered by native package tests',
  'privacy/account:DELETE': 'irreversible identity deletion; covered by privacy service tests',
  'privacy/workspace:DELETE': 'irreversible workspace deletion; covered by privacy service tests',
  'v1/flows:POST': 'API-key-authenticated import; covered by public API tests',
  'v1/flows/[id]:PUT': 'API-key-authenticated update; covered by public API tests',
  'v1/flows/[id]:DELETE': 'API-key-authenticated deletion; covered by public API tests',
  'v1/flows/[id]/run:POST': 'API-key-authenticated live flow execution',
  'organizations/domains:POST': 'starts a DNS TXT challenge; covered by the enterprise identity tests',
  'organizations/domains:DELETE': 'domain lifecycle; covered by the enterprise identity tests',
  'organizations/domains/[id]/verify:POST': 'resolves live DNS to check the TXT challenge',
  'organizations/scim-tokens:POST': 'returns a one-time plaintext bearer token; covered by SCIM service tests',
  'organizations/scim-tokens:DELETE': 'credential lifecycle; covered by SCIM service tests',
  'organizations/security:PATCH': 'changes MFA/SSO enforcement; covered by the enterprise policy tests',
  // Reviewer-only, like the catalogue routes: the smoke org holds no
  // catalogue.review permission so these correctly 403 without reaching the
  // handler body. The security-critical logic (domain normalization, the
  // public-provider blocklist) is unit-tested in
  // src/lib/auth/__tests__/allowed-domain.test.ts.
  'admin/domains:POST': 'reviewer-only — 403 for the smoke org by design',
  'admin/domains:PATCH': 'reviewer-only — 403 for the smoke org by design',
  // Operator-only, and every branch acts on someone else's account. Covered
  // by admin/__tests__/users-route.db.test.ts with a real operator context.
  'admin/users/[id]/actions:POST': 'operator-only — 403 for the smoke org by design',
}

test('every mutating handler is either smoke-tested or documented as skipped', () => {
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
  const covered = new Set(cases().map((c) => `${c.route}:${c.method}`))
  const uncovered: string[] = []
  for (const file of walk(apiDir)) {
    const src = readFileSync(file, 'utf8')
    const route = path.relative(apiDir, path.dirname(file))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      if (!new RegExp(`export (const ${method}\\b|async function ${method}\\b)`).test(src)) continue
      const key = `${route}:${method}`
      if (!covered.has(key) && !(key in SKIPS)) uncovered.push(key)
    }
  }
  assert.deepEqual(
    uncovered.sort(),
    [],
    `Mutating handler(s) with no smoke case: ${uncovered.join(', ')}. Add a case above, or add a documented SKIPS entry.`,
  )
})

test('the skip list has no stale entries', () => {
  const apiDir = fileURLToPath(new URL('..', import.meta.url))
  const exists = (key: string) => {
    const [route, method] = key.split(':')
    try {
      const src = readFileSync(path.join(apiDir, route, 'route.ts'), 'utf8')
      return new RegExp(`export (const ${method}\\b|async function ${method}\\b)`).test(src)
    } catch {
      return false
    }
  }
  const stale = Object.keys(SKIPS).filter((key) => !exists(key))
  assert.deepEqual(stale, [], `SKIPS entries for handlers that no longer exist: ${stale.join(', ')}`)
})
