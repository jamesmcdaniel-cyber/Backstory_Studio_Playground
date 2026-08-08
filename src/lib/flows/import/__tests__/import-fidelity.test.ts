import { test } from 'node:test'
import assert from 'node:assert/strict'
import { n8nToFlow } from '@/lib/flows/import/from-n8n'

/**
 * Import-fidelity suite: real-shape n8n exports (serialized formats verified
 * against n8n source — resource locators, resource mappers, FilterValue,
 * onError, disabled, pinData) must survive import without silent loss.
 */

const n8nNode = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({ id: `id-${name}`, name, type, typeVersion: 2, position: [0, 0] as [number, number], parameters, ...extra })

const chain = (...names: string[]) => {
  const connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }> = {}
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }
  }
  return connections
}

const manual = () => n8nNode('Manual', 'n8n-nodes-base.manualTrigger')

const toolNode = (result: ReturnType<typeof n8nToFlow>, label: string) => {
  const node = result.graph.nodes.find((n) => n.type === 'tool' && (n.data as { label?: string }).label === label)
  assert.ok(node, `expected a tool node labelled ${label}`)
  return node.data as { toolName: string; args: string; note?: string }
}

// ── Google Sheets write payloads ─────────────────────────────────────────────

test('sheets append: v4 resource-mapper columns become row values and the URL locator yields the bare spreadsheet id', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode(
        'Append',
        'n8n-nodes-base.googleSheets',
        {
          resource: 'sheet',
          operation: 'append',
          documentId: { __rl: true, mode: 'url', value: 'https://docs.google.com/spreadsheets/d/1AbCdEfG/edit#gid=0' },
          sheetName: { __rl: true, mode: 'name', value: 'Leads' },
          columns: {
            mappingMode: 'defineBelow',
            value: { Name: '={{ $json.name }}', Email: 'static@acme.com' },
            matchingColumns: [],
            schema: [],
          },
        },
        { credentials: { googleSheetsOAuth2Api: { id: 'c1', name: 'Sheets' } } },
      ),
    ],
    connections: chain('Manual', 'Append'),
  })
  const data = toolNode(result, 'Append')
  const args = JSON.parse(data.args)
  assert.equal(args.spreadsheetId, '1AbCdEfG')
  assert.equal(args.range, 'Leads')
  assert.deepEqual(args.values, ['{{trigger.input.name}}', 'static@acme.com'])
  assert.match(data.note ?? '', /Name, Email/)
})

test('sheets append: autoMapInputData cannot be translated and warns that the row values need attention', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Append', 'n8n-nodes-base.googleSheets', {
        operation: 'append',
        documentId: { __rl: true, mode: 'id', value: '1AbCdEfG' },
        sheetName: { __rl: true, mode: 'name', value: 'Leads' },
        columns: { mappingMode: 'autoMapInputData', value: null },
      }),
    ],
    connections: chain('Manual', 'Append'),
  })
  const data = toolNode(result, 'Append')
  assert.deepEqual(JSON.parse(data.args).values, [])
  assert.ok(
    result.warnings.some((w) => /row values/i.test(w)),
    `expected a row-values warning, got: ${JSON.stringify(result.warnings)}`,
  )
})

test('sheets update: mapped columns become a row-array payload', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Update', 'n8n-nodes-base.googleSheets', {
        operation: 'update',
        documentId: { __rl: true, mode: 'id', value: '1AbCdEfG' },
        sheetName: { __rl: true, mode: 'name', value: 'Leads' },
        columns: { mappingMode: 'defineBelow', value: { Status: 'won' } },
      }),
    ],
    connections: chain('Manual', 'Update'),
  })
  const args = JSON.parse(toolNode(result, 'Update').args)
  assert.deepEqual(args.values, [['won']])
})

test('sheets append: legacy fieldsUi shape also carries values', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Append', 'n8n-nodes-base.googleSheets', {
        operation: 'append',
        sheetId: '1AbCdEfG',
        range: 'A:B',
        fieldsUi: { fieldValues: [{ column: 'Name', fieldValue: '={{ $json.name }}' }] },
      }),
    ],
    connections: chain('Manual', 'Append'),
  })
  const args = JSON.parse(toolNode(result, 'Append').args)
  assert.deepEqual(args.values, ['{{trigger.input.name}}'])
})

// ── Salesforce write payloads ────────────────────────────────────────────────

test('salesforce create: top-level fields and additionalFields survive as the fields payload', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode(
        'Create lead',
        'n8n-nodes-base.salesforce',
        {
          resource: 'lead',
          operation: 'create',
          company: '={{ $json.company }}',
          lastname: 'Smith',
          additionalFields: { email: '={{ $json.email }}', phone: '555-1234' },
        },
        { credentials: { salesforceOAuth2Api: { id: 'c2', name: 'SFDC' } } },
      ),
    ],
    connections: chain('Manual', 'Create lead'),
  })
  const args = JSON.parse(toolNode(result, 'Create lead').args)
  assert.equal(args.sobject, 'Lead')
  assert.deepEqual(args.fields, {
    company: '{{trigger.input.company}}',
    lastname: 'Smith',
    email: '{{trigger.input.email}}',
    phone: '555-1234',
  })
})

// ── Disabled nodes and error branches ────────────────────────────────────────

test('a disabled n8n node imports with the disabled flag set', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Old step', 'n8n-nodes-base.httpRequest', { method: 'POST', url: 'https://api.example.com/x' }, { disabled: true }),
    ],
    connections: chain('Manual', 'Old step'),
  })
  const node = result.graph.nodes.find((n) => n.type === 'http')
  assert.ok(node)
  assert.equal(node.disabled, true)
})

test('onError continueErrorOutput imports as onError route with a labelled error edge', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Fetch', 'n8n-nodes-base.httpRequest', { method: 'GET', url: 'https://api.example.com/x' }, { onError: 'continueErrorOutput' }),
      n8nNode('Process', 'n8n-nodes-base.noOp'),
      n8nNode('Alert', 'n8n-nodes-base.noOp'),
    ],
    connections: {
      Manual: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] },
      Fetch: {
        main: [
          [{ node: 'Process', type: 'main', index: 0 }],
          [{ node: 'Alert', type: 'main', index: 0 }],
        ],
      },
    },
  })
  const http = result.graph.nodes.find((n) => n.type === 'http')
  assert.ok(http)
  assert.equal((http.data as { onError?: string }).onError, 'route')
  const byTarget = new Map(result.graph.edges.filter((e) => e.source === http.id).map((e) => [e.target, e]))
  const processId = result.graph.nodes.find((n) => (n.data as { label?: string }).label === 'Process')!.id
  const alertId = result.graph.nodes.find((n) => (n.data as { label?: string }).label === 'Alert')!.id
  assert.equal(byTarget.get(processId)?.branch, undefined)
  assert.equal(byTarget.get(alertId)?.branch, 'error')
})

test('onError continueRegularOutput imports as onError continue', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Fetch', 'n8n-nodes-base.httpRequest', { method: 'GET', url: 'https://api.example.com/x' }, { onError: 'continueRegularOutput' }),
    ],
    connections: chain('Manual', 'Fetch'),
  })
  const http = result.graph.nodes.find((n) => n.type === 'http')
  assert.equal((http!.data as { onError?: string }).onError, 'continue')
})

test('legacy continueOnFail imports as onError continue', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Fetch', 'n8n-nodes-base.httpRequest', { method: 'GET', url: 'https://api.example.com/x' }, { continueOnFail: true }),
    ],
    connections: chain('Manual', 'Fetch'),
  })
  const http = result.graph.nodes.find((n) => n.type === 'http')
  assert.equal((http!.data as { onError?: string }).onError, 'continue')
})

// ── Node settings, merge modes, Set fidelity, pinData ────────────────────────

test('retry and always-output settings carry onto the imported step', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode(
        'Flaky',
        'n8n-nodes-base.httpRequest',
        { method: 'GET', url: 'https://api.example.com/x' },
        { retryOnFail: true, maxTries: 4, waitBetweenTries: 2000, alwaysOutputData: true },
      ),
    ],
    connections: chain('Manual', 'Flaky'),
  })
  const data = result.graph.nodes.find((n) => n.type === 'http')!.data as {
    retries?: number
    retryDelayMs?: number
    alwaysOutputData?: boolean
  }
  assert.equal(data.retries, 3)
  assert.equal(data.retryDelayMs, 2000)
  assert.equal(data.alwaysOutputData, true)
})

test('merge combineByFields imports as join combineByKey with the match key', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('A', 'n8n-nodes-base.noOp'),
      n8nNode('B', 'n8n-nodes-base.noOp'),
      n8nNode('Combine', 'n8n-nodes-base.merge', {
        mode: 'combine',
        combineBy: 'combineByFields',
        fieldsToMatchString: 'email',
        joinMode: 'keepMatches',
      }),
    ],
    connections: {
      Manual: { main: [[{ node: 'A', type: 'main', index: 0 }, { node: 'B', type: 'main', index: 0 }]] },
      A: { main: [[{ node: 'Combine', type: 'main', index: 0 }]] },
      B: { main: [[{ node: 'Combine', type: 'main', index: 1 }]] },
    },
  })
  const join = result.graph.nodes.find((n) => n.type === 'join')!.data as { mode?: string; key?: string }
  assert.equal(join.mode, 'combineByKey')
  assert.equal(join.key, 'email')
})

test('merge combineByPosition imports as join combineByPosition', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Combine', 'n8n-nodes-base.merge', { mode: 'combine', combineBy: 'combineByPosition' }),
    ],
    connections: chain('Manual', 'Combine'),
  })
  const join = result.graph.nodes.find((n) => n.type === 'join')!.data as { mode?: string }
  assert.equal(join.mode, 'combineByPosition')
})

test('merge chooseBranch cannot be expressed and warns', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [manual(), n8nNode('Combine', 'n8n-nodes-base.merge', { mode: 'chooseBranch' })],
    connections: chain('Manual', 'Combine'),
  })
  const join = result.graph.nodes.find((n) => n.type === 'join')!.data as { mode?: string }
  assert.equal(join.mode, 'append')
  assert.ok(result.warnings.some((w) => /chooseBranch/i.test(w)))
})

test('set: per-field type and include-other-fields survive', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Shape', 'n8n-nodes-base.set', {
        mode: 'manual',
        assignments: {
          assignments: [
            { id: 'a1', name: 'status', value: 'open', type: 'string' },
            { id: 'a2', name: 'count', value: '={{ $json.count }}', type: 'number' },
          ],
        },
        includeOtherFields: true,
        include: 'all',
      }),
    ],
    connections: chain('Manual', 'Shape'),
  })
  const data = result.graph.nodes.find((n) => n.type === 'transform')!.data as {
    fields: Array<{ name: string; value: string; type?: string }>
    includeOtherFields?: boolean
  }
  assert.equal(data.includeOtherFields, true)
  assert.deepEqual(data.fields, [
    { name: 'status', value: 'open', type: 'string' },
    { name: 'count', value: '{{trigger.input.count}}', type: 'number' },
  ])
})

test('set: selective include modes warn that only all-or-nothing transfers', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Shape', 'n8n-nodes-base.set', {
        mode: 'manual',
        assignments: { assignments: [{ id: 'a1', name: 'x', value: '1', type: 'string' }] },
        includeOtherFields: true,
        include: 'selected',
        includeFields: 'a,b',
      }),
    ],
    connections: chain('Manual', 'Shape'),
  })
  const data = result.graph.nodes.find((n) => n.type === 'transform')!.data as { includeOtherFields?: boolean }
  assert.equal(data.includeOtherFields, true)
  assert.ok(result.warnings.some((w) => /include/i.test(w) && /Shape/.test(w)))
})

test('if: case-insensitive comparison carries onto the clauses', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Check', 'n8n-nodes-base.if', {
        conditions: {
          options: { caseSensitive: false, typeValidation: 'loose', version: 2 },
          conditions: [
            {
              id: 'c1',
              leftValue: '={{ $json.stage }}',
              rightValue: 'Closed',
              operator: { type: 'string', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
      }),
      n8nNode('Yes', 'n8n-nodes-base.noOp'),
    ],
    connections: {
      Manual: { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
      Check: { main: [[{ node: 'Yes', type: 'main', index: 0 }]] },
    },
  })
  const data = result.graph.nodes.find((n) => n.type === 'condition')!.data as {
    clauses: Array<{ ignoreCase?: boolean }>
  }
  assert.equal(data.clauses[0].ignoreCase, true)
})

test('pinned data transfers onto the graph keyed by our node ids', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [manual(), n8nNode('Fetch', 'n8n-nodes-base.httpRequest', { method: 'GET', url: 'https://api.example.com/x' })],
    connections: chain('Manual', 'Fetch'),
    pinData: { Fetch: [{ json: { mocked: true } }] },
  })
  const httpId = result.graph.nodes.find((n) => n.type === 'http')!.id
  assert.deepEqual((result.graph as { pinData?: Record<string, unknown> }).pinData, { [httpId]: { mocked: true } })
})

// ── Expression shim and warning coverage ─────────────────────────────────────

test('$now and $today luxon-style expressions run in the imported code shim', async () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Call', 'n8n-nodes-base.httpRequest', {
        method: 'GET',
        url: 'https://api.example.com/x',
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: 'since', value: "={{ $now.minus(7, 'days').toISO() }}" },
            { name: 'today', value: '={{ $today.toISO() }}' },
          ],
        },
      }),
    ],
    connections: chain('Manual', 'Call'),
  })
  const compute = result.graph.nodes.find((n) => n.type === 'code')
  assert.ok(compute, 'expected a hoisted expression compute step')
  const { runFlowCode } = await import('@/features/flows/code-runner')
  const run = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: (compute!.data as { code: string }).code,
    input: {},
    context: { steps: {} },
  })
  const output = run.output as Record<string, string>
  assert.match(output.expr0, /^\d{4}-\d{2}-\d{2}T/, `expr0 should be an ISO date, got ${JSON.stringify(run)}`)
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000
  assert.ok(Math.abs(new Date(output.expr0).getTime() - sevenDaysAgo) < 60_000)
  assert.match(output.expr1, /T00:00:00/)
})

test('expressions using n8n-only globals warn by name', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Call', 'n8n-nodes-base.httpRequest', {
        method: 'GET',
        url: 'https://api.example.com/x',
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'k', value: '={{ $env.API_KEY }}' }] },
      }),
    ],
    connections: chain('Manual', 'Call'),
  })
  assert.ok(
    result.warnings.some((w) => w.includes('$env')),
    `expected a warning naming $env, got: ${JSON.stringify(result.warnings)}`,
  )
})

test('every untranslatable expression on a node surfaces, not just the first', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Check', 'n8n-nodes-base.if', {
        conditions: {
          options: { version: 2 },
          conditions: [
            {
              id: 'c1',
              leftValue: '={{ $json.a ?? "x" }}',
              rightValue: 'x',
              operator: { type: 'string', operation: 'equals' },
            },
            {
              id: 'c2',
              leftValue: '={{ 1 + 2 }}',
              rightValue: '3',
              operator: { type: 'string', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
      }),
      n8nNode('Yes', 'n8n-nodes-base.noOp'),
    ],
    connections: {
      Manual: { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
      Check: { main: [[{ node: 'Yes', type: 'main', index: 0 }]] },
    },
  })
  assert.ok(
    result.warnings.some((w) => w.includes('$json.a ?? ')),
    `expected the first expression to surface: ${JSON.stringify(result.warnings)}`,
  )
  assert.ok(
    result.warnings.some((w) => w.includes('1 + 2')),
    `expected the second expression to surface: ${JSON.stringify(result.warnings)}`,
  )
})

// ── Credential-name binding and delivery option fidelity ─────────────────────

test('an unmapped app node binds to its provider via the n8n credential type name', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode(
        'Create page',
        'n8n-nodes-base.notion',
        { resource: 'page', operation: 'create', title: 'Hello' },
        { credentials: { notionApi: { id: 'c9', name: 'Notion acct' } } },
      ),
    ],
    connections: chain('Manual', 'Create page'),
  })
  const tool = result.graph.nodes.find((n) => n.type === 'tool')
  assert.ok(tool)
  assert.equal((tool!.data as { connectionId: string }).connectionId, 'nango:notion')
})

test('slack thread replies survive as a thread_ts arg', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode(
        'Notify',
        'n8n-nodes-base.slack',
        {
          resource: 'message',
          operation: 'post',
          channelId: { __rl: true, mode: 'id', value: 'C0123' },
          text: 'hi',
          otherOptions: { thread_ts: { replyValues: [{ thread_ts: '={{ $json.ts }}', reply_broadcast: false }] } },
        },
        { credentials: { slackOAuth2Api: { id: 'c1', name: 'Slack' } } },
      ),
    ],
    connections: chain('Manual', 'Notify'),
  })
  const args = JSON.parse((result.graph.nodes.find((n) => n.type === 'tool')!.data as { args: string }).args)
  assert.equal(args.thread_ts, '{{trigger.input.ts}}')
})

test('gmail cc and bcc survive as args', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode(
        'Send',
        'n8n-nodes-base.gmail',
        {
          resource: 'message',
          operation: 'send',
          sendTo: 'a@b.c',
          subject: 's',
          message: 'm',
          options: { ccList: 'boss@b.c', bccList: 'audit@b.c' },
        },
        { credentials: { gmailOAuth2: { id: 'c2', name: 'Gmail' } } },
      ),
    ],
    connections: chain('Manual', 'Send'),
  })
  const args = JSON.parse((result.graph.nodes.find((n) => n.type === 'tool')!.data as { args: string }).args)
  assert.equal(args.cc, 'boss@b.c')
  assert.equal(args.bcc, 'audit@b.c')
})

// ── Structured import notes ──────────────────────────────────────────────────

test('import produces structured notes with codes and node ids; warnings stays the message list', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode(
        'Snowflake query',
        'n8n-nodes-base.snowflake',
        { operation: 'executeQuery', query: 'SELECT 1' },
        { credentials: { snowflake: { id: 'c1', name: 'Snowflake' } } },
      ),
    ],
    connections: chain('Manual', 'Snowflake query'),
  })
  const skeleton = result.notes.find((n) => n.code === 'CREDENTIAL_SKELETON')
  assert.ok(skeleton, `expected a CREDENTIAL_SKELETON note, got ${JSON.stringify(result.notes)}`)
  const httpNode = result.graph.nodes.find((n) => n.type === 'http')
  assert.equal(skeleton!.nodeId, httpNode!.id)
  assert.deepEqual(result.warnings, result.notes.map((n) => n.message))
})

test('an unmapped credentialed node yields an UNMAPPED_NODE note anchored to the step', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode(
        'Chat post',
        'n8n-nodes-base.mattermost',
        { resource: 'message', operation: 'post' },
        { credentials: { mattermostApi: { id: 'c1', name: 'MM' } } },
      ),
    ],
    connections: chain('Manual', 'Chat post'),
  })
  const note = result.notes.find((n) => n.code === 'UNMAPPED_NODE')
  assert.ok(note, JSON.stringify(result.notes))
  const tool = result.graph.nodes.find((n) => n.type === 'tool')
  assert.equal(note!.nodeId, tool!.id)
})

test('a test-mode gate is flagged as likely dead weight', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Params', 'n8n-nodes-base.set', {
        assignments: { assignments: [{ name: 'test_mode', value: 'true', type: 'boolean' }] },
      }),
      n8nNode('Gate', 'n8n-nodes-base.if', {
        conditions: {
          options: { version: 2 },
          conditions: [
            {
              id: 'c1',
              leftValue: '={{ $json.test_mode }}',
              rightValue: 'true',
              operator: { type: 'boolean', operation: 'true' },
            },
          ],
          combinator: 'and',
        },
      }),
      n8nNode('Safe path', 'n8n-nodes-base.noOp'),
    ],
    connections: {
      Manual: { main: [[{ node: 'Params', type: 'main', index: 0 }]] },
      Params: { main: [[{ node: 'Gate', type: 'main', index: 0 }]] },
      Gate: { main: [[{ node: 'Safe path', type: 'main', index: 0 }]] },
    },
  })
  const note = result.notes.find((n) => n.code === 'TEST_MODE_BRANCH')
  assert.ok(note, JSON.stringify(result.notes))
  const gate = result.graph.nodes.find((n) => n.type === 'condition')
  assert.equal(note!.nodeId, gate!.id)
})

test('a positional merge carries an info note about drift', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [manual(), n8nNode('Combine', 'n8n-nodes-base.merge', { mode: 'combine', combineBy: 'combineByPosition' })],
    connections: chain('Manual', 'Combine'),
  })
  const note = result.notes.find((n) => n.code === 'MERGE_BY_POSITION')
  assert.ok(note, JSON.stringify(result.notes))
  assert.equal(note!.severity, 'info')
})

test('salesforce update: updateFields and the record id survive', () => {
  const result = n8nToFlow({
    name: 'wf',
    nodes: [
      manual(),
      n8nNode('Update lead', 'n8n-nodes-base.salesforce', {
        resource: 'lead',
        operation: 'update',
        leadId: 'abc123',
        updateFields: { status: 'Working' },
      }),
    ],
    connections: chain('Manual', 'Update lead'),
  })
  const args = JSON.parse(toolNode(result, 'Update lead').args)
  assert.equal(args.id, 'abc123')
  assert.deepEqual(args.fields, { status: 'Working' })
})
