import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Showcases the file path: an uploaded file as a trigger input, deterministic
 * CSV parsing, a per-item HTTP call that tolerates individual failures, a code
 * node stitching the two lists together, and a CSV table back out.
 */
export const CSV_ENRICHMENT: FlowTemplateDef = {
  id: 'csv-enrichment',
  name: 'CSV enrichment pipeline',
  description:
    'Upload a CSV, look every row up against an API, merge what comes back into the original rows, and get an enriched CSV out — with rows that failed lookup marked rather than dropped.',
  category: 'Data Operations',
  icon: '📊',
  integrations: ['HTTP API'],
  tags: ['files', 'per-item', 'enrichment'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'manual',
            inputFields: [
              { name: 'file', type: 'object', required: true, format: 'file', description: 'A CSV with a header row. One column must hold the lookup key.' },
            ],
          },
        },
      },
      {
        id: 'api-base',
        type: 'variable',
        data: {
          op: 'initialize',
          name: 'lookupApiBase',
          varType: 'string',
          value: 'https://your-enrichment-api.example.com/v1',
          label: 'Set the lookup API address',
          note: 'The one place the enrichment API address appears. Change it here and every lookup below follows.',
        },
      },
      {
        id: 'rows',
        type: 'data',
        data: {
          op: 'parseCsv',
          label: 'Read the CSV',
          input: '{{trigger.input.file.content}}',
          note: 'Turns the uploaded text into a list of records keyed by the header row. Deterministic — no model involved, so a 5,000-row file costs nothing here.',
        },
      },
      {
        id: 'lookup',
        type: 'tool',
        data: {
          label: 'Look each row up',
          connectionId: '',
          toolName: 'request',
          args: '{"method":"GET","url":"{{var.lookupApiBase}}/enrich?key={{item.domain}}"}',
          retries: 1,
          timeoutMs: 15000,
          perItem: { over: '{{step.rows.output}}', itemError: 'collect', concurrency: 5 },
          note: 'One request per row, five at a time, each retried once. Failures are collected in place so a single unresolvable row does not lose the whole file.',
        },
      },
      {
        id: 'merge-rows',
        type: 'code',
        data: {
          label: 'Merge lookups back into the rows',
          language: 'javascript',
          mode: 'all',
          input: '{{steps}}',
          timeoutMs: 15000,
          code: [
            'const rows = input["Read the CSV"] || []',
            'const hits = input["Look each row up"] || []',
            'return rows.map((row, i) => {',
            '  const hit = hits[i]',
            '  if (!hit || hit.error || !hit.body) return { ...row, enriched: false, enrichmentError: hit && hit.error ? String(hit.error) : "no match" }',
            '  let body = hit.body',
            '  if (typeof body === "string") { try { body = JSON.parse(body) } catch { return { ...row, enriched: false, enrichmentError: "non-JSON response" } } }',
            '  if (!body || typeof body !== "object" || Array.isArray(body)) return { ...row, enriched: false, enrichmentError: "invalid response" }',
            '  return { ...row, ...body, enriched: true, enrichmentError: "" }',
            '})',
          ].join('\n'),
          note: 'Positional merge: per-item results come back in input order, so row i pairs with lookup i. Rows that failed are kept and marked rather than silently dropped.',
        },
      },
      {
        id: 'table',
        type: 'data',
        data: {
          op: 'csvTable',
          label: 'Build the enriched CSV',
          input: '{{step.merge-rows.output}}',
          note: 'Back to CSV text, columns taken from the merged records — so the enrichment fields appear alongside the originals.',
        },
      },
      {
        id: 'stats',
        type: 'code',
        data: {
          label: 'Count what worked',
          language: 'javascript',
          mode: 'all',
          input: '{{step.merge-rows.output}}',
          timeoutMs: 5000,
          code: [
            'const rows = Array.isArray(input) ? input : []',
            'const enriched = rows.filter((row) => row.enriched).length',
            'return { total: rows.length, enriched, failed: rows.length - enriched }',
          ].join('\n'),
          note: 'An honest count of what actually resolved. Without it, a file where every lookup failed still looks like a successful run.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the CSV and the counts',
          outputs: [
            { name: 'csv', value: '{{step.table.output}}', type: 'text' },
            { name: 'stats', value: '{{step.stats.output}}', type: 'any' },
          ],
          note: 'The counts sit next to the file on purpose — you should not have to open the CSV to see how much of it enriched.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'api-base' },
      { id: 'e1', source: 'api-base', target: 'rows' },
      { id: 'e2', source: 'rows', target: 'lookup' },
      { id: 'e3', source: 'lookup', target: 'merge-rows' },
      { id: 'e4', source: 'merge-rows', target: 'table' },
      { id: 'e5', source: 'merge-rows', target: 'stats' },
      { id: 'e6', source: 'table', target: 'out' },
      { id: 'e7', source: 'stats', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'lookup',
      kind: 'connection',
      label: 'Use the workspace HTTP API connection',
      match: { provider: 'HTTP API', toolName: 'request' },
    },
  ],
  notes: {
    objective:
      'Take a CSV in, add columns from an API lookup, and get a CSV out where every original row is still present — enriched or explicitly marked as failed. It worked if the row count going in matches the row count coming out.',
    inputs: [
      { name: 'file', description: 'A CSV with a header row, uploaded on the run form.', example: 'accounts.csv with columns name, domain, owner' },
    ],
    steps: [
      { nodeId: 'api-base', title: 'Set the lookup API address', what: 'Holds the enrichment API address in one place.' },
      { nodeId: 'rows', title: 'Read the CSV', what: 'Parses the uploaded text into a list of records using the header row.' },
      {
        nodeId: 'lookup',
        title: 'Look each row up',
        what: 'Calls the enrichment API once per row, five at a time, retrying each once.',
        why: 'Collecting item failures rather than aborting is what lets a 5,000-row file with a handful of bad values still finish.',
      },
      {
        nodeId: 'merge-rows',
        title: 'Merge lookups back into the rows',
        what: 'Pairs each row with its lookup by position and marks the ones that did not resolve.',
        why: 'Keeping failed rows with a reason beats dropping them — a shorter file out than in is the kind of bug nobody notices.',
      },
      { nodeId: 'table', title: 'Build the enriched CSV', what: 'Turns the merged records back into CSV text.' },
      { nodeId: 'stats', title: 'Count what worked', what: 'Counts total, enriched, and failed rows.' },
      { nodeId: 'out', title: 'Return the CSV and the counts', what: 'Returns the enriched file alongside the counts.' },
    ],
    decisionRules:
      'A row counts as enriched only when the lookup returned a body. Anything else — an error, a timeout, an empty response — is kept with enriched set to false and a reason in the error column.',
    failureHandling:
      'Each lookup retries once, then its failure is collected in place rather than failing the step. The merge is positional, so it depends on per-item results coming back in input order. Row count in always equals row count out.',
    setup: [
      { label: 'Connect a saved HTTP credential for the enrichment API host when it requires authentication', kind: 'integration', ref: 'HTTP API' },
      { label: 'Set your enrichment API address on the Set the lookup API address step', kind: 'value', ref: 'api-base' },
      { label: 'Point the lookup at your key column — it reads a column named domain out of the box', kind: 'value', ref: 'lookup' },
    ],
    customize: [
      'Save a host-bound HTTP credential in Integrations when your API needs authentication; the request tool attaches it automatically.',
      'Raise the five-at-a-time concurrency, within whatever your API rate-limits to.',
      'Swap the CSV output for an HTML table if the result is going into an email.',
      'Add a filter before the lookup to skip rows with an empty key.',
    ],
    testPlan:
      'Run it with a five-row CSV where one row has a deliberately bad key. Confirm five rows come back, four enriched and one marked failed, and that the counts agree.',
  },
}
