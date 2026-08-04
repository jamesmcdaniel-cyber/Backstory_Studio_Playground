import '@/test-support/jsdom-env'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { agentHref, createAgentFromTemplate } from '../agent-from-template'
import { resetSnapshotCache } from '../snapshot'

/**
 * The invariant: connecting a template to an agent lands the user ON the agent
 * it just built, carrying the template's instructions. Agent HQ used to live at
 * /dashboard; when the Assistant took that route over, this path kept pushing
 * /dashboard and dropped people on a chat screen with no sign of their agent.
 */

const TEMPLATE = {
  name: 'Sales Digest',
  description: 'Generates a personalized daily sales digest for each enrolled user.',
  instructions: 'Query Backstory via MCP for each user’s account activity, then deliver the digest.',
  integrations: ['backstory-mcp', 'slack', 'gmail'],
  skills: ['report-writing'],
  model: 'claude-opus-5',
  icon: '📈',
  allowSubagents: true,
}

type Call = { url: string; init?: RequestInit }

let calls: Call[] = []
const realFetch = globalThis.fetch

function stubFetch(create: { status: number; body: unknown }) {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, init })
    if (href.startsWith('/api/agents')) {
      return { ok: create.status < 400, status: create.status, json: async () => create.body }
    }
    // The shared snapshot the destination hydrates from.
    return { ok: true, status: 200, json: async () => ({ success: true, agents: [], activities: [] }) }
  }) as typeof globalThis.fetch
}

beforeEach(() => {
  calls = []
  resetSnapshotCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
  resetSnapshotCache()
})

test('a created agent opens in Agent HQ, never on the home page', async () => {
  stubFetch({ status: 200, body: { success: true, agent: { id: 'agent_42' } } })

  const result = await createAgentFromTemplate(TEMPLATE)

  assert.equal(result.ok, true)
  assert.ok(result.ok && result.href.startsWith('/agents'), `expected Agent HQ, got ${result.ok ? result.href : 'a failure'}`)
  assert.equal(result.ok && result.href, agentHref('agent_42'))
})

test('the new agent carries the template’s instructions and tools', async () => {
  stubFetch({ status: 200, body: { success: true, agent: { id: 'agent_42' } } })

  await createAgentFromTemplate(TEMPLATE)

  const post = calls.find((call) => call.url.startsWith('/api/agents') && call.init?.method === 'POST')
  assert.ok(post, 'no agent was created')
  const body = JSON.parse(String(post.init?.body))
  assert.equal(body.title, TEMPLATE.name)
  assert.equal(body.instructions, TEMPLATE.instructions)
  assert.deepEqual(body.integrations, TEMPLATE.integrations)
  assert.deepEqual(body.skills, TEMPLATE.skills)
  assert.equal(body.model, TEMPLATE.model)
  assert.equal(body.icon, TEMPLATE.icon)
  assert.equal(body.allowSubagents, true)
  assert.equal(body.schedule.type, 'manual', 'a template-built agent starts manual, never on a live cadence')
})

test('the shared snapshot is refreshed before the caller navigates', async () => {
  stubFetch({ status: 200, body: { success: true, agent: { id: 'agent_42' } } })
  // A cache warmed a moment ago — the state the shell is normally in. Agent HQ
  // silently drops an ?agent= deep link naming an agent this cache lacks.
  await globalThis.fetch('/api/snapshot')
  calls = []

  await createAgentFromTemplate(TEMPLATE)

  const order = calls.map((call) => call.url.split('?')[0])
  assert.deepEqual(order, ['/api/agents', '/api/snapshot'], 'the destination must see the new agent on mount')
})

test('a rejected create surfaces the API error and sends the user nowhere', async () => {
  stubFetch({ status: 403, body: { error: 'You do not have permission to create agents.' } })

  const result = await createAgentFromTemplate(TEMPLATE)

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.error, 'You do not have permission to create agents.')
})

test('a create that answers without an id still lands in Agent HQ, not the home page', async () => {
  stubFetch({ status: 200, body: { success: true } })

  const result = await createAgentFromTemplate(TEMPLATE)

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.href, '/agents')
})
