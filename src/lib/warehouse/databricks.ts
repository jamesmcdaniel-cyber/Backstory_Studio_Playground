import type { ResolvedHttpCredential } from '@/features/flows/http-auth'
import { credentialedWarehouseRequest, defaultSleep, type WarehouseRequest } from './http'

/**
 * Databricks over its REST API: SQL statements on a SQL warehouse, and job runs.
 *
 * Statements (SQL Statement Execution API 2.0):
 *   submit   POST /api/2.0/sql/statements { warehouse_id, statement, parameters,
 *            wait_timeout: "50s", on_wait_timeout: "CONTINUE", INLINE, JSON_ARRAY }
 *   poll     GET  /api/2.0/sql/statements/{id} every few seconds until it is
 *            SUCCEEDED (or fails, or the deadline passes)
 *   collect  the first chunk comes with the statement; further chunks follow
 *            `next_chunk_internal_link`
 *
 * Jobs (Jobs API 2.1):
 *   start    POST /api/2.1/jobs/run-now { job_id, job_parameters | notebook_params }
 *   poll     GET  /api/2.1/jobs/runs/get?run_id=… until the run is terminal
 *
 * Both are pure over `request` (see ./http), so the protocols are tested with a
 * scripted fake. Authentication is the workspace's saved HTTP credential for
 * the host — a personal access token as a bearer credential, or OAuth client
 * credentials — applied by the request function, never in the graph.
 */

export class DatabricksStatementError extends Error {}

/** A bounded, credentialed request — injectable so the statement loop is testable without a network. */
export type DatabricksRequest = WarehouseRequest

export type WarehouseResult = { statementId: string; columns: string[]; rows: unknown[][]; truncated: boolean; chunks: number }

/** How long one query may run (submit to SUCCEEDED) before the pull gives up on it. */
export const DEFAULT_STATEMENT_DEADLINE_MS = 20 * 60_000
const POLL_MS = 5_000
/** Databricks caps `wait_timeout` at 50s. */
const WAIT_TIMEOUT_SECONDS = 50
const MAX_CHUNKS = 200

type StatementResponse = {
  statement_id?: string
  status?: { state?: string; error?: { error_code?: string; message?: string } }
  manifest?: { schema?: { columns?: Array<{ name?: string }> }; truncated?: boolean; total_chunk_count?: number }
  result?: { data_array?: unknown[][]; next_chunk_internal_link?: string | null }
}

const hostPattern = /^[a-z0-9][a-z0-9.-]{2,250}$/i

export function assertDatabricksHost(host: string): string {
  const trimmed = host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
  if (!hostPattern.test(trimmed) || !trimmed.includes('.')) throw new DatabricksStatementError(`"${host}" is not a Databricks workspace host (expected something like dbc-a1b2c3d4-e5f6.cloud.databricks.com).`)
  return trimmed
}

function parseJson<T = StatementResponse>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new DatabricksStatementError(`${what} did not return JSON: ${text.slice(0, 200)}`)
  }
}

function describeFailure(response: { status: number; text: string }, what: string): DatabricksStatementError {
  let detail = response.text.slice(0, 300)
  try {
    const parsed = JSON.parse(response.text) as { message?: string; error_code?: string }
    if (parsed.message) detail = `${parsed.error_code ? `${parsed.error_code}: ` : ''}${parsed.message}`
  } catch { /* plain text stays as read */ }
  if (response.status === 401 || response.status === 403) detail = `${detail} — check the saved HTTP credential for this host (it must be a token that can use the SQL warehouse).`
  return new DatabricksStatementError(`${what} failed (HTTP ${response.status}): ${detail}`)
}

/** A named statement parameter, referenced in the SQL as `:name`. */
export type DatabricksStatementParameter = { name: string; value: string | null; type?: string }

/**
 * Run one statement to completion and collect every result chunk. Pure over
 * `request`, so the submit / poll / chunk protocol is tested with a fake.
 */
export async function runWarehouseStatement(params: {
  warehouseId: string
  statement: string
  request: DatabricksRequest
  /** Named parameters (`:name` in the SQL) — values travel separately from the statement text. */
  parameters?: DatabricksStatementParameter[]
  catalog?: string
  schema?: string
  deadlineMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<WarehouseResult> {
  const sleep = params.sleep ?? defaultSleep
  const now = params.now ?? Date.now
  const deadline = now() + (params.deadlineMs ?? DEFAULT_STATEMENT_DEADLINE_MS)
  const submitted = await params.request('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      warehouse_id: params.warehouseId,
      statement: params.statement,
      wait_timeout: `${WAIT_TIMEOUT_SECONDS}s`,
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      ...(params.parameters?.length ? { parameters: params.parameters } : {}),
      ...(params.catalog ? { catalog: params.catalog } : {}),
      ...(params.schema ? { schema: params.schema } : {}),
    }),
  })
  if (!submitted.ok) throw describeFailure(submitted, 'Submitting the statement')
  let current = parseJson(submitted.text, 'Submitting the statement')
  const statementId = current.statement_id
  if (!statementId) throw new DatabricksStatementError('Databricks returned no statement id.')
  // Poll until it settles. PENDING/RUNNING keep going; anything else is final.
  for (;;) {
    const state = current.status?.state ?? 'UNKNOWN'
    if (state === 'SUCCEEDED') break
    if (state === 'PENDING' || state === 'RUNNING') {
      if (now() >= deadline) throw new DatabricksStatementError(`The statement (${statementId}) was still ${state.toLowerCase()} after ${Math.round((params.deadlineMs ?? DEFAULT_STATEMENT_DEADLINE_MS) / 60_000)} minutes. Use a larger SQL warehouse or narrow the query.`)
      await sleep(POLL_MS)
      const polled = await params.request(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}`, { method: 'GET' })
      if (!polled.ok) throw describeFailure(polled, 'Reading the statement')
      current = parseJson(polled.text, 'Reading the statement')
      continue
    }
    const error = current.status?.error
    throw new DatabricksStatementError(`The statement ${state.toLowerCase()}${error?.message ? `: ${error.message.slice(0, 500)}` : '.'}`)
  }
  const columns = (current.manifest?.schema?.columns ?? []).map((column) => column.name ?? '')
  // A DDL/DML statement (CREATE, INSERT…) succeeds with no result set at all.
  if (!columns.length) return { statementId, columns: [], rows: [], truncated: false, chunks: 0 }
  const rows: unknown[][] = [...(current.result?.data_array ?? [])]
  let next = current.result?.next_chunk_internal_link ?? null
  let chunks = 1
  while (next) {
    if (chunks >= MAX_CHUNKS) throw new DatabricksStatementError(`The result has more than ${MAX_CHUNKS} chunks; narrow the query.`)
    const chunk = await params.request(next, { method: 'GET' })
    if (!chunk.ok) throw describeFailure(chunk, 'Reading a result chunk')
    const parsed = parseJson<{ data_array?: unknown[][]; next_chunk_internal_link?: string | null }>(chunk.text, 'Reading a result chunk')
    rows.push(...(parsed.data_array ?? []))
    next = parsed.next_chunk_internal_link ?? null
    chunks += 1
  }
  return { statementId, columns, rows, truncated: current.manifest?.truncated === true, chunks }
}

/**
 * The SQL warehouse to run on when the caller named none: the workspace's
 * only warehouse, or its only running one. Anything more ambiguous asks.
 */
export async function pickDefaultWarehouse(request: DatabricksRequest): Promise<string> {
  const response = await request('/api/2.0/sql/warehouses', { method: 'GET' })
  if (!response.ok) throw describeFailure(response, 'Listing SQL warehouses')
  const listed = parseJson<{ warehouses?: Array<{ id?: string; name?: string; state?: string }> }>(response.text, 'Listing SQL warehouses').warehouses ?? []
  const warehouses = listed.filter((warehouse): warehouse is { id: string; name?: string; state?: string } => typeof warehouse.id === 'string' && warehouse.id.length > 0)
  if (warehouses.length === 1) return warehouses[0].id
  const running = warehouses.filter((warehouse) => warehouse.state === 'RUNNING')
  if (running.length === 1) return running[0].id
  if (!warehouses.length) throw new DatabricksStatementError('This Databricks workspace has no SQL warehouse the credential can see. Create one (or grant CAN USE on one) and run again.')
  const names = warehouses.slice(0, 5).map((warehouse) => `${warehouse.name ?? 'unnamed'} (${warehouse.id})`).join(', ')
  throw new DatabricksStatementError(`This workspace has several SQL warehouses — pass warehouseId to choose one: ${names}.`)
}

/** A request to the workspace host with the credential applied, SSRF-guarded, bounded in time and size. */
export function databricksRequest(host: string, credential: ResolvedHttpCredential): DatabricksRequest {
  return credentialedWarehouseRequest(host, credential, { label: 'Databricks response' })
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export const DEFAULT_JOB_DEADLINE_MS = 30 * 60_000
const JOB_POLL_MS = 10_000
/** Life-cycle states after which a run never changes again. */
const TERMINAL_LIFE_CYCLE = new Set(['TERMINATED', 'SKIPPED', 'INTERNAL_ERROR'])

type JobRunResponse = {
  run_id?: number
  run_page_url?: string
  state?: { life_cycle_state?: string; result_state?: string; state_message?: string }
  status?: { state?: string; termination_details?: { code?: string; type?: string; message?: string } }
  start_time?: number
  end_time?: number
  run_duration?: number
}

export type DatabricksJobRunResult = {
  runId: number
  runPageUrl?: string
  lifeCycleState: string
  resultState?: string
  stateMessage?: string
  /** False when the caller asked not to wait: the run was started and is still going. */
  completed: boolean
  durationMs?: number
}

/**
 * Start a job run and (by default) wait for it to finish. A run that ends in
 * anything but SUCCESS throws with Databricks' own message, so a flow step
 * fails instead of reporting a failed job as done.
 */
export async function runDatabricksJob(params: {
  jobId: number
  request: DatabricksRequest
  /** Job-level parameters (jobs with parameters defined at the job level). */
  jobParameters?: Record<string, string>
  /** Legacy notebook task parameters. */
  notebookParams?: Record<string, string>
  waitForCompletion?: boolean
  deadlineMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<DatabricksJobRunResult> {
  const sleep = params.sleep ?? defaultSleep
  const now = params.now ?? Date.now
  const deadlineMs = params.deadlineMs ?? DEFAULT_JOB_DEADLINE_MS
  const deadline = now() + deadlineMs
  const started = await params.request('/api/2.1/jobs/run-now', {
    method: 'POST',
    body: JSON.stringify({
      job_id: params.jobId,
      ...(params.jobParameters && Object.keys(params.jobParameters).length ? { job_parameters: params.jobParameters } : {}),
      ...(params.notebookParams && Object.keys(params.notebookParams).length ? { notebook_params: params.notebookParams } : {}),
    }),
  })
  if (!started.ok) throw describeFailure(started, 'Starting the job')
  const runId = parseJson<{ run_id?: number }>(started.text, 'Starting the job').run_id
  if (typeof runId !== 'number') throw new DatabricksStatementError('Databricks started the job but returned no run id.')
  if (params.waitForCompletion === false) return { runId, lifeCycleState: 'PENDING', completed: false }

  for (;;) {
    const polled = await params.request(`/api/2.1/jobs/runs/get?run_id=${encodeURIComponent(String(runId))}`, { method: 'GET' })
    if (!polled.ok) throw describeFailure(polled, 'Reading the job run')
    const run = parseJson<JobRunResponse>(polled.text, 'Reading the job run')
    const lifeCycleState = run.state?.life_cycle_state ?? run.status?.state ?? 'UNKNOWN'
    if (TERMINAL_LIFE_CYCLE.has(lifeCycleState)) {
      const resultState = run.state?.result_state
      const stateMessage = run.state?.state_message || run.status?.termination_details?.message || undefined
      const durationMs = typeof run.run_duration === 'number'
        ? run.run_duration
        : typeof run.end_time === 'number' && typeof run.start_time === 'number' && run.end_time > 0 ? run.end_time - run.start_time : undefined
      if (resultState !== 'SUCCESS') {
        throw new DatabricksStatementError(`Job run ${runId} ended ${(resultState ?? lifeCycleState).toLowerCase()}${stateMessage ? `: ${stateMessage.slice(0, 500)}` : '.'}${run.run_page_url ? ` See ${run.run_page_url}` : ''}`)
      }
      return { runId, ...(run.run_page_url ? { runPageUrl: run.run_page_url } : {}), lifeCycleState, resultState, ...(stateMessage ? { stateMessage } : {}), completed: true, ...(durationMs !== undefined ? { durationMs } : {}) }
    }
    if (now() >= deadline) {
      throw new DatabricksStatementError(`Job run ${runId} was still ${lifeCycleState.toLowerCase()} after ${Math.round(deadlineMs / 60_000)} minutes — it keeps running in Databricks${run.run_page_url ? ` (${run.run_page_url})` : ''}; raise timeoutMinutes or set waitForCompletion to false.`)
    }
    await sleep(JOB_POLL_MS)
  }
}
