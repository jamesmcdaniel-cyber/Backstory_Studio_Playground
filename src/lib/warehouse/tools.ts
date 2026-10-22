import { apiLogger } from '@/lib/logger'
import type { ResolvedHttpCredential } from '@/features/flows/http-auth'
import {
  DEFAULT_JOB_DEADLINE_MS,
  DEFAULT_STATEMENT_DEADLINE_MS,
  databricksRequest,
  pickDefaultWarehouse,
  runDatabricksJob,
  runWarehouseStatement,
  type DatabricksRequest,
  type DatabricksStatementParameter,
} from './databricks'
import { DEFAULT_SNOWFLAKE_DEADLINE_MS, runSnowflakeStatement, snowflakeRequest, type SnowflakeRequest } from './snowflake'
import { resolveWarehouseHost, warehouseCredentialForHost, type WarehouseKind } from './credentials'
import { sqlIsReadOnly } from './sql-classify'

/**
 * The warehouse planes — Databricks and Snowflake as tools for flow `tool`
 * steps and agents alike.
 *
 *   databricks_sql_query   one SQL statement on a SQL warehouse → records
 *   databricks_run_job     start a Databricks job and wait for it to finish
 *   snowflake_sql_query    one SQL statement through the SQL API v2 → records
 *
 * Write classification is per CALL, not per tool: a query whose SQL is a read
 * (SELECT / SHOW / DESCRIBE / WITH…SELECT — see sql-classify) is a read;
 * anything else, and every job run, is a write.
 *
 * The plane needs a saved HTTP credential restricted to the warehouse host.
 * `host` is optional on every tool — with one saved host for the kind, that
 * host is used, which is how an imported n8n step runs without anyone typing
 * an account address.
 */

const DEFAULT_MAX_ROWS = 10_000
const MAX_ROWS_LIMIT = 100_000
const MAX_STATEMENT_CHARS = 200_000

type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }

const hostProperty = (example: string) => ({
  type: 'string',
  description: `The workspace/account host, e.g. ${example}. Optional when this workspace has saved a credential for exactly one such host.`,
})
const maxRowsProperty = { type: 'number', description: `Most rows to return (default ${DEFAULT_MAX_ROWS.toLocaleString('en-US')}, at most ${MAX_ROWS_LIMIT.toLocaleString('en-US')}); "truncated" says when there were more.` }

export const DATABRICKS_TOOLS: ToolSpec[] = [
  {
    name: 'databricks_sql_query',
    description:
      'Run one SQL statement on a Databricks SQL warehouse and return the result as records ({ rows: [{ column: value }], columns, rowCount, truncated }). ' +
      'Pass values as named parameters (`:name` in the SQL with parameters: [{ name, value, type? }]) rather than writing them into the SQL. ' +
      'SELECT / SHOW / DESCRIBE / WITH…SELECT are reads; any other statement changes data and is treated as a write.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The SQL statement.' },
        parameters: {
          type: 'array',
          description: 'Named parameters, referenced in the SQL as :name.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              type: { type: 'string', description: 'Optional SQL type: STRING, INT, BIGINT, DOUBLE, BOOLEAN, DATE, TIMESTAMP…' },
            },
            required: ['name'],
          },
        },
        warehouseId: { type: 'string', description: 'The SQL warehouse id. Optional when the workspace has one warehouse (or one running).' },
        catalog: { type: 'string', description: 'Default catalog for unqualified names.' },
        schema: { type: 'string', description: 'Default schema for unqualified names.' },
        host: hostProperty('dbc-a1b2c3d4-e5f6.cloud.databricks.com'),
        maxRows: maxRowsProperty,
        timeoutMinutes: { type: 'number', description: 'Give up after this many minutes (default 20, at most 60).' },
      },
      required: ['statement'],
    },
  },
  {
    name: 'databricks_run_job',
    description:
      'Start a Databricks job (Workflows) run and wait for it to finish; fails with Databricks\' message when the run does not succeed. Always a write.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job id (Workflows → the job → Job details).' },
        jobParameters: { type: 'object', description: 'Job-level parameters, as name → value.' },
        notebookParams: { type: 'object', description: 'Notebook task parameters (legacy jobs without job-level parameters), as name → value.' },
        waitForCompletion: { type: 'boolean', description: 'Wait for the run to finish (default true). False returns the run id right after it starts.' },
        host: hostProperty('dbc-a1b2c3d4-e5f6.cloud.databricks.com'),
        timeoutMinutes: { type: 'number', description: 'Give up waiting after this many minutes (default 30, at most 60); the run itself continues in Databricks.' },
      },
      required: ['jobId'],
    },
  },
]

export const SNOWFLAKE_TOOLS: ToolSpec[] = [
  {
    name: 'snowflake_sql_query',
    description:
      'Run one SQL statement on Snowflake (SQL API) and return the result as records ({ rows: [{ COLUMN: value }], columns, rowCount, truncated }). ' +
      'Pass values as bindings (? or :1 in the SQL, bindings: [value, …] in order) rather than writing them into the SQL. ' +
      'SELECT / SHOW / DESCRIBE / WITH…SELECT are reads; any other statement changes data and is treated as a write.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The SQL statement.' },
        bindings: {
          type: 'array',
          description: 'Values for ? / :1, :2 … in order. Numbers bind as numbers, true/false as booleans, everything else as text.',
          items: {},
        },
        warehouse: { type: 'string', description: 'Virtual warehouse. Defaults to the user\'s default warehouse.' },
        database: { type: 'string', description: 'Database for unqualified names.' },
        schema: { type: 'string', description: 'Schema for unqualified names.' },
        role: { type: 'string', description: 'Role to run as. Defaults to the user\'s default role.' },
        host: hostProperty('myorg-myaccount.snowflakecomputing.com'),
        maxRows: maxRowsProperty,
        timeoutSeconds: { type: 'number', description: 'Give up after this many seconds (default 1200, at most 3600).' },
      },
      required: ['statement'],
    },
  },
]

export const WAREHOUSE_TOOLS: Record<WarehouseKind, ToolSpec[]> = { databricks: DATABRICKS_TOOLS, snowflake: SNOWFLAKE_TOOLS }

export const WAREHOUSE_PROVIDERS: ReadonlySet<string> = new Set<WarehouseKind>(['databricks', 'snowflake'])

export function isWarehouseProvider(provider: string): provider is WarehouseKind {
  return WAREHOUSE_PROVIDERS.has(provider)
}

/** Which plane a warehouse tool belongs to, or null. */
export function warehouseKindForTool(toolName: string): WarehouseKind | null {
  if (DATABRICKS_TOOLS.some((tool) => tool.name === toolName)) return 'databricks'
  if (SNOWFLAKE_TOOLS.some((tool) => tool.name === toolName)) return 'snowflake'
  return null
}

/**
 * Per-call write classification. Without the call's args (a catalog or a
 * plane-level decision) a query tool counts as a write: it CAN write.
 */
export function warehouseToolIsWrite(toolName: string, args?: Record<string, unknown>): boolean {
  if (toolName === 'databricks_sql_query' || toolName === 'snowflake_sql_query') {
    return !args || !sqlIsReadOnly(args.statement)
  }
  return true
}

const text = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

const bounded = (value: unknown, fallback: number, max: number): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), max) : fallback
}

/** A tool arg given as an object, or as JSON text (flow args are templated strings). */
function objectArg(args: Record<string, unknown>, key: string): unknown {
  const value = args[key]
  if (typeof value !== 'string') return value
  if (!value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`"${key}" must be ${key === 'bindings' || key === 'parameters' ? 'a list' : 'an object'}, not text.`)
  }
}

function stringMap(value: unknown, key: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`"${key}" must be an object of name → value.`)
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, typeof item === 'string' ? item : JSON.stringify(item)]))
}

function statementArg(args: Record<string, unknown>): string {
  const statement = typeof args.statement === 'string' ? args.statement.trim() : typeof args.query === 'string' ? args.query.trim() : ''
  if (!statement) throw new Error('Pass the SQL statement to run.')
  if (statement.length > MAX_STATEMENT_CHARS) throw new Error(`The statement is longer than ${MAX_STATEMENT_CHARS.toLocaleString('en-US')} characters.`)
  return statement
}

function databricksParameters(value: unknown): DatabricksStatementParameter[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('"parameters" must be a list of { name, value, type? }.')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Parameter ${index + 1} must be { name, value }.`)
    const { name, value: raw, type } = entry as { name?: unknown; value?: unknown; type?: unknown }
    if (typeof name !== 'string' || !/^[A-Za-z_][\w]*$/.test(name)) throw new Error(`Parameter ${index + 1} needs a name made of letters, digits and _.`)
    return {
      name,
      value: raw === null || raw === undefined ? null : typeof raw === 'string' ? raw : JSON.stringify(raw),
      ...(typeof type === 'string' && type.trim() ? { type: type.trim().toUpperCase() } : {}),
    }
  })
}

/** Zip a Databricks JSON_ARRAY result into records (values stay as Databricks typed them). */
function recordsFrom(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, Array.isArray(row) ? row[index] ?? null : null])))
}

/** The credentialed request for a host, per warehouse. */
export type WarehouseRequestFactory = {
  databricks: (host: string, credential: ResolvedHttpCredential) => DatabricksRequest
  snowflake: (host: string, credential: ResolvedHttpCredential) => SnowflakeRequest
}

/**
 * The live request factories. A mutable object rather than bare functions so a
 * test can stand a scripted warehouse in for the network everywhere a client
 * is constructed (resolveFlowToolExecutor, the approval decider).
 */
export const warehouseRequests: WarehouseRequestFactory = { databricks: databricksRequest, snowflake: snowflakeRequest }

export class WarehouseToolClient {
  constructor(
    private readonly organizationId: string,
    private readonly userId: string,
    private readonly kind: WarehouseKind,
    private readonly requests: WarehouseRequestFactory = warehouseRequests,
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  private async connect<T>(args: Record<string, unknown>, factory: (host: string, credential: ResolvedHttpCredential) => T): Promise<{ host: string; request: T }> {
    const host = await resolveWarehouseHost(this.organizationId, this.kind, text(args, 'host') || text(args, 'account') || undefined)
    const credential = await warehouseCredentialForHost(this.organizationId, host, {
      kind: this.kind,
      actorUserId: this.userId || null,
      consumer: `warehouse.${this.kind}`,
    })
    return { host, request: factory(host, credential) }
  }

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const started = Date.now()
    const tools = this.kind === 'databricks' ? DATABRICKS_TOOLS : SNOWFLAKE_TOOLS
    if (!tools.some((tool) => tool.name === name)) throw new Error(`Unknown ${this.kind} tool: ${name}`)

    if (name === 'snowflake_sql_query') {
      const statement = statementArg(args)
      const maxRows = bounded(args.maxRows, DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT)
      const timeoutSeconds = bounded(args.timeoutSeconds, DEFAULT_SNOWFLAKE_DEADLINE_MS / 1000, 3600)
      const { host, request } = await this.connect(args, this.requests.snowflake)
      const result = await runSnowflakeStatement({
        statement,
        request,
        bindings: objectArg(args, 'bindings') as unknown[] | Record<string, unknown> | undefined,
        ...(text(args, 'database') ? { database: text(args, 'database') } : {}),
        ...(text(args, 'schema') ? { schema: text(args, 'schema') } : {}),
        ...(text(args, 'warehouse') ? { warehouse: text(args, 'warehouse') } : {}),
        ...(text(args, 'role') ? { role: text(args, 'role') } : {}),
        timeoutSeconds,
        deadlineMs: timeoutSeconds * 1000,
        maxRows,
        ...(this.sleep ? { sleep: this.sleep } : {}),
      })
      apiLogger.info('warehouse: snowflake statement finished', { organizationId: this.organizationId, host, rows: result.rows.length, partitions: result.partitions, ms: Date.now() - started })
      return { rows: result.rows, columns: result.columns, rowCount: result.rowCount, truncated: result.truncated, statementHandle: result.statementHandle }
    }

    if (name === 'databricks_sql_query') {
      const statement = statementArg(args)
      const maxRows = bounded(args.maxRows, DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT)
      const deadlineMs = bounded(args.timeoutMinutes, DEFAULT_STATEMENT_DEADLINE_MS / 60_000, 60) * 60_000
      const parameters = databricksParameters(objectArg(args, 'parameters'))
      const { host, request } = await this.connect(args, this.requests.databricks)
      const warehouseId = text(args, 'warehouseId') || text(args, 'warehouse_id') || await pickDefaultWarehouse(request)
      const result = await runWarehouseStatement({
        warehouseId,
        statement,
        request,
        ...(parameters?.length ? { parameters } : {}),
        ...(text(args, 'catalog') ? { catalog: text(args, 'catalog') } : {}),
        ...(text(args, 'schema') ? { schema: text(args, 'schema') } : {}),
        deadlineMs,
        ...(this.sleep ? { sleep: this.sleep } : {}),
      })
      apiLogger.info('warehouse: databricks statement finished', { organizationId: this.organizationId, host, rows: result.rows.length, chunks: result.chunks, ms: Date.now() - started })
      const capped = result.rows.length > maxRows
      return {
        rows: recordsFrom(result.columns, capped ? result.rows.slice(0, maxRows) : result.rows),
        columns: result.columns,
        rowCount: result.rows.length,
        truncated: result.truncated || capped,
        statementId: result.statementId,
      }
    }

    // databricks_run_job
    const jobIdText = text(args, 'jobId') || text(args, 'job_id')
    const jobId = Number(jobIdText)
    if (!jobIdText || !Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('Pass the numeric Databricks job id (Workflows → the job → Job details).')
    const deadlineMs = bounded(args.timeoutMinutes, DEFAULT_JOB_DEADLINE_MS / 60_000, 60) * 60_000
    const { host, request } = await this.connect(args, this.requests.databricks)
    const run = await runDatabricksJob({
      jobId,
      request,
      jobParameters: stringMap(objectArg(args, 'jobParameters'), 'jobParameters'),
      notebookParams: stringMap(objectArg(args, 'notebookParams'), 'notebookParams'),
      waitForCompletion: args.waitForCompletion !== false && args.waitForCompletion !== 'false',
      deadlineMs,
      ...(this.sleep ? { sleep: this.sleep } : {}),
    })
    apiLogger.info('warehouse: databricks job run finished', { organizationId: this.organizationId, host, jobId, runId: run.runId, completed: run.completed, ms: Date.now() - started })
    return run
  }
}
