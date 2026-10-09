import type { FlowTemplateDef } from '@/lib/flows/templates/types'
import { ORG_ID_PLACEHOLDER, ROI_WAREHOUSE_KINDS, ROI_WAREHOUSE_QUERIES } from './warehouse-queries'
import { ROI_EXTRACT_CONTRACT, ROI_SOURCE_KINDS, ROI_SOURCE_LABEL } from './source-kinds'

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

/**
 * "ROI data pull · from files": the same landing, from files that already
 * exist somewhere reachable by link — a warehouse export in a bucket (signed
 * link), a file an n8n workflow or a data pipeline published, a warehouse
 * REST endpoint that answers CSV. The run names the account and one link per
 * extract; the platform fetches each file itself (so size is not a canvas
 * concern) and loads it as that extract, tagged for the account. It is the
 * starting point for any custom data flow: swap the trigger inputs for
 * whatever step produces the links, keep the load step.
 */
export const ROI_DATA_FILES_TEMPLATE_ID = 'roi-data-pull-files'

const COLLECT_CODE = [
  '// One link per extract the run gave. A blank one is simply not loaded;',
  '// the newest extract of each kind already in the Repository stays.',
  `const KINDS = ${JSON.stringify([...ROI_SOURCE_KINDS])}`,
  'const data = input && typeof input === "object" ? input : {}',
  'const account = String(data.account || "").trim()',
  'if (!account) throw new Error("The run names no account.")',
  'const items = KINDS.map((kind) => ({ kind, url: String(data[kind + "Url"] || "").trim() })).filter((item) => item.url)',
  'if (!items.length) throw new Error("The run gave no file links: pass at least one extract link for " + account + ".")',
  'return { account, items }',
].join('\n')

export const ROI_DATA_PULL_FILES: FlowTemplateDef = {
  id: ROI_DATA_FILES_TEMPLATE_ID,
  name: 'ROI data pull · from files',
  description:
    'The ROI page\'s data source when the extracts are already files somewhere: give the account and a link per extract (a signed bucket link, a published export, an endpoint that answers CSV) and each is fetched and loaded into the Repository, tagged for the account, so the ROI analysis builds on it.',
  category: 'Data Operations',
  icon: '📥',
  integrations: ['ROI'],
  tags: ['roi', 'extracts', 'csv', 'warehouse'],
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
              ...ROI_SOURCE_KINDS.map((kind) => ({ name: `${kind}Url`, type: 'string' as const, description: `Link to the ${ROI_SOURCE_LABEL[kind].toLowerCase()} CSV. ${ROI_EXTRACT_CONTRACT[kind].grain}` })),
              { name: 'analysisId', type: 'string', description: 'Set by the ROI page: the analysis waiting on this pull.' },
              { name: 'reason', type: 'string', description: 'Set by the ROI page: why the analysis was run.' },
            ],
          },
        },
      },
      {
        id: 'collect',
        type: 'code',
        data: {
          label: 'Collect the file links',
          language: 'javascript',
          mode: 'all',
          input: '{{trigger.input}}',
          timeoutMs: 5000,
          code: COLLECT_CODE,
          note: 'Pairs each link the run gave with its extract kind and drops the blanks. Replace this step with whatever produces the links in your pipeline (a bucket listing, an export job\'s result, an HTTP call) as long as it returns { account, items: [{ kind, url }] }.',
        },
      },
      {
        id: 'load',
        type: 'tool',
        data: {
          label: 'Fetch each file and load it as the extract',
          connectionId: 'native:roi',
          toolName: 'roi_load_extract',
          args: JSON.stringify({
            account: '{{step.collect.output.account}}',
            kind: '{{item.kind}}',
            url: '{{item.url}}',
          }),
          perItem: { over: '{{step.collect.output.items}}', itemError: 'fail', concurrency: 3 },
          retries: 1,
          retryDelayMs: 30_000,
          note: 'The platform fetches the file (up to the dataset limit; the workspace\'s saved HTTP credential for the link\'s host is applied when there is one) and writes it to the Repository as the account\'s extract of that kind. The result names any required column the file lacks. A failed fetch fails the run — a report must never build on a missing extract.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Report what was loaded',
          outputs: [
            { name: 'account', value: '{{step.collect.output.account}}', type: 'text' },
            { name: 'extracts', value: '{{step.load.output}}', type: 'list' },
          ],
          note: 'The loaded extracts with their dataset ids, row counts, headers and any missing required columns. The ROI page finds the extracts by their tag; the run history shows what landed.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'collect' },
      { id: 'e1', source: 'collect', target: 'load' },
      { id: 'e2', source: 'load', target: 'out' },
    ],
  },
  bindings: [],
  notes: {
    objective:
      'Bring an account\'s extracts into the workspace from files that already exist, so the ROI page can build its report on them. It worked when the ROI page lists the account with the extracts loaded today and an analysis run on it builds without asking for data.',
    inputs: [
      { name: 'account', description: 'The account, as the ROI page names it. The ROI page passes it when it starts the flow.', example: 'Iron Mountain' },
      ...ROI_SOURCE_KINDS.map((kind) => ({ name: `${kind}Url`, description: `A link to the ${ROI_SOURCE_LABEL[kind].toLowerCase()} file. ${ROI_EXTRACT_CONTRACT[kind].grain} Required columns: ${ROI_EXTRACT_CONTRACT[kind].required.join(', ')}.` })),
    ],
    steps: [
      { nodeId: 'collect', title: 'Collect the file links', what: 'Pairs each link the run gave with its extract kind and drops the blanks.', why: 'The one step to replace when the links come from a pipeline instead of the run\'s inputs.' },
      { nodeId: 'load', title: 'Fetch each file and load it as the extract', what: 'Fetches each file on the platform and loads it into the Repository as the account\'s extract of that kind, three at a time.', why: 'Fetching and loading in one step keeps files of any size off the canvas, and a failed fetch fails the run rather than leaving a report to build on a missing extract.' },
      { nodeId: 'out', title: 'Report what was loaded', what: 'Lists the loaded extracts with their dataset ids, row counts and any missing required columns.' },
    ],
    decisionRules:
      'Only the links the run gives are loaded; a blank link leaves the newest extract of that kind in place. A file must be a CSV or TSV with a header row and at least two columns; a link that answers an error, HTML or JSON fails its extract, and one failed extract fails the run.',
    failureHandling:
      'Each load retries once after 30 seconds. A link that cannot be fetched fails the run with the HTTP status; a link that needs a token names the host whose HTTP credential to save. Loading replaces nothing: the newest extract per kind is what the ROI page reads, so a failed run leaves the previous extracts in place.',
    setup: [
      { label: 'If the links need a token, save an HTTP credential for that host in Integrations (signed links need none)', kind: 'integration', ref: 'HTTP API' },
      { label: 'Publish the flow, then choose it as the data source on the ROI analysis page — or run it by hand for each account', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Replace the Collect step with the step that produces your links: a bucket listing, an export job, an HTTP call to your pipeline.',
      'Add a schedule trigger and a fixed account list to refresh every account nightly; the ROI page reads the newest extract per kind.',
      'Lower the load step\'s concurrency to one if the file host throttles.',
    ],
    testPlan:
      'Run the flow by hand with an account and one link. Confirm the extract appears for the account on the ROI analysis page with today\'s date and no missing required columns, then run an analysis on the account and check it builds without asking for data.',
  },
}
