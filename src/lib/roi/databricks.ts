import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { fetchPublicUrl } from '@/lib/net/ssrf'
import { readResponseTextLimited } from '@/lib/net/response-body'
import { applyHttpCredential, resolveHttpCredential, type ResolvedHttpCredential } from '@/features/flows/http-auth'
import { DATASET_MAX_BYTES } from '@/lib/files/storage'
import { isRoiSourceKind, loadRoiSource, ROI_SOURCE_KINDS, type RoiSourceKind } from './sources'

/**
 * One warehouse query on Databricks, loaded as an account's ROI extract.
 *
 * The ROI data flow ("ROI data pull · Databricks") runs each of the account's
 * queries through the Databricks SQL Statement Execution API and writes the
 * result to the Repository tagged `sourceMetadata.roi = { account, kind,
 * loadedAt }` — exactly what the operator loader writes, so nothing downstream
 * changes. It is a tool on the ROI plane rather than HTTP steps on the canvas
 * because a flow step's HTTP response is capped at 1 MB and an extract runs
 * to tens of megabytes: the rows never pass through step outputs, only the
 * loaded dataset's id and row count do.
 *
 *   submit   POST /api/2.0/sql/statements { warehouse_id, statement,
 *            wait_timeout: "50s", on_wait_timeout: "CONTINUE", INLINE, JSON_ARRAY }
 *   poll     GET  /api/2.0/sql/statements/{id} every few seconds until it is
 *            SUCCEEDED (or fails, or the deadline passes)
 *   collect  the first chunk comes with the statement; further chunks follow
 *            `next_chunk_internal_link`
 *   load     rows → CSV (the manifest's column names as the header) → loadRoiSource
 *
 * Authentication is the workspace's saved HTTP credential for the Databricks
 * host (a personal access token as a bearer credential, say): host-locked by
 * the credential store, applied by applyHttpCredential, never in the graph.
 */

export class DatabricksStatementError extends Error {}

/** A bounded, credentialed request — injectable so the statement loop is testable without a network. */
export type DatabricksRequest = (path: string, init: { method: 'GET' | 'POST'; body?: string }) => Promise<{ status: number; ok: boolean; text: string }>

export type WarehouseResult = { statementId: string; columns: string[]; rows: unknown[][]; truncated: boolean; chunks: number }

const REQUEST_TIMEOUT_MS = 120_000
/** How long one query may run (submit to SUCCEEDED) before the pull gives up on it. */
export const DEFAULT_STATEMENT_DEADLINE_MS = 20 * 60_000
const POLL_MS = 5_000
/** Databricks caps `wait_timeout` at 50s. */
const WAIT_TIMEOUT_SECONDS = 50
/** Per-response read cap; chunks are a few MB each. */
const CHUNK_MAX_BYTES = 64_000_000
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

function parseJson(text: string, what: string): StatementResponse {
  try {
    return JSON.parse(text) as StatementResponse
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

/**
 * Run one statement to completion and collect every result chunk. Pure over
 * `request`, so the submit / poll / chunk protocol is tested with a fake.
 */
export async function runWarehouseStatement(params: {
  warehouseId: string
  statement: string
  request: DatabricksRequest
  deadlineMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<WarehouseResult> {
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
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
  if (!columns.length) throw new DatabricksStatementError('The statement succeeded but its result has no columns.')
  const rows: unknown[][] = [...(current.result?.data_array ?? [])]
  let next = current.result?.next_chunk_internal_link ?? null
  let chunks = 1
  while (next) {
    if (chunks >= MAX_CHUNKS) throw new DatabricksStatementError(`The result has more than ${MAX_CHUNKS} chunks; narrow the query.`)
    const chunk = await params.request(next, { method: 'GET' })
    if (!chunk.ok) throw describeFailure(chunk, 'Reading a result chunk')
    const parsed = parseJson(chunk.text, 'Reading a result chunk') as { data_array?: unknown[][]; next_chunk_internal_link?: string | null }
    rows.push(...(parsed.data_array ?? []))
    next = parsed.next_chunk_internal_link ?? null
    chunks += 1
  }
  return { statementId, columns, rows, truncated: current.manifest?.truncated === true, chunks }
}

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** RFC 4180 CSV: the header, then every row; nulls are empty cells, objects are JSON. */
export function rowsToCsv(columns: string[], rows: unknown[][]): string {
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) lines.push(columns.map((_, index) => csvCell(row[index])).join(','))
  return `${lines.join('\n')}\n`
}

/** The workspace's saved HTTP credential for this host, or a plain-English reason there is none. */
async function credentialForHost(organizationId: string, host: string, actorUserId: string | null): Promise<ResolvedHttpCredential> {
  const row = await prisma.httpCredential.findFirst({ where: { organizationId, allowedHost: host, status: { in: ['verified', 'error'] } }, select: { id: true } })
  if (!row) throw new DatabricksStatementError(`No saved HTTP credential for ${host}. Save one in Integrations (a Databricks personal access token as a bearer credential, restricted to that host) and run again.`)
  return resolveHttpCredential(row.id, organizationId, { actorUserId, consumer: 'roi.databricks_pull' })
}

/** A request to the workspace host with the credential applied, SSRF-guarded, bounded in time and size. */
export function databricksRequest(host: string, credential: ResolvedHttpCredential): DatabricksRequest {
  return async (path, init) => {
    const url = `https://${host}${path.startsWith('/') ? path : `/${path}`}`
    const headers: Record<string, string> = { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) }
    const request = await applyHttpCredential({ url, init: { method: init.method, headers, body: init.body } }, credential)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchPublicUrl(request.url, { ...request.init, signal: controller.signal }, { maxRedirects: 0 })
      const text = await readResponseTextLimited(response, CHUNK_MAX_BYTES, 'Databricks response')
      return { status: response.status, ok: response.ok, text }
    } finally {
      clearTimeout(timer)
    }
  }
}

export type PullRoiExtractParams = {
  organizationId: string
  userId: string
  host: string
  warehouseId: string
  statement: string
  account: string
  kind: string
  filename?: string
  deadlineMs?: number
  /** Test seam: stands in for the credentialed request. */
  request?: DatabricksRequest
  sleep?: (ms: number) => Promise<void>
}

export type PullRoiExtractResult = { documentId: string; kind: RoiSourceKind; account: string; filename: string; rows: number; columns: number; truncated: boolean; statementId: string; bytes: number }

/** Run one of the account's warehouse queries and load its result as that extract. Throws on any failure: the flow run must fail, not succeed with nothing loaded. */
export async function pullRoiExtract(params: PullRoiExtractParams): Promise<PullRoiExtractResult> {
  const account = params.account.trim()
  if (!account) throw new DatabricksStatementError('Pass the account the extract belongs to.')
  if (!isRoiSourceKind(params.kind)) throw new DatabricksStatementError(`"${params.kind}" is not an extract kind (one of ${ROI_SOURCE_KINDS.join(', ')}).`)
  const kind: RoiSourceKind = params.kind
  const warehouseId = params.warehouseId.trim()
  if (!/^[a-z0-9]{6,64}$/i.test(warehouseId)) throw new DatabricksStatementError('Pass the SQL warehouse id (the hexadecimal id from the warehouse\'s connection details).')
  const statement = params.statement.trim()
  if (!statement) throw new DatabricksStatementError('The statement is empty.')
  if (statement.length > 200_000) throw new DatabricksStatementError('The statement is longer than 200,000 characters.')
  const host = assertDatabricksHost(params.host)
  const request = params.request ?? databricksRequest(host, await credentialForHost(params.organizationId, host, params.userId || null))
  const started = Date.now()
  const result = await runWarehouseStatement({ warehouseId, statement, request, deadlineMs: params.deadlineMs, sleep: params.sleep })
  const csv = rowsToCsv(result.columns, result.rows)
  const buffer = Buffer.from(csv, 'utf8')
  if (buffer.length > DATASET_MAX_BYTES) throw new DatabricksStatementError(`The ${kind} extract is ${(buffer.length / 1e6).toFixed(0)} MB, over the ${DATASET_MAX_BYTES / 1e6} MB dataset limit; narrow the query.`)
  const filename = (params.filename?.trim() || `${account.replace(/[^\w.-]+/g, '_')}_${kind}.csv`).replace(/[/\\]/g, '_')
  const loaded = await loadRoiSource({ organizationId: params.organizationId, userId: params.userId || null, account, kind, filename: filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`, buffer, trusted: true })
  apiLogger.info('roi databricks pull: extract loaded', { organizationId: params.organizationId, account, kind, rows: result.rows.length, chunks: result.chunks, truncated: result.truncated, ms: Date.now() - started })
  return { documentId: loaded.documentId, kind, account, filename, rows: result.rows.length, columns: result.columns.length, truncated: result.truncated, statementId: result.statementId, bytes: buffer.length }
}
