import { test } from 'node:test'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '@/features/flows/interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// The user's exported flow, verbatim.
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

test('EVIDENCE: what each boundary actually sees', async () => {
  const runAgent: RunAgentFn = async () => ({ output: 'agent' })
  const runAction: RunActionFn = async (node) => {
    console.log(`\n=== ${node.id} (${node.kind}) CONFIG IN ===`)
    console.log(JSON.stringify({ url: node.config.url, headers: node.config.headers }, null, 2))
    if (node.id === 'n2') {
      // The token endpoint succeeds and returns a real token.
      return { output: { ok: true, status: 200, headers: {}, body: { access_token: 'REAL-TOKEN-123' }, bodyText: '{"access_token":"REAL-TOKEN-123"}' } }
    }
    return { output: { ok: true, status: 200, headers: {}, body: {}, bodyText: '{}' } }
  }
  const result = await interpretFlow(graph, {}, { runAgent, runAction })
  console.log('\n=== STEP OUTCOMES ===')
  for (const s of result.steps) {
    console.log(`${s.nodeId}: ${s.status} -> ${JSON.stringify(s.output)?.slice(0, 200)}`)
  }
  console.log('\nrun status:', result.status, result.error ?? '')
})
