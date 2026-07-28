import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '@/features/flows/interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// A reported flow, verbatim: it authenticates against a token endpoint, then
// calls an API with the token. Both data references were written in another
// tool's syntax — `body('Step')?['field']` on the compose step, `{Output}` in
// the auth header — neither of which this engine substitutes. Before the
// unresolved-reference guard, every step reported success while the second
// request went out as `Authorization: Bearer {Output}` and came back 401.
const graph = {
  nodes: [
    { id: 'trigger', data: { trigger: { type: 'manual' } }, type: 'trigger' },
    {
      id: 'n2',
      type: 'http',
      data: {
        method: 'POST',
        url: 'https://api.people.ai/v3/auth/tokens',
        sendQuery: false,
        sendHeaders: true,
        sendBody: true,
        bodyMode: 'raw',
        responseType: 'auto',
        failOnHttpError: true,
        retries: 0,
        body: 'client_id=X&client_secret=Y&grant_type=client_credentials',
        headers: '{\n  "Content-Type": "application/x-www-form-urlencoded"\n}',
      },
    },
    {
      id: 'n3',
      type: 'data',
      data: { op: 'compose', input: "body('HTTP_action_—_get_OAuth_token')?['access_token']" },
    },
    {
      id: 'n4',
      type: 'http',
      data: {
        method: 'POST',
        url: 'https://api.people.ai/v3/beta/insights/export',
        sendQuery: false,
        sendHeaders: true,
        sendBody: false,
        bodyMode: 'json',
        responseType: 'auto',
        failOnHttpError: true,
        retries: 0,
        body: '',
        headers: '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer {Output}"\n}',
      },
    },
  ],
  edges: [
    { id: 'trigger->n2', source: 'trigger', target: 'n2' },
    { id: 'n2->n3', source: 'n2', target: 'n3' },
    { id: 'n3->n4', source: 'n3', target: 'n4' },
  ],
} as unknown as FlowGraph

const runAgent: RunAgentFn = async () => ({ output: 'agent' })

/** Records every request the adapter was asked to send. */
function recordingAction(sent: Array<Record<string, unknown>>): RunActionFn {
  return async (node) => {
    sent.push(node.config)
    if (node.id === 'n2') {
      return {
        output: {
          ok: true,
          status: 200,
          headers: {},
          body: { access_token: 'REAL-TOKEN-123' },
          bodyText: '{"access_token":"REAL-TOKEN-123"}',
        },
      }
    }
    return { output: { ok: true, status: 200, headers: {}, body: {}, bodyText: '{}' } }
  }
}

test('a foreign-syntax reference fails its own step instead of reaching the API', async () => {
  const sent: Array<Record<string, unknown>> = []
  const result = await interpretFlow(graph, {}, { runAgent, runAction: recordingAction(sent) })

  assert.equal(result.status, 'failed')
  const compose = result.steps.find((step) => step.nodeId === 'n3')
  assert.equal(compose?.status, 'failed')
  assert.match(compose?.error ?? '', /another automation tool/i)
  assert.match(compose?.error ?? '', /access_token/)

  // The API call downstream of the broken reference never went out.
  assert.deepEqual(sent.map((config) => config.url), ['https://api.people.ai/v3/auth/tokens'])
})

test('a placeholder auth header fails even when nothing upstream is broken', async () => {
  // Same graph with the compose step corrected — the `{Output}` header is now
  // the only defect left, and it must still stop the request.
  const fixed = {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'n3'
        ? { ...node, data: { op: 'compose', input: '{{step.n2.output.body.access_token}}' } }
        : node,
    ),
  } as unknown as FlowGraph

  const sent: Array<Record<string, unknown>> = []
  const result = await interpretFlow(fixed, {}, { runAgent, runAction: recordingAction(sent) })

  assert.equal(result.status, 'failed')
  assert.equal(result.steps.find((step) => step.nodeId === 'n3')?.status, 'succeeded')
  const call = result.steps.find((step) => step.nodeId === 'n4')
  assert.equal(call?.status, 'failed')
  assert.match(call?.error ?? '', /placeholder, not a credential/i)
  assert.deepEqual(sent.map((config) => config.url), ['https://api.people.ai/v3/auth/tokens'])
})

test('the same flow, referenced correctly, sends the real token through', async () => {
  const fixed = {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id === 'n3') return { ...node, data: { op: 'compose', input: '{{step.n2.output.body.access_token}}' } }
      if (node.id === 'n4') {
        return {
          ...node,
          data: {
            ...(node.data as Record<string, unknown>),
            headers: '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer {{step.n3.output}}"\n}',
          },
        }
      }
      return node
    }),
  } as unknown as FlowGraph

  const sent: Array<Record<string, unknown>> = []
  const result = await interpretFlow(fixed, {}, { runAgent, runAction: recordingAction(sent) })

  assert.equal(result.status, 'succeeded')
  const call = sent.find((config) => config.url === 'https://api.people.ai/v3/beta/insights/export')
  assert.deepEqual(call?.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer REAL-TOKEN-123',
  })
})

test('an http body may carry another tool’s syntax — it is payload, not a reference', async () => {
  // This platform courts migration off Power Automate, so posting a Logic Apps
  // definition to some API is a legitimate call and must not be blocked.
  const deploy = {
    nodes: [
      { id: 'trigger', data: { trigger: { type: 'manual' } }, type: 'trigger' },
      {
        id: 'n1',
        type: 'http',
        data: {
          method: 'POST',
          url: 'https://management.azure.com/definitions',
          sendHeaders: true,
          sendBody: true,
          bodyMode: 'json',
          headers: '{\n  "Authorization": "Bearer {{trigger.input.token}}"\n}',
          body: '{"inputs":{"token":"@{body(\'Get_token\')?[\'access_token\']}"}}',
        },
      },
    ],
    edges: [{ id: 'trigger->n1', source: 'trigger', target: 'n1' }],
  } as unknown as FlowGraph

  const sent: Array<Record<string, unknown>> = []
  const result = await interpretFlow(deploy, { token: 'REAL' }, { runAgent, runAction: recordingAction(sent) })

  assert.equal(result.status, 'succeeded')
  assert.equal(sent.length, 1)
})
