import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { SKIPS } from './helpers/mutating-smoke-skips'

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
  // Routes that mint or store secrets (e.g. peopleai/webhook-secret) throw
  // without a key, which reads as a 500 crash rather than the missing-config
  // it is. Match the sibling DB suites and supply one.
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'smoke-test-key'
}

let prisma: any
let seeded: any
let agentId: string
let flowId: string
let runId: string
let executionId: string
let connectionId: string
let notificationId: string
let teammateId: string

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
  teammateId = (await prisma.agentTeammate.create({
    data: { organizationId: org, name: 'Smoke teammate' },
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
  // The help assistant's own conversations. Unlike POST /api/librarian these
  // need no model, and an id nobody owns is the case worth running: it has to
  // come back as an ordinary empty delete rather than as a 404 that would tell
  // a stranger the thread is real.
  { route: 'librarian/sessions', method: 'DELETE', run: async () => (await import('../librarian/sessions/route')).DELETE(rq('/api/librarian/sessions', 'DELETE')) },
  { route: 'librarian/sessions/[id]', method: 'DELETE', run: async () => (await import('../librarian/sessions/[id]/route')).DELETE(rq('/api/librarian/sessions/missing', 'DELETE')) },
  { route: 'slack/my-identity', method: 'POST', run: async () => (await import('../slack/my-identity/route')).POST(rq('/api/slack/my-identity', 'POST', {})) },
  { route: 'slack/channel-bindings', method: 'PUT', run: async () => (await import('../slack/channel-bindings/route')).PUT(rq('/api/slack/channel-bindings', 'PUT', { channelId: 'C_SMOKE', agentTaskId: agentId })) },
  { route: 'slack/channel-bindings', method: 'DELETE', run: async () => (await import('../slack/channel-bindings/route')).DELETE(rq('/api/slack/channel-bindings', 'DELETE', { channelId: 'C_SMOKE' })) },
  { route: 'slack/command-bindings', method: 'PUT', run: async () => (await import('../slack/command-bindings/route')).PUT(rq('/api/slack/command-bindings', 'PUT', { command: '/DealCheck', agentTaskId: agentId })) },
  { route: 'slack/command-bindings', method: 'DELETE', run: async () => (await import('../slack/command-bindings/route')).DELETE(rq('/api/slack/command-bindings', 'DELETE', { command: 'dealcheck' })) },
  { route: 'teammates', method: 'POST', run: async () => (await import('../teammates/route')).POST(rq('/api/teammates', 'POST', { name: 'Smoke avatar' })) },
  { route: 'teammates', method: 'PATCH', run: async () => (await import('../teammates/route')).PATCH(rq('/api/teammates', 'PATCH', { id: teammateId, name: 'Smoke avatar renamed' })) },
  { route: 'teammates', method: 'DELETE', run: async () => (await import('../teammates/route')).DELETE(rq('/api/teammates', 'DELETE', { id: 'missing' })) },
  { route: 'workspace-folders', method: 'POST', run: async () => (await import('../workspace-folders/route')).POST(rq('/api/workspace-folders', 'POST', { name: 'Smoke public folder' })) },
  { route: 'workspace-folders', method: 'PATCH', run: async () => (await import('../workspace-folders/route')).PATCH(rq('/api/workspace-folders', 'PATCH', { id: 'missing', name: 'Renamed' })) },
  { route: 'workspace-folders', method: 'DELETE', run: async () => (await import('../workspace-folders/route')).DELETE(rq('/api/workspace-folders', 'DELETE', { id: 'missing' })) },
  { route: 'data-tables', method: 'POST', run: async () => (await import('../data-tables/route')).POST(rq('/api/data-tables', 'POST', { name: `Smoke table ${Date.now()}`, columns: [] })) },
  { route: 'data-tables', method: 'PATCH', run: async () => (await import('../data-tables/route')).PATCH(rq('/api/data-tables', 'PATCH', { id: 'missing', description: 'updated' })) },
  { route: 'data-tables', method: 'DELETE', run: async () => (await import('../data-tables/route')).DELETE(rq('/api/data-tables', 'DELETE', { id: 'missing', confirmation: 'missing' })) },
  { route: 'data-tables/[id]/rows', method: 'POST', run: async () => (await import('../data-tables/[id]/rows/route')).POST(rq('/api/data-tables/missing/rows', 'POST', { data: {} })) },
  { route: 'data-tables/[id]/rows', method: 'PATCH', run: async () => (await import('../data-tables/[id]/rows/route')).PATCH(rq('/api/data-tables/missing/rows', 'PATCH', { rowId: 'missing', data: {} })) },
  { route: 'data-tables/[id]/rows', method: 'DELETE', run: async () => (await import('../data-tables/[id]/rows/route')).DELETE(rq('/api/data-tables/missing/rows', 'DELETE', { rowId: 'missing' })) },
  { route: 'data-tables/[id]/csv', method: 'POST', run: async () => (await import('../data-tables/[id]/csv/route')).POST(rq('/api/data-tables/missing/csv', 'POST', 'name\nvalue')) },
  { route: 'repository', method: 'POST', run: async () => (await import('../repository/route')).POST(rq('/api/repository', 'POST', {})) },
  { route: 'repository/[id]', method: 'PATCH', run: async () => (await import('../repository/[id]/route')).PATCH(rq('/api/repository/missing', 'PATCH', { isEnabled: false })) },
  { route: 'repository/[id]', method: 'DELETE', run: async () => (await import('../repository/[id]/route')).DELETE(rq('/api/repository/missing', 'DELETE', { confirmation: 'missing' })) },
  { route: 'repository/[id]/reindex', method: 'POST', run: async () => (await import('../repository/[id]/reindex/route')).POST(rq('/api/repository/missing/reindex', 'POST', {})) },
  { route: 'repository/collections', method: 'POST', run: async () => (await import('../repository/collections/route')).POST(rq('/api/repository/collections', 'POST', { name: 'Smoke collection' })) },
  { route: 'repository/collections/[id]', method: 'PATCH', run: async () => (await import('../repository/collections/[id]/route')).PATCH(rq('/api/repository/collections/missing', 'PATCH', { name: 'Renamed' })) },
  { route: 'repository/collections/[id]', method: 'DELETE', run: async () => (await import('../repository/collections/[id]/route')).DELETE(rq('/api/repository/collections/missing', 'DELETE', {})) },
  { route: 'agents/[id]/collections', method: 'PUT', run: async () => (await import('../agents/[id]/collections/route')).PUT(rq('/api/agents/missing/collections', 'PUT', { collectionIds: [] })) },
  // A literal private address: refused by the SSRF guard with no DNS lookup.
  { route: 'agents/external', method: 'POST', run: async () => (await import('../agents/external/route')).POST(rq('/api/agents/external', 'POST', { name: 'Smoke external', webhookUrl: 'https://127.0.0.1/hook' })) },
  { route: 'agents/external/[id]', method: 'PATCH', run: async () => (await import('../agents/external/[id]/route')).PATCH(rq('/api/agents/external/missing', 'PATCH', { enabled: false })) },
  { route: 'agents/external/[id]', method: 'DELETE', run: async () => (await import('../agents/external/[id]/route')).DELETE(rq('/api/agents/external/missing', 'DELETE')) },
  { route: 'agents/external/[id]/rotate', method: 'POST', run: async () => (await import('../agents/external/[id]/rotate/route')).POST(rq('/api/agents/external/missing/rotate', 'POST', { credential: 'signing_secret' })) },
  { route: 'agent-actions/[id]/undo', method: 'POST', run: async () => (await import('../agent-actions/[id]/undo/route')).POST(rq('/api/agent-actions/missing/undo', 'POST', {})) },
  { route: 'repository/pull', method: 'POST', run: async () => (await import('../repository/pull/route')).POST(rq('/api/repository/pull', 'POST', { connectionId: 'missing', toolName: 'missing', args: {} })) },
  { route: 'repository/projects', method: 'POST', run: async () => (await import('../repository/projects/route')).POST(rq('/api/repository/projects', 'POST', { name: 'Smoke project', content: 'A repository reference created by the mutation smoke test.', agentId, workspaceScope: false })) },
  { route: 'repository/github/sync', method: 'POST', run: async () => (await import('../repository/github/sync/route')).POST(rq('/api/repository/github/sync', 'POST', { owner: 'missing', repo: 'missing', agentId, workspaceScope: false })) },

  // Unauthenticated by design — a browser posts violation reports with no
  // credentials. Must answer 204 to anything, including junk: a collector that
  // errors gets retried by the browser.
  { route: 'csp-report', method: 'POST', run: async () => (await import('../csp-report/route')).POST(rq('/api/csp-report', 'POST', { 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'inline' } })) },
  { route: 'forms/[id]/submit', method: 'POST', run: async () => (await import('../forms/[id]/submit/route')).POST(rq('/api/forms/missing/submit', 'POST', { values: {} })) },

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
  { route: 'audit-streams', method: 'POST', run: async () => (await import('../audit-streams/route')).POST(rq('/api/audit-streams', 'POST', { name: 'Smoke SIEM', url: 'https://logs.example.com/ingest' })) },
  { route: 'audit-streams', method: 'PATCH', run: async () => (await import('../audit-streams/route')).PATCH(rq('/api/audit-streams', 'PATCH', { id: 'missing', isActive: false })) },
  { route: 'audit-streams', method: 'DELETE', run: async () => (await import('../audit-streams/route')).DELETE(rq('/api/audit-streams?id=missing', 'DELETE')) },
  { route: 'agents/[id]/publish', method: 'POST', run: async () => (await import('../agents/[id]/publish/route')).POST(rq(`/api/agents/${agentId}/publish`, 'POST', {})) },
  { route: 'flows/migrations', method: 'POST', run: async () => (await import('../flows/migrations/route')).POST(rq('/api/flows/migrations', 'POST', { apply: true })) },
  { route: 'flows/[id]/review', method: 'POST', run: async () => (await import('../flows/[id]/review/route')).POST(rq(`/api/flows/${flowId}/review`, 'POST', { note: 'Please look at the Slack step.' })) },
  { route: 'flows/[id]/review', method: 'PATCH', run: async () => (await import('../flows/[id]/review/route')).PATCH(rq(`/api/flows/${flowId}/review`, 'PATCH', { decision: 'approved' })) },
  { route: 'flows/[id]/public-link', method: 'POST', run: async () => (await import('../flows/[id]/public-link/route')).POST(rq(`/api/flows/${flowId}/public-link`, 'POST', { action: 'enable' })) },
  { route: 'flows/[id]/share', method: 'POST', run: async () => (await import('../flows/[id]/share/route')).POST(rq(`/api/flows/${flowId}/share`, 'POST', { enabled: true, role: 'view' })) },
  { route: 'flows/[id]/versions', method: 'POST', run: async () => (await import('../flows/[id]/versions/route')).POST(rq(`/api/flows/${flowId}/versions`, 'POST', { version: 1, action: 'restore' })) },
  { route: 'flows/runs/[runId]/annotation', method: 'PATCH', run: async () => (await import('../flows/runs/[runId]/annotation/route')).PATCH(rq(`/api/flows/runs/${runId}/annotation`, 'PATCH', { rating: 4 })) },
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
  { route: 'mcp-connections', method: 'PATCH', run: async () => (await import('../mcp-connections/route')).PATCH(rq('/api/mcp-connections', 'PATCH', { id: connectionId, shareableWithCopilots: true })) },
  // Per-tool permissions: a pure row update (no server is contacted). Before
  // the DELETE below, so it acts on a row that still exists.
  { route: 'mcp-connections/[id]/tools', method: 'PATCH', run: async () => (await import('../mcp-connections/[id]/tools/route')).PATCH(rq(`/api/mcp-connections/${connectionId}/tools`, 'PATCH', { tools: { smoke_tool: 'off' } })) },
  { route: 'mcp-connections', method: 'DELETE', run: async () => (await import('../mcp-connections/route')).DELETE(rq('/api/mcp-connections', 'DELETE', { id: connectionId })) },
  { route: 'http-credentials', method: 'POST', run: async () => (await import('../http-credentials/route')).POST(rq('/api/http-credentials', 'POST', {})) },
  { route: 'http-credentials', method: 'PATCH', run: async () => (await import('../http-credentials/route')).PATCH(rq('/api/http-credentials', 'PATCH', { id: 'missing' })) },
  { route: 'http-credentials', method: 'DELETE', run: async () => (await import('../http-credentials/route')).DELETE(rq('/api/http-credentials', 'DELETE', { id: 'missing' })) },
  { route: 'external-secret-providers', method: 'POST', run: async () => (await import('../external-secret-providers/route')).POST(rq('/api/external-secret-providers', 'POST', {})) },
  { route: 'external-secret-providers', method: 'PATCH', run: async () => (await import('../external-secret-providers/route')).PATCH(rq('/api/external-secret-providers', 'PATCH', {})) },
  { route: 'external-secret-providers', method: 'DELETE', run: async () => (await import('../external-secret-providers/route')).DELETE(rq('/api/external-secret-providers?id=missing', 'DELETE')) },
  { route: 'credential-resolvers', method: 'POST', run: async () => (await import('../credential-resolvers/route')).POST(rq('/api/credential-resolvers', 'POST', {})) },
  { route: 'credential-resolvers', method: 'PATCH', run: async () => (await import('../credential-resolvers/route')).PATCH(rq('/api/credential-resolvers', 'PATCH', {})) },
  { route: 'credential-resolvers', method: 'DELETE', run: async () => (await import('../credential-resolvers/route')).DELETE(rq('/api/credential-resolvers?id=missing', 'DELETE')) },
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
  { route: 'approvals/batch', method: 'POST', run: async () => (await import('../approvals/batch/route')).POST(rq('/api/approvals/batch', 'POST', { ids: ['missing'], decision: 'reject' })) },
  { route: 'executions/[id]', method: 'DELETE', run: async () => (await import('../executions/[id]/route')).DELETE(rq(`/api/executions/${executionId}`, 'DELETE', {})) },
  { route: 'executions/[id]/reply', method: 'POST', run: async () => (await import('../executions/[id]/reply/route')).POST(rq(`/api/executions/${executionId}/reply`, 'POST', {})) },
  { route: 'files', method: 'POST', run: async () => (await import('../files/route')).POST(rq('/api/files', 'POST', {})) },
  { route: 'artifacts', method: 'POST', run: async () => (await import('../artifacts/route')).POST(rq('/api/artifacts', 'POST', { content: '<html><body><h1>Page</h1></body></html>', agentId: 'missing' })) },
  { route: 'share/flows/[token]/copy', method: 'POST', run: async () => (await import('../share/flows/[token]/copy/route')).POST(rq('/api/share/flows/missing-token-0000000/copy', 'POST', {})) },
  { route: 'share/artifacts/[token]/copy', method: 'POST', run: async () => (await import('../share/artifacts/[token]/copy/route')).POST(rq('/api/share/artifacts/missing/copy', 'POST', {})) },
  { route: 'artifacts/[id]', method: 'PATCH', run: async () => (await import('../artifacts/[id]/route')).PATCH(rq('/api/artifacts/missing', 'PATCH', { archived: true })) },
  { route: 'artifacts/[id]/state', method: 'PUT', run: async () => (await import('../artifacts/[id]/state/route')).PUT(rq('/api/artifacts/missing/state', 'PUT', { key: 'records-v1', revision: 0, value: [], versionId: 'missing' })) },
  { route: 'artifacts/[id]/shared-state', method: 'PUT', run: async () => (await import('../artifacts/[id]/shared-state/route')).PUT(rq('/api/artifacts/missing/shared-state', 'PUT', { key: 'signups-v1', revision: 0, value: [], versionId: 'missing' })) },
  { route: 'artifacts/[id]/render-errors', method: 'PUT', run: async () => (await import('../artifacts/[id]/render-errors/route')).PUT(rq('/api/artifacts/missing/render-errors', 'PUT', { versionId: 'missing', errors: [{ message: 'boom', count: 1 }] })) },
  { route: 'artifacts/[id]/versions/[versionId]/restore', method: 'POST', run: async () => (await import('../artifacts/[id]/versions/[versionId]/restore/route')).POST(rq('/api/artifacts/missing/versions/missing/restore', 'POST', {})) },
  { route: 'artifacts/[id]/chat', method: 'POST', run: async () => (await import('../artifacts/[id]/chat/route')).POST(rq('/api/artifacts/missing/chat', 'POST', { message: 'Why?', mode: 'ask' })) },
  { route: 'artifacts/[id]/chat', method: 'DELETE', run: async () => (await import('../artifacts/[id]/chat/route')).DELETE(rq('/api/artifacts/missing/chat', 'DELETE', {})) },
  { route: 'artifacts/[id]/reply', method: 'POST', run: async () => (await import('../artifacts/[id]/reply/route')).POST(rq('/api/artifacts/missing/reply', 'POST', { message: 'The second option' })) },
  { route: 'artifacts/[id]/sharing', method: 'PATCH', run: async () => (await import('../artifacts/[id]/sharing/route')).PATCH(rq('/api/artifacts/missing/sharing', 'PATCH', { workspaceAccess: 'view' })) },
  { route: 'artifacts/[id]/assistant', method: 'PATCH', run: async () => (await import('../artifacts/[id]/assistant/route')).PATCH(rq('/api/artifacts/missing/assistant', 'PATCH', { instructions: 'Write for a CFO', toolConnectionIds: [] })) },
  { route: 'artifacts/[id]/copilot-mcp', method: 'POST', run: async () => (await import('../artifacts/[id]/copilot-mcp/route')).POST(rq('/api/artifacts/missing/copilot-mcp', 'POST', { serverUrl: 'https://mcp.example.com/mcp', authType: 'none' })) },
  { route: 'artifacts/[id]/copilot-mcp', method: 'DELETE', run: async () => (await import('../artifacts/[id]/copilot-mcp/route')).DELETE(rq('/api/artifacts/missing/copilot-mcp', 'DELETE', { serverId: 'missing' })) },
  { route: 'artifacts/[id]/rerun-flow', method: 'POST', run: async () => (await import('../artifacts/[id]/rerun-flow/route')).POST(rq('/api/artifacts/missing/rerun-flow', 'POST', { message: 'again' })) },
  { route: 'roi/sources', method: 'POST', run: async () => (await import('../roi/sources/route')).POST(rq('/api/roi/sources', 'POST', { documentId: 'missing', account: 'Acme', kind: 'activity' })) },
  { route: 'roi/analyses', method: 'POST', run: async () => (await import('../roi/analyses/route')).POST(rq('/api/roi/analyses', 'POST', { account: 'Acme', timeframe: 'last6_vs_prior6', datasetIds: ['missing'] })) },
  { route: 'roi/settings', method: 'PATCH', run: async () => (await import('../roi/settings/route')).PATCH(rq('/api/roi/settings', 'PATCH', { dataFlowId: null })) },
  { route: 'roi/page/open', method: 'POST', run: async () => (await import('../roi/page/open/route')).POST(rq('/api/roi/page/open', 'POST', { account: 'Acme' })) },
  { route: 'roi/readout', method: 'POST', run: async () => (await import('../roi/readout/route')).POST(rq('/api/roi/readout', 'POST', { account: 'Acme' })) },
  { route: 'rag/backfill', method: 'POST', run: async () => (await import('../rag/backfill/route')).POST(rq('/api/rag/backfill', 'POST', {})) },
  { route: 'template-proposals/[id]/accept', method: 'POST', run: async () => (await import('../template-proposals/[id]/accept/route')).POST(rq('/api/template-proposals/missing/accept', 'POST', {})) },
  { route: 'template-proposals/[id]/dismiss', method: 'POST', run: async () => (await import('../template-proposals/[id]/dismiss/route')).POST(rq('/api/template-proposals/missing/dismiss', 'POST', {})) },

  // The unattended tick. It drives every scheduled agent/flow, poll trigger,
  // due wait, outbox batch, approval reap and health sweep — if it throws,
  // every schedule in the product silently stops, and nothing else calls it.
  { route: 'cron/dispatch', method: 'GET', run: async () => (await import('../cron/dispatch/route')).GET(new Request('http://test/api/cron/dispatch', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })) },
  // Retention is a DESTRUCTIVE global sweep — no organizationId filter on any
  // of its deletes — so invoking it here reaches into every other suite's
  // fixtures on the shared CI database. activity-retention.db.test.ts asserts
  // the sweep's counters over fixtures it seeded, and this smoke call was
  // silently eating them first, leaving that suite's own sweep with nothing to
  // count. Lock 918273646 is that suite's; taking it makes the two sweeps take
  // turns. Nothing here is relaxed by holding it: this case still asserts the
  // handler responds without a 5xx, exactly as before.
  { route: 'cron/retention', method: 'GET', run: async () => {
    const { GET } = await import('../cron/retention/route')
    return prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(918273646)')
      return GET(new Request('http://test/api/cron/retention', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))
    }, { timeout: 30_000, maxWait: 30_000 })
  } },
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

// SKIPS (with its grammar) lives in ./helpers/mutating-smoke-skips.ts.

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

const API_DIR = fileURLToPath(new URL('..', import.meta.url))
/** src/app/api → repo root. */
const REPO_ROOT = path.resolve(API_DIR, '..', '..', '..')

test('the skip list has no stale entries', () => {
  const exists = (key: string) => {
    const [route, method] = key.split(':')
    try {
      const src = readFileSync(path.join(API_DIR, route, 'route.ts'), 'utf8')
      return new RegExp(`export (const ${method}\\b|async function ${method}\\b)`).test(src)
    } catch {
      return false
    }
  }
  const stale = Object.keys(SKIPS).filter((key) => !exists(key))
  assert.deepEqual(stale, [], `SKIPS entries for handlers that no longer exist: ${stale.join(', ')}`)
})

/**
 * Resolve every module specifier a file mentions, so "does this test actually
 * import that route?" is answered by resolution rather than by a substring.
 *
 * Substring matching is not good enough here: route imports in this codebase
 * are written relative (`../[id]/trigger/route`), so the same text appears in
 * tests for the flows route and the agents route alike — which is precisely the
 * kind of near-miss the old prose rationales were built on.
 */
function importedModules(file: string): Set<string> {
  const source = readFileSync(file, 'utf8')
  const resolved = new Set<string>()
  for (const [, specifier] of source.matchAll(/['"`]([^'"`\n]+)['"`]/g)) {
    let target: string | null = null
    if (specifier.startsWith('@/')) target = path.join(REPO_ROOT, 'src', specifier.slice(2))
    else if (specifier.startsWith('.')) target = path.resolve(path.dirname(file), specifier)
    if (target) resolved.add(target.replace(/\.tsx?$/, ''))
  }
  return resolved
}

/**
 * A rationale that CLAIMS coverage has to be able to prove it.
 *
 * The previous version of this file checked only that a skipped handler still
 * existed, so "covered by X" was an unverified assertion — and several were
 * simply false. Three of them guarded the only enforcement points for the
 * free-tier ceilings, which meant the ceilings could have been deleted without
 * a single test turning red.
 *
 * The rule: cite a real file that really imports the route module and really
 * names the method, or say "no coverage:" and mean it.
 */
test('every SKIPS rationale is either verifiable coverage or an honest admission', () => {
  const problems: string[] = []
  for (const [key, rationale] of Object.entries(SKIPS)) {
    const [route, method] = key.split(':')
    const claim = /^covered by (\S+)/.exec(rationale)

    if (!claim) {
      if (!rationale.startsWith('no coverage: ')) {
        problems.push(
          `${key}: rationale must start with "covered by <repo-relative test file>" or "no coverage: <reason>" — got ${JSON.stringify(rationale)}`,
        )
      } else if (rationale.slice('no coverage: '.length).trim().length < 10) {
        problems.push(`${key}: "no coverage:" needs a real reason after it`)
      }
      // A "no coverage" admission must not quietly become false the other way:
      // if a test HAS since started importing this route, say so instead.
      continue
    }

    const cited = path.resolve(REPO_ROOT, claim[1])
    let modules: Set<string>
    try {
      modules = importedModules(cited)
    } catch {
      problems.push(`${key}: cites ${claim[1]}, which does not exist`)
      continue
    }
    const routeModule = path.join(API_DIR, route, 'route')
    if (!modules.has(routeModule)) {
      problems.push(`${key}: ${claim[1]} does not import ${path.relative(REPO_ROOT, routeModule)}`)
      continue
    }
    if (!new RegExp(`\\b${method}\\b`).test(readFileSync(cited, 'utf8'))) {
      problems.push(`${key}: ${claim[1]} imports the route but never mentions ${method}`)
    }
  }
  assert.deepEqual(
    problems,
    [],
    `SKIPS rationales that do not hold up:\n${problems.join('\n')}\n\n` +
      'Either write the missing test, or restate the entry as "no coverage: <reason>".',
  )
})
