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

  // Immediately usable: the imported graph passes flow validation.
  const validation = validateFlowGraph(graph)
  assert.deepEqual(validation.errors ?? [], [])
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
  // Without a credential binding we can't infer the integration — but the
  // chain must keep RUNNING: a passthrough stub, not a dead note.
  const stub = graph.nodes.find((n) => n.type === 'code' && (n as any).data.label === 'Notify') as any
  assert.ok(stub)
  assert.match(stub.data.code, /return input/)
  assert.ok(result.warnings.some((w) => /Notify/.test(w)), 'the unconverted step is named in the warnings')
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

test('credentialed app nodes become UNBOUND TOOL STEPS with translated args — not dead notes', () => {
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
  const tools = graph.nodes.filter((n) => n.type === 'tool') as any[]
  assert.equal(tools.length, 2)
  const email = tools.find((t) => t.data.label === 'Send Report Email')
  assert.equal(email.data.connectionId, '', 'unbound — the builder guides the connection pick')
  assert.match(email.data.toolName, /email/i)
  const args = JSON.parse(email.data.args)
  assert.equal(args.subject, '{{step.id-Prep.output.subject}}', 'args carried over with translated references')
  assert.ok(result.warnings.some((w) => /Send Report Email/.test(w) && /connection/i.test(w)))
})

test('utility nodes map to native data ops; credential-less leftovers become passthrough code stubs', () => {
  const workflow = {
    name: 'Utilities',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Dedupe', 'n8n-nodes-base.removeDuplicates', {}),
      n8nNode('Cap', 'n8n-nodes-base.limit', { maxItems: 5 }),
      n8nNode('To File', 'n8n-nodes-base.convertToFile', { operation: 'toText' }),
    ],
    connections: chain('Start', 'Dedupe', 'Cap', 'To File'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const ops = graph.nodes.filter((n) => n.type === 'data') as any[]
  assert.deepEqual(ops.map((o) => o.data.op).sort(), ['limit', 'removeDuplicates'])
  assert.ok(ops.every((o) => typeof o.data.input === 'string' && o.data.input.startsWith('{{')), 'data ops read their upstream')
  const stub = graph.nodes.find((n) => n.type === 'code' && (n as any).data.label === 'To File') as any
  assert.ok(stub, 'convertToFile becomes a runnable passthrough stub, not a dead note')
  assert.match(stub.data.code, /return input/)
  assert.ok(result.warnings.some((w) => /To File/.test(w)))
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
