import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Showcases stateful accumulation and a guarded write: variables carrying a
 * running count across steps, a condition that decides whether the batch is
 * healthy enough to publish, a wait that backs off before a single retry, and
 * an error path that reports instead of failing silently.
 */
export const NIGHTLY_SYNC: FlowTemplateDef = {
  id: 'nightly-sync',
  name: 'Nightly sync with a health gate',
  description:
    'Pull a paginated feed each night, transform it, and only publish downstream when enough of the batch parsed cleanly — otherwise back off, retry once, and report.',
  category: 'Data Operations',
  icon: '🌙',
  integrations: [],
  tags: ['nightly', 'variables', 'retry'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '02:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'feed-url',
        type: 'variable',
        data: {
          op: 'initialize',
          name: 'feedUrl',
          varType: 'string',
          value: 'https://your-source.example.com/api/records',
          label: 'Set the source address',
          note: 'Point this at the feed you are syncing. Both the first pull and the retry below read it, so there is one place to change.',
        },
      },
      {
        id: 'failures',
        type: 'variable',
        data: {
          op: 'initialize',
          name: 'failedRecords',
          varType: 'integer',
          value: '0',
          label: 'Start the failure count at zero',
          note: 'A counter that survives across steps. Initializing it here means later steps can add to it without worrying whether it exists.',
        },
      },
      {
        id: 'pull',
        type: 'http',
        data: {
          label: 'Pull the nightly feed',
          method: 'GET',
          url: '{{var.feedUrl}}',
          sendQuery: true,
          query: '{"per_page":"250"}',
          sendBody: false,
          bodyMode: 'none',
          failOnHttpError: true,
          retries: 2,
          timeoutMs: 45000,
          onError: 'route',
          pagination: { mode: 'nextUrl', nextUrlPath: 'links.next', itemsPath: 'data', maxPages: 40, intervalMs: 250 },
          note: 'Follows the feed\'s own next-page links, a quarter-second apart, up to 40 pages. On failure it routes down the error path rather than killing the run outright.',
        },
      },
      {
        id: 'shape',
        type: 'code',
        data: {
          label: 'Normalize the records',
          language: 'javascript',
          mode: 'all',
          input: '{{step.pull.output.body}}',
          timeoutMs: 20000,
          code: [
            'const records = Array.isArray(input) ? input : []',
            'const clean = []',
            'let failed = 0',
            'for (const record of records) {',
            '  if (!record || !record.id || !record.updated_at) { failed++; continue }',
            '  clean.push({ id: String(record.id), updatedAt: record.updated_at, name: record.name || "", status: record.status || "unknown" })',
            '}',
            'return { clean, failed, total: records.length }',
          ].join('\n'),
          note: 'Anything without an id or a timestamp is unusable, so it is counted rather than passed on. The count is what the health gate below reads.',
        },
      },
      {
        id: 'record-failures',
        type: 'variable',
        data: {
          op: 'set',
          name: 'failedRecords',
          value: '{{step.shape.output.failed}}',
          label: 'Record how many failed',
          note: 'Lifts the count out of the code step into a flow variable, so the condition and the report can both read it without re-running anything.',
        },
      },
      {
        id: 'healthy',
        type: 'condition',
        data: {
          label: 'Is the batch healthy enough?',
          match: 'all',
          clauses: [
            { left: '{{step.shape.output.total}}', op: 'gt', right: '0' },
            { left: '{{var.failedRecords}}', op: 'lt', right: '25' },
          ],
          note: 'Both must hold: the feed returned something, and fewer than 25 records were unusable. An empty feed is a failure, not a clean run.',
        },
      },
      {
        id: 'publish',
        type: 'data',
        data: {
          op: 'compose',
          label: 'Hand off the clean batch',
          input: '{{step.shape.output.clean}}',
          note: 'The handoff point. Replace this with the write that actually loads the records — it is a passthrough so you can see the batch before wiring the write.',
        },
      },
      {
        id: 'back-off',
        type: 'wait',
        data: {
          mode: 'duration',
          amount: '10',
          unit: 'minutes',
          label: 'Back off ten minutes',
          note: 'An unhealthy batch is usually a source mid-write. Waiting costs nothing and clears most of them without anyone being paged.',
        },
      },
      {
        id: 'retry',
        type: 'http',
        data: {
          label: 'Try the feed once more',
          method: 'GET',
          url: '{{var.feedUrl}}',
          sendQuery: true,
          query: '{"per_page":"250"}',
          sendBody: false,
          bodyMode: 'none',
          failOnHttpError: false,
          retries: 1,
          timeoutMs: 45000,
          pagination: { mode: 'nextUrl', nextUrlPath: 'links.next', itemsPath: 'data', maxPages: 40, intervalMs: 250 },
          note: 'One retry, and it does not fail the run on a bad response — by this point the goal is to report accurately, not to force a success.',
        },
      },
      {
        id: 'report',
        type: 'ai',
        data: {
          aiOp: 'ask',
          label: 'Write the failure report',
          input:
            'Records seen: {{step.shape.output.total}}. Unusable: {{var.failedRecords}}. Second attempt status: {{step.retry.output.status}}.',
          instructions:
            'Write three or four sentences for an on-call engineer: what the sync saw, why it did not publish, and whether the retry looked better. Use only the numbers given — do not estimate anything.',
          note: 'Prose over numbers the steps already computed. The model has nothing to invent here, which is the point.',
        },
      },
      {
        id: 'merge',
        type: 'join',
        data: {
          label: 'Whichever way it went',
          mode: 'passthrough',
          note: 'Both the healthy path and the failure path land here, so the flow has one ending regardless of which ran.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the outcome',
          outputs: [
            { name: 'published', value: '{{step.publish.output}}', type: 'list' },
            { name: 'failedCount', value: '{{var.failedRecords}}', type: 'any' },
            { name: 'report', value: '{{step.report.output}}', type: 'text' },
          ],
          note: 'Only one of published or report is filled on any given run — which one tells you at a glance how the night went.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'feed-url' },
      { id: 'e1', source: 'feed-url', target: 'failures' },
      { id: 'e2', source: 'failures', target: 'pull' },
      { id: 'e3', source: 'pull', target: 'shape' },
      { id: 'e4', source: 'pull', target: 'report', branch: 'error' },
      { id: 'e5', source: 'shape', target: 'record-failures' },
      { id: 'e6', source: 'record-failures', target: 'healthy' },
      { id: 'e7', source: 'healthy', target: 'publish', branch: 'true' },
      { id: 'e8', source: 'healthy', target: 'back-off', branch: 'false' },
      { id: 'e9', source: 'back-off', target: 'retry' },
      { id: 'e10', source: 'retry', target: 'report' },
      { id: 'e11', source: 'publish', target: 'merge' },
      { id: 'e12', source: 'report', target: 'merge' },
      { id: 'e13', source: 'merge', target: 'out' },
    ],
  },
  bindings: [],
  notes: {
    objective:
      'Sync a feed every night, and refuse to publish a batch that arrived broken. It worked if clean nights publish silently and bad nights produce a report naming real counts rather than a half-loaded dataset.',
    inputs: [],
    steps: [
      { nodeId: 'feed-url', title: 'Set the source address', what: 'Holds the feed address, read by both the first pull and the retry.' },
      {
        nodeId: 'failures',
        title: 'Start the failure count at zero',
        what: 'Declares a counter that later steps read and write.',
        why: 'Initializing up front means nothing downstream has to handle the variable not existing yet.',
      },
      {
        nodeId: 'pull',
        title: 'Pull the nightly feed',
        what: 'Follows the feed\'s next-page links up to 40 pages, pausing briefly between them.',
        why: 'Routing on error rather than stopping is what lets a dead source still produce a report.',
      },
      { nodeId: 'shape', title: 'Normalize the records', what: 'Keeps records with an id and a timestamp, counts the rest as unusable.' },
      { nodeId: 'record-failures', title: 'Record how many failed', what: 'Stores the unusable count where the gate and the report can both read it.' },
      { nodeId: 'healthy', title: 'Is the batch healthy enough?', what: 'Publishes only when the feed returned records and fewer than 25 were unusable.' },
      { nodeId: 'publish', title: 'Hand off the clean batch', what: 'Passes the clean records on. Replace it with your real write.' },
      {
        nodeId: 'back-off',
        title: 'Back off ten minutes',
        what: 'Pauses before retrying.',
        why: 'Most bad batches are a source mid-write; ten minutes clears them without paging anyone.',
      },
      { nodeId: 'retry', title: 'Try the feed once more', what: 'Pulls again, without failing the run on a bad response.' },
      { nodeId: 'report', title: 'Write the failure report', what: 'Explains what the sync saw and why it did not publish.' },
      { nodeId: 'merge', title: 'Whichever way it went', what: 'Brings the healthy and failure paths back to one ending.' },
      { nodeId: 'out', title: 'Return the outcome', what: 'Returns the published batch, the failure count, and the report.' },
    ],
    decisionRules:
      'The batch publishes only when the feed returned at least one record AND fewer than 25 were unusable. A record is unusable when it has no id or no timestamp. An empty feed counts as a failure, not a clean run — that distinction is what stops a silently-dead source from looking healthy.',
    failureHandling:
      'The first pull retries twice, then routes to the report rather than failing the run. An unhealthy batch waits ten minutes and pulls once more, this time tolerating a bad response so the report still gets written. Nothing partial is ever handed downstream — the gate is all-or-nothing by design.',
    setup: [
      { label: 'Set your feed address on the Set the source address step', kind: 'value', ref: 'feed-url' },
      { label: 'Replace Hand off the clean batch with the write that loads your records', kind: 'value', ref: 'publish' },
      { label: 'Check the 02:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Move the 25-failure threshold to match how noisy your source normally is.',
      'Add the fields your records actually carry to Normalize the records.',
      'Add a delivery step after Write the failure report so on-call sees it without opening the run.',
      'Change the ten-minute back-off to match how long your source takes to settle.',
    ],
    testPlan:
      'Point the feed address at a URL that returns nothing and run it by hand — the gate should refuse to publish and the report should say the feed was empty. Then point it at real data and confirm the published output is filled and the report is not.',
  },
}
