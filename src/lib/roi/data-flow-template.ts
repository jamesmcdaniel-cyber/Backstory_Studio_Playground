import type { FlowTemplateDef } from '@/lib/flows/templates/types'
import { ORG_ID_PLACEHOLDER, ROI_WAREHOUSE_KINDS, ROI_WAREHOUSE_QUERIES } from './warehouse-queries'

/**
 * "ROI data pull · Databricks": the built-in data flow behind the ROI page.
 *
 * The ROI page starts it with { account, analysisId, reason, config } (see
 * src/lib/roi/data-source.ts). It resolves the account's warehouse org id,
 * builds the three extract queries with that id in them, runs each on the
 * workspace's Databricks SQL warehouse and loads the result into the
 * Repository tagged as that account's extract — after which the analysis
 * continues on its own. Installing it runs nothing: the flow is created as a
 * draft, the installer saves the Databricks credential, sets the warehouse and
 * org ids on the first step, publishes it, and picks it on the ROI page.
 *
 * The rows never cross the canvas: a flow step's HTTP response is capped at
 * 1 MB and an extract runs to tens of MB, so the query + load is one ROI-plane
 * tool call per extract (src/lib/roi/databricks.ts) and the canvas carries
 * only the dataset ids and row counts back.
 */

export const ROI_DATA_FLOW_TEMPLATE_ID = 'roi-data-pull-databricks'

const RESOLVE_CODE = [
  '// The Databricks workspace the account data comes from: the workspace host',
  '// (no https://) and the SQL warehouse id from its connection details.',
  'const WAREHOUSE = { host: "", warehouseId: "" }',
  '// Each account\'s People.ai warehouse org id, by the name the ROI page uses.',
  'const ORG_IDS = { "Iron Mountain": "200000303" }',
  '',
  'const data = input && typeof input === "object" ? input : {}',
  'const account = String(data.account || "").trim()',
  'if (!account) throw new Error("The run names no account.")',
  'const key = account.toLowerCase()',
  'const mapped = Object.keys(ORG_IDS).find((name) => name.toLowerCase() === key)',
  'const orgId = String(data.orgId || (mapped ? ORG_IDS[mapped] : "") || "").trim()',
  'if (!/^\\d+$/.test(orgId)) throw new Error("No warehouse org id for " + account + ": add it to ORG_IDS on this step, or pass orgId when running the flow.")',
  'const host = String(data.databricksHost || WAREHOUSE.host || "").trim()',
  'const warehouseId = String(data.warehouseId || WAREHOUSE.warehouseId || "").trim()',
  'if (!host || !warehouseId) throw new Error("Set the Databricks host and SQL warehouse id in WAREHOUSE on this step, or pass databricksHost and warehouseId when running the flow.")',
  'return { account, orgId, host, warehouseId }',
].join('\n')

const BUILD_CODE = [
  '// The three extract queries. Tune the SQL here; the org id is filled in per run.',
  `const QUERIES = ${JSON.stringify(ROI_WAREHOUSE_QUERIES.map(({ kind, label, filename, sql }) => ({ kind, label, filename, sql })))}`,
  `const PLACEHOLDER = ${JSON.stringify(ORG_ID_PLACEHOLDER)}`,
  '',
  'const orgId = String((input && input.orgId) || "").trim()',
  'if (!/^\\d+$/.test(orgId)) throw new Error("The resolve step produced no numeric warehouse org id.")',
  'return QUERIES.map((q) => ({ kind: q.kind, label: q.label, filename: q.filename, statement: q.sql.split(PLACEHOLDER).join(orgId) }))',
].join('\n')

export const ROI_DATA_PULL_DATABRICKS: FlowTemplateDef = {
  id: ROI_DATA_FLOW_TEMPLATE_ID,
  name: 'ROI data pull · Databricks',
  description:
    'The ROI page\'s data source: pull an account\'s activity, opportunity-engagement and stage extracts from the People.ai warehouse on Databricks and load them into the Repository, tagged for the account, so the ROI analysis runs on fresh data.',
  category: 'Data Operations',
  icon: '📈',
  integrations: ['ROI'],
  tags: ['roi', 'databricks', 'warehouse', 'extracts'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'manual',
            inputFields: [
              { name: 'account', type: 'string', required: true, description: 'The account, as the ROI page names it.' },
              { name: 'orgId', type: 'string', description: 'The account\'s People.ai warehouse org id. Leave blank when the resolve step maps the account to it.' },
              { name: 'databricksHost', type: 'string', description: 'Overrides the Databricks workspace host set on the resolve step.' },
              { name: 'warehouseId', type: 'string', description: 'Overrides the SQL warehouse id set on the resolve step.' },
              { name: 'analysisId', type: 'string', description: 'Set by the ROI page: the analysis waiting on this pull.' },
              { name: 'reason', type: 'string', description: 'Set by the ROI page: why the analysis was run.' },
            ],
          },
        },
      },
      {
        id: 'resolve',
        type: 'code',
        data: {
          label: 'Resolve the account\'s warehouse',
          language: 'javascript',
          mode: 'all',
          input: '{{trigger.input}}',
          timeoutMs: 5000,
          code: RESOLVE_CODE,
          note: 'The one place the Databricks host, the SQL warehouse id and each account\'s warehouse org id live. A run may pass any of them instead; an account with no org id fails here, by name, before anything is queried.',
        },
      },
      {
        id: 'build',
        type: 'code',
        data: {
          label: 'Build the three extract queries',
          language: 'javascript',
          mode: 'all',
          input: '{{step.resolve.output}}',
          timeoutMs: 5000,
          code: BUILD_CODE,
          note: 'The activity, opportunity-engagement and stage queries, each over the last 30 full months, with the account\'s org id filled in. The SQL is editable here; the run\'s settings slice the data later, so the queries stay wide.',
        },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Run each query and load its extract',
          connectionId: 'native:roi',
          toolName: 'roi_databricks_pull',
          args: JSON.stringify({
            host: '{{step.resolve.output.host}}',
            warehouseId: '{{step.resolve.output.warehouseId}}',
            statement: '{{item.statement}}',
            account: '{{step.resolve.output.account}}',
            kind: '{{item.kind}}',
            filename: '{{item.filename}}',
          }),
          perItem: { over: '{{step.build.output}}', itemError: 'fail', concurrency: 3 },
          retries: 1,
          retryDelayMs: 30_000,
          note: 'Runs the statement on the SQL warehouse (submitting it, polling until it finishes, collecting every result chunk), writes the rows as a CSV dataset in the Repository tagged with the account and the extract kind, and returns the dataset id and row count. The workspace\'s saved HTTP credential for the Databricks host is attached automatically. A failed query fails the run — a report must never build on a missing extract.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Report what was loaded',
          outputs: [
            { name: 'account', value: '{{step.resolve.output.account}}', type: 'text' },
            { name: 'extracts', value: '{{step.pull.output}}', type: 'list' },
          ],
          note: 'The three loaded extracts with their dataset ids and row counts. The ROI page does not read this — it finds the extracts by their tag — but the run history shows what landed.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'resolve' },
      { id: 'e1', source: 'resolve', target: 'build' },
      { id: 'e2', source: 'build', target: 'pull' },
      { id: 'e3', source: 'pull', target: 'out' },
    ],
  },
  bindings: [],
  notes: {
    objective:
      'Bring an account\'s warehouse extracts into the workspace so the ROI page can build its report on them. It worked when the ROI page lists the account with all three extracts loaded today, and an analysis run on it builds without asking for data.',
    inputs: [
      { name: 'account', description: 'The account, as the ROI page names it. The ROI page passes it when it starts the flow.', example: 'Iron Mountain' },
      { name: 'orgId', description: 'The account\'s People.ai warehouse org id, when the resolve step does not map the account to one.', example: '200000303' },
      { name: 'databricksHost', description: 'Overrides the workspace host on the resolve step for one run.', example: 'dbc-a1b2c3d4-e5f6.cloud.databricks.com' },
      { name: 'warehouseId', description: 'Overrides the SQL warehouse id on the resolve step for one run.' },
    ],
    steps: [
      { nodeId: 'resolve', title: 'Resolve the account\'s warehouse', what: 'Finds the account\'s warehouse org id in the map on the step (or takes it from the run), with the Databricks host and SQL warehouse id.', why: 'One editable place for workspace-specific ids, and a clear failure by account name before any query runs.' },
      { nodeId: 'build', title: 'Build the three extract queries', what: `Fills the org id into the ${ROI_WAREHOUSE_KINDS.join(', ')} queries, each over the last 30 full months.`, why: 'The run\'s settings choose the windows later, so the queries stay wide and one pull serves every setting.' },
      { nodeId: 'pull', title: 'Run each query and load its extract', what: 'Runs each statement on the SQL warehouse, three at a time, and loads each result into the Repository as the account\'s extract of that kind.', why: 'Running and loading in one step keeps tens of megabytes of rows off the canvas and under the dataset limits, and a failed query fails the run rather than leaving a report to build on a missing extract.' },
      { nodeId: 'out', title: 'Report what was loaded', what: 'Lists the loaded extracts with their dataset ids and row counts.' },
    ],
    decisionRules:
      'An account resolves to an org id from the map on the resolve step, or from the orgId the run passes; without one the run fails before querying. Each query must finish with SUCCEEDED on Databricks within 20 minutes; a failed, cancelled or still-running statement fails its extract, and one failed extract fails the run.',
    failureHandling:
      'Each pull retries once after 30 seconds. A query that fails on Databricks fails the run with the warehouse\'s error; a missing or rejected credential names the host it needs. Loading replaces nothing: the newest extract per kind is what the ROI page reads, so a failed run leaves the previous extracts in place.',
    setup: [
      { label: 'Save an HTTP credential for your Databricks workspace host in Integrations — a personal access token as a bearer credential, restricted to that host', kind: 'integration', ref: 'HTTP API' },
      { label: 'Set the Databricks host and SQL warehouse id, and map each account to its warehouse org id, on the Resolve the account\'s warehouse step', kind: 'value', ref: 'resolve' },
      { label: 'Publish the flow, then choose it as the data source on the ROI analysis page', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Add every account you analyse to the org id map on the resolve step; the ROI page passes the account name.',
      'Tune the SQL on the build step — a different activity window, extra columns — the ROI prep reads the columns it knows and ignores the rest.',
      'Lower the pull step\'s concurrency to one if the SQL warehouse queues statements.',
    ],
    testPlan:
      'Run the flow by hand with an account from the map. Confirm three extracts appear for it on the ROI analysis page with today\'s date, then run an analysis on the account and check it builds without asking for data.',
  },
}
