import { test } from 'node:test'
import assert from 'node:assert/strict'
import { n8nToFlow, looksLikeN8nWorkflow, fromN8nExpression, resolveN8nImportUrl, unwrapN8nPayload } from '@/lib/flows/import/from-n8n'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'

const n8nNode = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({ id: `id-${name}`, name, type, typeVersion: 1, position: [100, 200] as [number, number], parameters, ...extra })

const chain = (...names: string[]) => {
  const connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }> = {}
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }
  }
  return connections
}

test('looksLikeN8nWorkflow distinguishes n8n exports from Backstory packages', () => {
  assert.equal(looksLikeN8nWorkflow({ nodes: [n8nNode('W', 'n8n-nodes-base.webhook')], connections: {} }), true)
  assert.equal(looksLikeN8nWorkflow({ format: 'backstory-flow@1', flow: { name: 'x', graph: {} } }), false)
  assert.equal(looksLikeN8nWorkflow({ nodes: [], connections: {} }), false)
  assert.equal(looksLikeN8nWorkflow(null), false)
})

test('n8n expressions translate back to flow tokens', () => {
  const names = new Map([['HTTP Request', 'id-HTTP Request']])
  assert.equal(fromN8nExpression('={{ $json.account }}', names), '{{trigger.input.account}}')
  assert.equal(fromN8nExpression('={{ $node["HTTP Request"].json.status }}', names), '{{step.id-HTTP Request.output.status}}')
  assert.equal(fromN8nExpression("={{ $('HTTP Request').item.json.status }}", names), '{{step.id-HTTP Request.output.status}}')
  assert.equal(fromN8nExpression('plain text', names), 'plain text')
})

test('a webhook → http → if workflow converts to a runnable graph with real branches', () => {
  const workflow = {
    name: 'Lead router',
    nodes: [
      n8nNode('Webhook', 'n8n-nodes-base.webhook', { httpMethod: 'POST', path: 'lead' }),
      n8nNode('Fetch', 'n8n-nodes-base.httpRequest', { method: 'GET', url: '={{ $json.url }}' }),
      n8nNode('Check', 'n8n-nodes-base.if', {
        conditions: {
          combinator: 'and',
          conditions: [{ leftValue: '={{ $node["Fetch"].json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } }],
        },
      }),
      n8nNode('Set won', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'result', value: 'won', type: 'string' }] } }),
      n8nNode('Set lost', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'result', value: 'lost', type: 'string' }] } }),
    ],
    connections: {
      Webhook: { main: [[{ node: 'Fetch', type: 'main' as const, index: 0 }]] },
      Fetch: { main: [[{ node: 'Check', type: 'main' as const, index: 0 }]] },
      Check: {
        main: [
          [{ node: 'Set won', type: 'main' as const, index: 0 }],
          [{ node: 'Set lost', type: 'main' as const, index: 0 }],
        ],
      },
    },
  }
  const result = n8nToFlow(workflow)
  assert.equal(result.name, 'Lead router')
  const graph = flowGraphSchema.parse(result.graph)

  const trigger = graph.nodes.find((n) => n.type === 'trigger') as any
  assert.equal(trigger.data.trigger?.type, 'webhook')

  const http = graph.nodes.find((n) => n.type === 'http') as any
  assert.equal(http.data.method, 'GET')
  assert.equal(http.data.url, '{{trigger.input.url}}')

  const cond = graph.nodes.find((n) => n.type === 'condition') as any
  assert.deepEqual(cond.data.clauses, [{ left: '{{step.id-Fetch.output.status}}', op: 'eq', right: 'active' }])

  const transforms = graph.nodes.filter((n) => n.type === 'transform') as any[]
  assert.equal(transforms.length, 2)
  assert.deepEqual(transforms[0].data.fields, [{ name: 'result', value: 'won' }])

  const trueEdge = graph.edges.find((e) => e.source === cond.id && e.branch === 'true')
  const falseEdge = graph.edges.find((e) => e.source === cond.id && e.branch === 'false')
  assert.ok(trueEdge && falseEdge, 'IF outputs 0/1 map to true/false branches')

  // Immediately editable: the only thing standing between the import and a run
  // is authentication — HTTP steps never run credential-less, and an import
  // can't carry the source workspace's secrets, so the no-auth error is the
  // expected (and only) gap the user fills after importing.
  const validation = validateFlowGraph(graph)
  assert.deepEqual((validation.errors ?? []).map((error) => error.code), ['HTTP_NO_AUTH'])
})

test('code, wait, and merge nodes convert to their native equivalents', () => {
  const workflow = {
    name: 'Utility belt',
    nodes: [
      n8nNode('When clicking', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Code', 'n8n-nodes-base.code', { mode: 'runOnceForEachItem', jsCode: 'return item' }),
      n8nNode('Wait', 'n8n-nodes-base.wait', { resume: 'timeInterval', amount: 5, unit: 'minutes' }),
      n8nNode('Merge', 'n8n-nodes-base.merge', { mode: 'append' }),
    ],
    connections: chain('When clicking', 'Code', 'Wait', 'Merge'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const code = graph.nodes.find((n) => n.type === 'code') as any
  assert.equal(code.data.language, 'javascript')
  assert.equal(code.data.mode, 'each')
  assert.match(code.data.code, /return item/, 'original code preserved inside the compatibility shim')
  const wait = graph.nodes.find((n) => n.type === 'wait') as any
  assert.equal(wait.data.mode, 'duration')
  assert.equal(wait.data.amount, '5')
  assert.equal(wait.data.unit, 'minutes')
  const join = graph.nodes.find((n) => n.type === 'join') as any
  assert.equal(join.data.mode, 'append')
})

test('a tool-less AI Agent becomes a native ai step; credential-less app nodes become runnable passthrough stubs', () => {
  const workflow = {
    name: 'AI + Slack',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Think', '@n8n/n8n-nodes-langchain.agent', { text: 'Summarize {{ $json.body }}', options: { systemMessage: 'Be terse.' } }),
      n8nNode('Notify', 'n8n-nodes-base.slack', { channel: '#deals', text: 'done' }),
    ],
    connections: chain('Start', 'Think', 'Notify'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const ai = graph.nodes.find((n) => n.type === 'ai') as any
  assert.equal(ai.data.aiOp, 'ask')
  assert.match(ai.data.input ?? '', /Summarize/, 'the agent prompt is the step input')
  assert.match(ai.data.instructions ?? '', /Be terse/, 'the system message steers the step')
  assert.equal(result.agents.length, 0, 'no tools, no memory — nothing to create an agent for')
  // A known app node binds to the platform's OWN integration capability — the
  // step arrives runnable through the connected Slack account.
  const notify = graph.nodes.find((n) => n.type === 'tool' && (n as any).data.label === 'Notify') as any
  assert.ok(notify)
  assert.equal(notify.data.connectionId, 'nango:slack')
  assert.equal(notify.data.toolName, 'slack_post_message')
  assert.deepEqual(JSON.parse(notify.data.args), { channel: '#deals', text: 'done' })
  assert.ok(result.warnings.some((w) => /Notify/.test(w) && /Slack integration/.test(w)))
})

test('looping connections (Loop Over Items) are dropped so the graph stays acyclic', () => {
  const workflow = {
    name: 'Batch',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Loop', 'n8n-nodes-base.splitInBatches'),
      n8nNode('Work', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'x', value: '1' }] } }),
    ],
    connections: {
      Start: { main: [[{ node: 'Loop', type: 'main' as const, index: 0 }]] },
      Loop: { main: [[{ node: 'Work', type: 'main' as const, index: 0 }]] },
      // The n8n loop-back edge that would make our DAG cyclic:
      Work: { main: [[{ node: 'Loop', type: 'main' as const, index: 0 }]] },
    },
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const ids = new Map(graph.nodes.map((n) => [n.id, n]))
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target))
  }
  // No cycle: Work → Loop dropped.
  assert.ok(!graph.edges.some((e) => e.source === 'id-Work' && e.target === 'id-Loop'))
  assert.ok(result.warnings.some((w) => /loop/i.test(w)))
})

test('n8n.io template page URLs resolve to the template API; other URLs pass through', () => {
  assert.equal(
    resolveN8nImportUrl('https://n8n.io/workflows/2211-sync-crm-to-sheets/'),
    'https://api.n8n.io/api/templates/workflows/2211',
  )
  assert.equal(resolveN8nImportUrl('https://n8n.io/workflows/93'), 'https://api.n8n.io/api/templates/workflows/93')
  assert.equal(resolveN8nImportUrl('https://example.com/my-flow.json'), 'https://example.com/my-flow.json')
})

test('template-API and wrapped payloads unwrap to the inner workflow', () => {
  const inner = { name: 'T', nodes: [n8nNode('W', 'n8n-nodes-base.webhook')], connections: {} }
  assert.deepEqual(unwrapN8nPayload({ workflow: inner }), inner)
  assert.deepEqual(unwrapN8nPayload({ workflow: { workflow: inner } }), inner)
  assert.deepEqual(unwrapN8nPayload(inner), inner)
  assert.deepEqual(unwrapN8nPayload({ some: 'thing' }), { some: 'thing' })
})

test('an AI Agent cluster (model + tools + memory + parser) imports as a REAL agent step with a creation spec', () => {
  const workflow = {
    name: 'Agent cluster',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Prep', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'agentPrompt', value: 'Analyze it' }] } }),
      n8nNode('Agent', '@n8n/n8n-nodes-langchain.agent', {
        text: '={{ $json.agentPrompt }}',
        options: { systemMessage: 'You are a deal-desk analyst. Investigate the opportunity thoroughly.' },
      }),
      n8nNode('Claude', '@n8n/n8n-nodes-langchain.lmChatAnthropic', { model: 'claude-x' }),
      n8nNode('MCP', '@n8n/n8n-nodes-langchain.mcpClientTool', { sseEndpoint: 'https://mcp.example/mcp', includeTools: ['find_opportunity'] }),
      n8nNode('Send email', 'n8n-nodes-base.gmailTool', { operation: 'send', descriptionType: 'auto' }),
      n8nNode('Memory', '@n8n/n8n-nodes-langchain.memoryBufferWindow', {}),
      n8nNode('Parser', '@n8n/n8n-nodes-langchain.outputParserStructured', { jsonSchemaExample: '{"summary": "…", "risk_score": 3}' }),
    ],
    connections: {
      Start: { main: [[{ node: 'Prep', type: 'main' as const, index: 0 }]] },
      Prep: { main: [[{ node: 'Agent', type: 'main' as const, index: 0 }]] },
      Claude: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] } as never,
      MCP: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] } as never,
      'Send email': { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] } as never,
      Memory: { ai_memory: [[{ node: 'Agent', type: 'ai_memory', index: 0 }]] } as never,
      Parser: { ai_outputParser: [[{ node: 'Agent', type: 'ai_outputParser', index: 0 }]] } as never,
    },
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  // The model/tool providers are the agent's CONFIG, not steps — absent entirely.
  assert.ok(!graph.nodes.some((n: any) => ['Claude', 'MCP', 'Send email', 'Memory', 'Parser'].includes(n.data?.label)))
  // And nothing wired them to the trigger as fake roots.
  assert.equal(graph.edges.filter((e) => e.source === 'trigger').length, 1)

  // The agent node is a REAL agent step (not a bare ai step), fed by its upstream.
  const agent = graph.nodes.find((n) => n.type === 'agent') as any
  assert.ok(agent, 'the n8n AI Agent becomes an agent step')
  assert.equal(agent.data.input, '{{step.id-Prep.output.agentPrompt}}')
  assert.equal(agent.data.responseFormat, 'structured', 'the structured output parser carries over')
  assert.deepEqual(agent.data.outputFields.map((f: any) => f.name), ['summary', 'risk_score'])

  // The spec carries everything the route needs to CREATE the agent.
  assert.equal(result.agents.length, 1)
  const spec = result.agents[0]
  assert.equal(spec.placeholderId, agent.data.agentId, 'graph placeholder and spec agree')
  assert.equal(spec.name, 'Agent')
  assert.equal(spec.model, 'claude-x')
  assert.match(spec.instructions, /deal-desk analyst/, 'the system message becomes the objective')
  assert.match(spec.instructions, /find_opportunity/, 'the MCP tool inventory rides along')
  assert.deepEqual(spec.mcpEndpoints, ['https://mcp.example/mcp'])
  assert.deepEqual(spec.integrations, ['gmail'], 'the gmailTool sub-node names its integration')
  assert.equal(spec.hasMemory, true)
  assert.ok(result.warnings.some((w) => /Agent step/.test(w)), 'the created agent is called out')
})

test('$json resolves to each node’s own upstream: trigger input for the first step, the parent step after', () => {
  const workflow = {
    name: 'Chained refs',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('First', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'a', value: '={{ $json.seed }}' }] } }),
      n8nNode('Second', 'n8n-nodes-base.httpRequest', { method: 'GET', url: '={{ $json.a }}' }),
    ],
    connections: chain('Start', 'First', 'Second'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const first = graph.nodes.find((n) => n.type === 'transform') as any
  assert.deepEqual(first.data.fields, [{ name: 'a', value: '{{trigger.input.seed}}' }])
  const second = graph.nodes.find((n) => n.type === 'http') as any
  assert.equal(second.data.url, '{{step.id-First.output.a}}')
})

test('imported code steps get the n8n compatibility shim and run against our sandbox', async () => {
  const workflow = {
    name: 'Code compat',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Params', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'names', value: 'a,b' }] } }),
      n8nNode('Split', 'n8n-nodes-base.code', {
        jsCode: "const names = String($('Params').first().json.names || '').split(',');\nreturn names.map(accountName => ({ json: { accountName } }));",
      }),
    ],
    connections: chain('Start', 'Params', 'Split'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const code = graph.nodes.find((n) => n.type === 'code') as any
  assert.match(code.data.code, /__n8nLabelToId/, 'the shim is prepended')
  assert.match(code.data.code, /"Params":\s*"id-Params"/, 'label → id map is embedded')

  // Execute the converted code through the REAL sandbox: $('Params') reads
  // context.steps, $input wraps the incoming value, and the [{json}] return
  // unwraps to a plain array downstream steps can consume.
  const { runFlowCode } = await import('@/features/flows/code-runner')
  const result = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: code.data.code,
    input: { names: 'a,b' },
    context: { steps: { 'id-Params': { output: { names: 'crowdstrike, seismic' } } } },
  })
  assert.deepEqual(result.output, [{ accountName: 'crowdstrike' }, { accountName: ' seismic' }])
})

test('credentialed app nodes bind to platform integrations; uncovered capabilities become direct API requests', () => {
  const workflow = {
    name: 'App nodes',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Prep', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'subject', value: 'Hi' }] } }),
      n8nNode(
        'Send Report Email',
        'n8n-nodes-base.emailSend',
        { fromEmail: 'a@b.c', toEmail: 'a@b.c', subject: '={{ $json.subject }}' },
        { credentials: { smtp: { id: '1', name: 'SMTP' } } },
      ),
      n8nNode(
        'Upload file',
        'n8n-nodes-base.googleDrive',
        { operation: 'upload', name: 'report.html' },
        { credentials: { googleDriveOAuth2Api: { id: '2', name: 'GD' } } },
      ),
    ],
    connections: chain('Start', 'Prep', 'Send Report Email', 'Upload file'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  // Email delivery is a capability the platform OWNS — the step arrives bound.
  const email = graph.nodes.find((n: any) => n.data?.label === 'Send Report Email') as any
  assert.equal(email.type, 'tool')
  assert.equal(email.data.connectionId, 'native:email')
  assert.equal(email.data.toolName, 'send')
  const args = JSON.parse(email.data.args)
  assert.equal(args.to, 'a@b.c')
  assert.equal(args.subject, '{{step.id-Prep.output.subject}}', 'args carried over with translated references')
  // Drive UPLOAD is not covered (the Drive integration is read-only) — the
  // step becomes a DIRECT API REQUEST with the endpoint prefilled, and the
  // warning names the missing capability.
  const upload = graph.nodes.find((n: any) => n.data?.label === 'Upload file') as any
  assert.equal(upload.type, 'http')
  assert.match(upload.data.url, /googleapis\.com\/upload\/drive/)
  assert.ok(result.warnings.some((w) => /Upload file/.test(w) && /direct API request/i.test(w)))
})

test('utility nodes map to native data ops; credential-less leftovers become passthrough code stubs', () => {
  const workflow = {
    name: 'Utilities',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Dedupe', 'n8n-nodes-base.removeDuplicates', {}),
      n8nNode('Cap', 'n8n-nodes-base.limit', { maxItems: 5 }),
      n8nNode('Leftover', 'n8n-nodes-base.executionData', {}),
    ],
    connections: chain('Start', 'Dedupe', 'Cap', 'Leftover'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const ops = graph.nodes.filter((n) => n.type === 'data') as any[]
  assert.deepEqual(ops.map((o) => o.data.op).sort(), ['limit', 'removeDuplicates'])
  assert.ok(ops.every((o) => typeof o.data.input === 'string' && o.data.input.startsWith('{{')), 'data ops read their upstream')
  const stub = graph.nodes.find((n) => n.type === 'code' && (n as any).data.label === 'Leftover') as any
  assert.ok(stub, 'an unmapped credential-less node becomes a runnable passthrough stub, not a dead note')
  assert.match(stub.data.code, /return input/)
  assert.ok(result.warnings.some((w) => /Leftover/.test(w)))
})

test('Loop Over Items imports as a native Loop step: body per item, done edge continues, no dropped connections', () => {
  const workflow = {
    name: 'Batch',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Split', 'n8n-nodes-base.code', { jsCode: 'return [{ json: { n: 1 } }, { json: { n: 2 } }]' }),
      n8nNode('Loop', 'n8n-nodes-base.splitInBatches', { batchSize: 1 }),
      n8nNode('Work', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'x', value: '={{ $json.n }}' }] } }),
      n8nNode('After', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'done', value: '={{ $json.count }}' }] } }),
    ],
    connections: {
      Start: { main: [[{ node: 'Split', type: 'main' as const, index: 0 }]] },
      Split: { main: [[{ node: 'Loop', type: 'main' as const, index: 0 }]] },
      // Output 0 = done → After; output 1 = loop → Work; Work loops back.
      Loop: {
        main: [
          [{ node: 'After', type: 'main' as const, index: 0 }],
          [{ node: 'Work', type: 'main' as const, index: 0 }],
        ],
      },
      Work: { main: [[{ node: 'Loop', type: 'main' as const, index: 0 }]] },
    },
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const loop = graph.nodes.find((n) => n.type === 'loop') as any
  assert.ok(loop, 'splitInBatches becomes a native Loop step')
  assert.equal(loop.data.over, '{{step.id-Split.output}}', 'the loop iterates its upstream list')
  assert.deepEqual(loop.data.body, ['id-Work'], 'the loop branch is the body')
  const work = graph.nodes.find((n: any) => n.data?.label === 'Work') as any
  assert.deepEqual(work.data.fields, [{ name: 'x', value: '{{item.n}}' }], 'body steps read the current item')
  // Done edge continues; no edges touch the body; nothing was "dropped".
  assert.ok(graph.edges.some((e) => e.source === loop.id && e.target === 'id-After'))
  assert.ok(!graph.edges.some((e) => e.source === 'id-Work' || e.target === 'id-Work'), 'body steps live in the loop, not on edges')
  assert.ok(!result.warnings.some((w) => /[Dd]ropped/.test(w)), 'the loop-back edge is understood, not dropped')
  const validation = validateFlowGraph(graph)
  assert.deepEqual(validation.errors ?? [], [])
})

test('retrieval Q&A becomes Knowledge search + answer; vector store load/insert map to knowledge/ingestion guidance', () => {
  const workflow = {
    name: 'RAG',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('QA', '@n8n/n8n-nodes-langchain.chainRetrievalQa', { text: '={{ $json.question }}' }),
      n8nNode('Search Docs', '@n8n/n8n-nodes-langchain.vectorStoreInMemory', { mode: 'load', prompt: '={{ $json.question }}', topK: 4 }),
      n8nNode('Ingest', '@n8n/n8n-nodes-langchain.vectorStoreInMemory', { mode: 'insert', memoryKey: 'kb' }),
      n8nNode('Done', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'answer', value: 'x' }] } }),
    ],
    connections: {
      Start: { main: [[{ node: 'QA', type: 'main' as const, index: 0 }]] },
      QA: { main: [[{ node: 'Search Docs', type: 'main' as const, index: 0 }]] },
      'Search Docs': { main: [[{ node: 'Ingest', type: 'main' as const, index: 0 }]] },
      Ingest: { main: [[{ node: 'Done', type: 'main' as const, index: 0 }]] },
    },
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const knowledgeSteps = graph.nodes.filter((n) => n.type === 'knowledge') as any[]
  assert.equal(knowledgeSteps.length, 2, 'retrieval QA and the load-mode store are both Knowledge searches')
  const qa = knowledgeSteps.find((k) => k.data.label === 'QA')
  assert.equal(qa.data.query, '{{trigger.input.question}}')
  const answer = graph.nodes.find((n: any) => n.type === 'ai' && /answer/.test(n.data?.label ?? '')) as any
  assert.ok(answer, 'a synthesized answer step follows the QA search')
  assert.match(answer.data.input, /Retrieved context/)
  // The QA node's outgoing connection re-sources from the answer step.
  assert.ok(graph.edges.some((e) => e.source === qa.id && e.target === answer.id))
  assert.ok(graph.edges.some((e) => e.source === answer.id && e.target === 'id-Search Docs'))
  const search = knowledgeSteps.find((k) => k.data.label === 'Search Docs')
  assert.equal(search.data.topK, 4)
  const ingest = graph.nodes.find((n: any) => n.data?.label === 'Ingest') as any
  assert.equal(ingest.type, 'code', 'ingestion passes through with Knowledge-upload guidance')
  assert.ok(result.warnings.some((w) => /Ingest/.test(w) && /Knowledge/.test(w)))
})

test('extractFromFile parses the file reference for real; convertToFile produces a file-shaped object', async () => {
  const workflow = {
    name: 'Files',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Parse CSV', 'n8n-nodes-base.extractFromFile', { operation: 'csv' }),
      n8nNode('To File', 'n8n-nodes-base.convertToFile', { operation: 'toJson', options: { fileName: 'out.json' } }),
    ],
    connections: chain('Start', 'Parse CSV', 'To File'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const parse = graph.nodes.find((n: any) => n.data?.label === 'Parse CSV') as any
  const convert = graph.nodes.find((n: any) => n.data?.label === 'To File') as any
  assert.equal(parse.type, 'code')
  assert.equal(convert.type, 'code')

  const { runFlowCode } = await import('@/features/flows/code-runner')
  const parsed = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: parse.data.code,
    input: { fileId: 'f1', filename: 'deals.csv', mimeType: 'text/csv', size: 10, url: 'u', content: 'name,amount\n"Acme, Inc",100\nGlobex,250' },
    context: { steps: {} },
  })
  assert.deepEqual(parsed.output, [
    { name: 'Acme, Inc', amount: '100' },
    { name: 'Globex', amount: '250' },
  ])
  const converted = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: convert.data.code,
    input: [{ a: 1 }],
    context: { steps: {} },
  })
  assert.deepEqual(converted.output, { filename: 'out.json', mimeType: 'application/json', content: JSON.stringify([{ a: 1 }], null, 2) })
})

test('a MAIN-chain MCP client call becomes a tool step named after its MCP tool — never an AI step', () => {
  const workflow = {
    name: 'MCP call',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode(
        'Backstory MCP: Top Records',
        '@n8n/n8n-nodes-langchain.mcpClient',
        { endpointUrl: 'https://mcp.backstory.ai/mcp', tool: { value: 'top_records', mode: 'list' } },
        { credentials: { mcpOAuth2Api: { id: '9', name: 'MCP' } } },
      ),
    ],
    connections: chain('Start', 'Backstory MCP: Top Records'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const tool = graph.nodes.find((n) => n.type === 'tool') as any
  assert.ok(tool, 'mcpClient on the main chain is a TOOL CALL, not an LLM')
  assert.equal(tool.data.toolName, 'top_records')
  assert.equal(graph.nodes.filter((n) => n.type === 'ai').length, 0)
})

test('respondToWebhook becomes a native output step carrying the translated response', () => {
  const workflow = {
    name: 'Dashboard',
    nodes: [
      n8nNode('Webhook', 'n8n-nodes-base.webhook', { path: 'dash', responseMode: 'responseNode' }),
      n8nNode('Render', 'n8n-nodes-base.code', { jsCode: 'return { html: "<b>hi</b>" }' }),
      n8nNode('Respond to Webhook', 'n8n-nodes-base.respondToWebhook', { respondWith: 'text', responseBody: '={{ $json.html }}' }),
    ],
    connections: chain('Webhook', 'Render', 'Respond to Webhook'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const output = graph.nodes.find((n) => n.type === 'output') as any
  assert.ok(output, 'respondToWebhook → output step (the webhook trigger replies with the run result)')
  assert.deepEqual(output.data.outputs, [{ name: 'response', value: '{{step.id-Render.output.html}}' }])
})

test('schedule triggers keep their cadence: weekly interval with an hour imports as a real schedule', () => {
  const workflow = {
    name: 'Weekly',
    nodes: [
      n8nNode('Weekly Schedule', 'n8n-nodes-base.scheduleTrigger', {
        rule: { interval: [{ field: 'weeks', triggerAtDay: [1], triggerAtHour: 8 }] },
      }),
      n8nNode('Work', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'a', value: 'b' }] } }),
    ],
    connections: chain('Weekly Schedule', 'Work'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const trigger = graph.nodes.find((n) => n.type === 'trigger') as any
  assert.equal(trigger.data.trigger.type, 'schedule')
  assert.equal(trigger.data.trigger.schedule.type, 'weekly')
  assert.equal(trigger.data.trigger.schedule.time, '08:00')
})

test('http query parameters and auth carry over: query lands on the step, credentialed auth warns', () => {
  const workflow = {
    name: 'API pull',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode(
        'GET /opportunities',
        'n8n-nodes-base.httpRequest',
        {
          url: 'https://api.people.ai/opportunities',
          method: 'GET',
          authentication: 'genericCredentialType',
          genericAuthType: 'httpHeaderAuth',
          sendQuery: true,
          queryParameters: { parameters: [{ name: 'offset', value: '0' }, { name: 'limit', value: '1000' }] },
        },
        { credentials: { httpHeaderAuth: { id: '1', name: 'Header Auth' } } },
      ),
    ],
    connections: chain('Start', 'GET /opportunities'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const http = graph.nodes.find((n) => n.type === 'http') as any
  assert.ok(http, 'a credentialed httpRequest is still an http step, not a tool')
  assert.deepEqual(JSON.parse(http.data.query), { offset: '0', limit: '1000' })
  assert.ok(result.warnings.some((w) => /GET \/opportunities/.test(w) && /auth/i.test(w)), 'the dropped credential is called out')
})

test('giant embedded data-URIs in code are stripped so the import fits the 100K code cap', () => {
  const bigAsset = 'data:image/jpeg;base64,' + '/9j/4AAQ'.repeat(20_000)
  const workflow = {
    name: 'Heavy code',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Render', 'n8n-nodes-base.code', {
        jsCode: `const HEADER_IMAGES = ["${bigAsset}"];\nreturn { count: HEADER_IMAGES.length }`,
      }),
    ],
    connections: chain('Start', 'Render'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph) // must not throw the 100K cap
  const code = graph.nodes.find((n) => n.type === 'code') as any
  assert.ok(code.data.code.length <= 100_000)
  assert.match(code.data.code, /removed-on-import/)
  assert.match(code.data.code, /return \{ count: HEADER_IMAGES\.length \}/, 'the actual logic survives intact')
  assert.ok(result.warnings.some((w) => /Render/.test(w) && /asset/i.test(w)))
})

test('LangChain chains map to shaped ai ops: extractor → extract with fields, summarization → summarize', () => {
  const workflow = {
    name: 'Chains',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Extract', '@n8n/n8n-nodes-langchain.informationExtractor', {
        text: '={{ $json.email }}',
        attributes: { attributes: [
          { name: 'company', type: 'string', description: 'Company name' },
          { name: 'seats', type: 'number' },
        ] },
      }),
      n8nNode('Digest', '@n8n/n8n-nodes-langchain.chainSummarization', {}),
    ],
    connections: chain('Start', 'Extract', 'Digest'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const extract = graph.nodes.find((n: any) => n.data?.label === 'Extract') as any
  assert.equal(extract.type, 'ai')
  assert.equal(extract.data.aiOp, 'extract')
  assert.equal(extract.data.input, '{{trigger.input.email}}')
  assert.deepEqual(extract.data.outputFields, [
    { name: 'company', type: 'string', description: 'Company name' },
    { name: 'seats', type: 'number' },
  ])
  const digest = graph.nodes.find((n: any) => n.data?.label === 'Digest') as any
  assert.equal(digest.data.aiOp, 'summarize')
  assert.equal(digest.data.input, '{{step.id-Extract.output}}', 'summarize reads its actual upstream')
})

test('a text classifier becomes categorize + a routing switch so each category output stays a real branch', () => {
  const workflow = {
    name: 'Router',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Classify', '@n8n/n8n-nodes-langchain.textClassifier', {
        inputText: '={{ $json.body }}',
        categories: { categories: [{ category: 'Support', description: 'help requests' }, { category: 'Sales' }] },
      }),
      n8nNode('To support', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'queue', value: 'support' }] } }),
      n8nNode('To sales', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'queue', value: 'sales' }] } }),
    ],
    connections: {
      Start: { main: [[{ node: 'Classify', type: 'main' as const, index: 0 }]] },
      Classify: {
        main: [
          [{ node: 'To support', type: 'main' as const, index: 0 }],
          [{ node: 'To sales', type: 'main' as const, index: 0 }],
        ],
      },
    },
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const ai = graph.nodes.find((n) => n.type === 'ai') as any
  assert.equal(ai.data.aiOp, 'categorize')
  assert.deepEqual(ai.data.categories, ['Support', 'Sales'])
  const router = graph.nodes.find((n) => n.type === 'switch') as any
  assert.ok(router, 'a routing switch is synthesized after the classifier')
  assert.deepEqual(router.data.cases.map((c: any) => c.right), ['Support', 'Sales'])
  assert.ok(router.data.cases.every((c: any) => c.left === `{{step.${ai.id}.output.category}}`))
  // ai → switch, then per-category branches out of the switch.
  assert.ok(graph.edges.some((e) => e.source === ai.id && e.target === router.id))
  const supportEdge = graph.edges.find((e) => e.target === 'id-To support')
  const salesEdge = graph.edges.find((e) => e.target === 'id-To sales')
  assert.equal(supportEdge?.source, router.id)
  assert.equal(supportEdge?.branch, 'case-0')
  assert.equal(salesEdge?.branch, 'case-1')
})

test('stopAndError → stop step; executeWorkflow → an unbound subflow step', () => {
  const workflow = {
    name: 'Structural',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Child', 'n8n-nodes-base.executeWorkflow', { workflowId: { value: 'abc' } }),
      n8nNode('Fail', 'n8n-nodes-base.stopAndError', { errorType: 'errorMessage', errorMessage: 'No records found' }),
    ],
    connections: chain('Start', 'Child', 'Fail'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const subflow = graph.nodes.find((n) => n.type === 'subflow') as any
  assert.ok(subflow, 'executeWorkflow becomes a subflow step')
  assert.equal(subflow.data.flowId, '', 'unbound — the user picks the imported child flow')
  const stop = graph.nodes.find((n) => n.type === 'stop') as any
  assert.equal(stop.data.reason, 'No records found')
  assert.ok(result.warnings.some((w) => /Child/.test(w) && /[Ss]ubflow/.test(w)))
})

test('chat triggers import as webhook triggers with chatInput guidance', () => {
  const workflow = {
    name: 'Chat agent',
    nodes: [
      n8nNode('When chat message received', '@n8n/n8n-nodes-langchain.chatTrigger', {}),
      n8nNode('Reply', '@n8n/n8n-nodes-langchain.chainLlm', { text: '={{ $json.chatInput }}' }),
    ],
    connections: chain('When chat message received', 'Reply'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const trigger = graph.nodes.find((n) => n.type === 'trigger') as any
  assert.equal(trigger.data.trigger?.type, 'webhook')
  const ai = graph.nodes.find((n) => n.type === 'ai') as any
  assert.equal(ai.data.input, '{{trigger.input.chatInput}}', 'chatInput references point at the webhook payload')
  assert.ok(result.warnings.some((w) => /chatInput/.test(w)))
})

test('a workflow with no trigger gets a manual trigger wired to its roots', () => {
  const workflow = {
    name: 'Headless',
    nodes: [n8nNode('Only', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'a', value: 'b' }] } })],
    connections: {},
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const trigger = graph.nodes.find((n) => n.type === 'trigger')
  assert.ok(trigger)
  assert.ok(graph.edges.some((e) => e.source === trigger!.id && e.target === 'id-Only'))
})

test('real JS expressions never mistranslate into garbage tokens', () => {
  const names = new Map([['Params', 'params']])
  // A ternary starting with $json must stay raw (untranslatable), not become a token.
  const ternary = "={{ $json.query && ($json.query.accounts || $json.query.account) ? $json.query.accounts : 'Aveva' }}"
  let flagged = 0
  const out = fromN8nExpression(ternary, names, 'trigger.input', () => flagged++)
  assert.equal(flagged, 1)
  assert.match(out, /\{\{ ?\$json\.query/)
  assert.doesNotMatch(out, /trigger\.input/)
  // Plain paths (incl. brackets) still translate.
  assert.equal(fromN8nExpression('={{ $json.a[0].b }}', names, 'trigger.input'), '{{trigger.input.a[0].b}}')
})

test("$('Node').item paired-item references become {{item.…}} inside a per-item step", () => {
  const workflow = {
    name: 'Per item',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Fan', 'n8n-nodes-base.code', { jsCode: 'return [{ json: { id: 1 } }, { json: { id: 2 } }]' }),
      n8nNode(
        'Post',
        'n8n-nodes-base.httpRequest',
        { method: 'POST', url: "={{ $json.url }}", jsonBody: "={{ $('Fan').item.json.id }} vs {{ $('Fan').first().json.id }}" },
        {},
      ),
    ],
    connections: chain('Start', 'Fan', 'Post'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const http = graph.nodes.find((n) => n.type === 'http') as any
  assert.deepEqual(http.data.perItem, { over: '{{step.id-Fan.output}}' })
  assert.equal(http.data.url, '{{item.url}}')
  // .item (paired) → current item; .first() → whole-step reference.
  assert.equal(http.data.body, '{{item.id}} vs {{step.id-Fan.output.id}}')
})

test('a Set node with JS expressions imports as a code step evaluating the originals', () => {
  const workflow = {
    name: 'JS set',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Params', 'n8n-nodes-base.set', {
        assignments: {
          assignments: [
            { id: '1', name: 'accounts', type: 'string', value: "={{ $json.accounts ? $json.accounts : 'Aveva' }}" },
            { id: '2', name: 'to', type: 'string', value: 'x@y.z' },
            { id: '3', name: 'testMode', type: 'boolean', value: true },
          ],
        },
      }),
    ],
    connections: chain('Start', 'Params'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const params = graph.nodes.find((n: any) => n.data?.label === 'Params') as any
  assert.equal(params.type, 'code')
  assert.equal(params.data.input, '{{trigger.input}}')
  assert.match(params.data.code, /"accounts": \(\$json\.accounts \? \$json\.accounts : 'Aveva'\)/)
  assert.match(params.data.code, /"to": "x@y.z"/)
  assert.match(params.data.code, /"testMode": true/)
  assert.ok(result.warnings.some((w) => w.includes('Params') && w.includes('Code step')))
})

test('a mid-chain No-Op imports as a passthrough code step so downstream references resolve', () => {
  const workflow = {
    name: 'NoOp chain',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Make', 'n8n-nodes-base.code', { jsCode: 'return [{ json: { a: 1 } }]' }),
      n8nNode('Review', 'n8n-nodes-base.noOp', {}),
      n8nNode('After', 'n8n-nodes-base.code', { jsCode: 'return $input.all()' }),
    ],
    connections: chain('Start', 'Make', 'Review', 'After'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const review = graph.nodes.find((n: any) => n.data?.label === 'Review') as any
  assert.equal(review.type, 'code')
  assert.match(review.data.code, /return input/)
})

test('untranslatable JS in an HTTP url hoists into an inserted compute step the request references', () => {
  const workflow = {
    name: 'Hoist',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Call', 'n8n-nodes-base.httpRequest', {
        method: 'GET',
        url: '=https://api.example.com/x?since={{ Math.floor((Date.now() - 1000) / 1000) }}&id={{ $json.id }}',
      }),
    ],
    connections: chain('Start', 'Call'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const http = graph.nodes.find((n) => n.type === 'http') as any
  const compute = graph.nodes.find((n: any) => n.type === 'code' && String(n.data?.label ?? '').includes('expressions')) as any
  assert.ok(compute, 'a compute code step is inserted')
  assert.equal(http.data.url, `https://api.example.com/x?since={{step.${compute.id}.output.expr0}}&id={{trigger.input.id}}`)
  assert.match(compute.data.code, /Math\.floor\(\(Date\.now\(\) - 1000\) \/ 1000\)/)
  // Wiring: trigger → compute → http.
  assert.ok(graph.edges.some((e) => e.source === 'trigger' && e.target === compute.id))
  assert.ok(graph.edges.some((e) => e.source === compute.id && e.target === http.id))
  // The kept-as-is warning is replaced by the hoist explanation.
  assert.ok(!result.warnings.some((w) => w.includes('kept as-is')))
  assert.ok(result.warnings.some((w) => w.includes('moved into an inserted Code step')))
})

test('a per-run agent system message rides on the agent step input, not the created agent', () => {
  const workflow = {
    name: 'Dynamic agent',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Prep', 'n8n-nodes-base.code', { jsCode: 'return [{ json: { sys: "be brief", task: "do it" } }]' }),
      n8nNode('Agent', '@n8n/n8n-nodes-langchain.agent', {
        promptType: 'define',
        text: '={{ $json.task }}',
        options: { systemMessage: '={{ $json.sys }}' },
      }),
      n8nNode('Model', '@n8n/n8n-nodes-langchain.lmChatAnthropic', { model: 'claude-sonnet-5' }, { credentials: { anthropicApi: {} } }),
      n8nNode('MCP', '@n8n/n8n-nodes-langchain.mcpClientTool', { endpointUrl: 'https://mcp.example.com/mcp' }, { credentials: { httpHeaderAuth: {} } }),
    ],
    connections: {
      ...chain('Start', 'Prep', 'Agent'),
      Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel' as const, index: 0 }]] },
      MCP: { ai_tool: [[{ node: 'Agent', type: 'ai_tool' as const, index: 0 }]] },
    } as any,
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const agent = graph.nodes.find((n) => n.type === 'agent') as any
  // Per-item over the prep list; system message + task resolve per item.
  assert.deepEqual(agent.data.perItem, { over: '{{step.id-Prep.output}}' })
  assert.equal(agent.data.input, '{{item.sys}}\n\n{{item.task}}')
  const spec = result.agents[0]
  assert.ok(!spec.instructions.includes('{{'), 'created agent instructions carry no flow tokens')
  assert.ok(spec.instructions.includes('imported from an n8n workflow'))
})

test('a raw Slack API HTTP call binds to the Slack integration read tool', () => {
  const workflow = {
    name: 'Slack read',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Fan', 'n8n-nodes-base.code', { jsCode: 'return [{ json: { ch: "C1" } }]' }),
      n8nNode(
        'Read Channel',
        'n8n-nodes-base.httpRequest',
        { method: 'GET', url: '=https://slack.com/api/conversations.history?channel={{ $json.ch }}&oldest={{ Math.floor(Date.now()/1000) }}&limit=100' },
        { credentials: { httpHeaderAuth: { id: '1', name: 'Slack token' } } },
      ),
    ],
    connections: chain('Start', 'Fan', 'Read Channel'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const read = graph.nodes.find((n) => n.type === 'tool') as any
  assert.equal(read.data.connectionId, 'nango:slack')
  assert.equal(read.data.toolName, 'slack_read_messages')
  assert.deepEqual(JSON.parse(read.data.args), { channel: '{{item.ch}}', limit: 100 })
  assert.deepEqual(read.data.perItem, { over: '{{step.id-Fan.output}}' })
  assert.ok(result.warnings.some((w) => /oldest/.test(w)), 'the unsupported time-window param is called out')
})

test('n8n memory and model sub-nodes become the agent STEP configuration', () => {
  const workflow = {
    name: 'Remembering agent',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Agent', '@n8n/n8n-nodes-langchain.agent', { text: 'hi', options: {} }),
      n8nNode('Model', '@n8n/n8n-nodes-langchain.lmChatAnthropic', { model: 'claude-sonnet-5' }, { credentials: { anthropicApi: {} } }),
      n8nNode('Memory', '@n8n/n8n-nodes-langchain.memoryPostgresChat', { sessionKey: '={{ $json.account }}', contextWindowLength: 8 }),
    ],
    connections: {
      ...chain('Start', 'Agent'),
      Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel' as const, index: 0 }]] },
      Memory: { ai_memory: [[{ node: 'Agent', type: 'ai_memory' as const, index: 0 }]] },
    } as any,
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const agent = graph.nodes.find((n) => n.type === 'agent') as any
  assert.equal(agent.data.model, 'claude-sonnet-5', 'the chat-model attachment pins the step model')
  assert.equal(agent.data.memory.store, 'postgres')
  assert.equal(agent.data.memory.sessionKey, '{{trigger.input.account}}')
  assert.equal(agent.data.memory.window, 8)
  assert.equal(result.agents[0].hasMemory, true)
  assert.ok(result.warnings.some((w) => /imported as step memory/.test(w)))
})

test('a Backstory MCP client call binds to the platform Sales AI plane', () => {
  const workflow = {
    name: 'MCP',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Top', 'n8n-nodes-base.mcpClient', { endpointUrl: 'https://mcp.backstory.ai/mcp', tool: { value: 'top_records' } }),
    ],
    connections: chain('Start', 'Top'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const tool = graph.nodes.find((n) => n.type === 'tool') as any
  assert.equal(tool.data.connectionId, 'people_ai:backstory')
  assert.equal(tool.data.toolName, 'top_records')
})

test('the data-transformation node family imports as native data ops with settings intact', () => {
  const workflow = {
    name: 'Transforms',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Shift', 'n8n-nodes-base.dateTime', { operation: 'subtractFromDate', date: '={{ $json.closeDate }}', duration: '7', timeUnit: 'days' }),
      n8nNode('Between', 'n8n-nodes-base.dateTime', { operation: 'getTimeBetweenDates', startDate: '={{ $json.start }}', endDate: '={{ $json.end }}', units: 'hours' }),
      n8nNode('Rename', 'n8n-nodes-base.renameKeys', { keys: { key: [{ currentKey: 'acct_nm', newKey: 'account_name' }] } }),
      n8nNode('To HTML', 'n8n-nodes-base.markdown', { mode: 'markdownToHtml', markdown: '={{ $json.report }}' }),
      n8nNode('To JSON', 'n8n-nodes-base.xml', { mode: 'xmlToJson' }),
      n8nNode('Split', 'n8n-nodes-base.splitOut', { fieldToSplitOut: 'contacts' }),
    ],
    connections: chain('Start', 'Shift', 'Between', 'Rename', 'To HTML', 'To JSON', 'Split'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const dataOps = Object.fromEntries(
    graph.nodes.filter((node) => node.type === 'data').map((node) => [node.id, node.data]),
  ) as Record<string, { op: string; amount?: string; unit?: string; to?: string; fields?: { name: string; value: string }[]; by?: string; input?: string }>

  assert.equal(dataOps['id-Shift'].op, 'dateShift')
  assert.equal(dataOps['id-Shift'].amount, '-7')
  assert.equal(dataOps['id-Shift'].unit, 'days')
  assert.equal(dataOps['id-Between'].op, 'dateDiff')
  assert.equal(dataOps['id-Between'].unit, 'hours')
  assert.match(dataOps['id-Between'].to ?? '', /end/)
  assert.equal(dataOps['id-Rename'].op, 'renameKeys')
  assert.deepEqual(dataOps['id-Rename'].fields, [{ name: 'acct_nm', value: 'account_name' }])
  assert.equal(dataOps['id-To HTML'].op, 'markdownToHtml')
  assert.equal(dataOps['id-To JSON'].op, 'xmlParse')
  assert.equal(dataOps['id-Split'].op, 'flatten')
  assert.equal(dataOps['id-Split'].by, 'contacts')

  // The whole converted graph still validates as runnable.
  const issues = validateFlowGraph(graph).issues.filter((issue) => issue.level === 'error')
  assert.deepEqual(issues, [])
})
