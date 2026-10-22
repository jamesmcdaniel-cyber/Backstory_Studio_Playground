import { randomUUID } from 'node:crypto'
import type { ResolvedHttpCredential } from '@/features/flows/http-auth'
import { credentialedWarehouseRequest, defaultSleep, type WarehouseRequest } from './http'

/**
 * Snowflake over its SQL API v2.
 *
 *   submit     POST /api/v2/statements { statement, timeout, database, schema,
 *              warehouse, role, bindings } — 200 with the first partition when
 *              the statement finishes inside Snowflake's ~45s synchronous
 *              window, 202 with a statement handle when it does not
 *   poll       GET  /api/v2/statements/{handle} until it answers 200 (or 422),
 *              backing off, bounded by the deadline
 *   partitions GET  /api/v2/statements/{handle}?partition=N for every further
 *              partition listed in resultSetMetaData.partitionInfo
 *
 * Values come back as strings (format jsonv2); they are converted per the
 * column's rowType so numbers are numbers, booleans booleans, VARIANT/OBJECT/
 * ARRAY parsed JSON and dates ISO strings — the shape the n8n Snowflake node
 * produced, so imported flows map fields the same way.
 *
 * Bind variables (`?` or `:1` in the statement) carry values separately from
 * the SQL text; nothing here ever splices a value into a statement.
 *
 * Auth is the saved HTTP credential for the account host: a key pair (signed
 * JWT), a programmatic access token, or an OAuth token — applied by the request
 * function with the matching X-Snowflake-Authorization-Token-Type header.
 */

export class SnowflakeStatementError extends Error {}

export type SnowflakeRequest = WarehouseRequest

export type SnowflakeBindingInput = unknown[] | Record<string, unknown> | undefined
export type SnowflakeBinding = { type: string; value: string | null }

export type SnowflakeResult = {
  statementHandle: string
  columns: string[]
  /** Rows as records keyed by column name, converted per column type. */
  rows: Record<string, unknown>[]
  /** Rows Snowflake reports for the whole result (may exceed rows.length when capped). */
  rowCount: number
  truncated: boolean
  partitions: number
}

export const DEFAULT_SNOWFLAKE_DEADLINE_MS = 20 * 60_000
const MAX_PARTITIONS = 500
const MAX_BINDINGS = 1000
const POLL_START_MS = 1_000
const POLL_MAX_MS = 10_000

type RowType = { name?: string; type?: string; scale?: number | null }
type ResultSet = {
  code?: string
  message?: string
  sqlState?: string
  statementHandle?: string
  statementStatusUrl?: string
  resultSetMetaData?: { numRows?: number; rowType?: RowType[]; partitionInfo?: Array<{ rowCount?: number }> }
  data?: unknown[][]
}

function parse(text: string, what: string): ResultSet {
  try {
    return JSON.parse(text) as ResultSet
  } catch {
    throw new SnowflakeStatementError(`${what} did not return JSON: ${text.slice(0, 200)}`)
  }
}

function describeFailure(response: { status: number; text: string }, what: string): SnowflakeStatementError {
  let detail = response.text.slice(0, 300)
  try {
    const parsed = JSON.parse(response.text) as ResultSet
    if (parsed.message) detail = `${parsed.code ? `${parsed.code}: ` : ''}${parsed.message}`
  } catch { /* plain text stays as read */ }
  if (response.status === 401 || response.status === 403) {
    detail = `${detail} — check the saved Snowflake credential for this account (a key pair, programmatic access token or OAuth token for a user whose role can use the warehouse).`
  }
  if (/no active warehouse/i.test(detail)) detail = `${detail} — pass "warehouse", or set a DEFAULT_WAREHOUSE on the Snowflake user.`
  return new SnowflakeStatementError(`${what} failed (HTTP ${response.status}): ${detail}`)
}

/** Positional values or `{ "1": … }` → the SQL API's typed `bindings` object. */
export function snowflakeBindings(input: SnowflakeBindingInput): Record<string, SnowflakeBinding> | undefined {
  if (input === undefined || input === null) return undefined
  const entries: Array<[string, unknown]> = Array.isArray(input)
    ? input.map((value, index) => [String(index + 1), value])
    : typeof input === 'object'
      ? Object.entries(input)
      : (() => { throw new SnowflakeStatementError('bindings must be a list of values (one per ? in the statement) or an object keyed "1", "2", ….') })()
  if (entries.length === 0) return undefined
  if (entries.length > MAX_BINDINGS) throw new SnowflakeStatementError(`A statement takes at most ${MAX_BINDINGS} bindings.`)
  const out: Record<string, SnowflakeBinding> = {}
  for (const [key, raw] of entries) {
    if (!/^\d+$/.test(key)) throw new SnowflakeStatementError(`Binding "${key}" must be numbered ("1", "2", …) to match ? or :1 in the statement.`)
    out[key] = toBinding(raw)
  }
  return out
}

function toBinding(raw: unknown): SnowflakeBinding {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { type?: unknown }).type === 'string' && 'value' in (raw as object)) {
    const typed = raw as { type: string; value: unknown }
    return { type: typed.type.toUpperCase(), value: typed.value === null || typed.value === undefined ? null : typeof typed.value === 'string' ? typed.value : JSON.stringify(typed.value) }
  }
  if (raw === null || raw === undefined) return { type: 'TEXT', value: null }
  if (typeof raw === 'boolean') return { type: 'BOOLEAN', value: String(raw) }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { type: 'TEXT', value: String(raw) }
    return Number.isInteger(raw) ? { type: 'FIXED', value: String(raw) } : { type: 'REAL', value: String(raw) }
  }
  if (typeof raw === 'string') return { type: 'TEXT', value: raw }
  return { type: 'TEXT', value: JSON.stringify(raw) }
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/** jsonv2 epoch "seconds.fraction" → ISO-8601 UTC. */
function epochSecondsToIso(value: string): string {
  const [whole, fraction = ''] = value.trim().split('.')
  const ms = Number(whole) * 1000 + Number((fraction + '000').slice(0, 3)) * (whole.startsWith('-') ? -1 : 1)
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : value
}

/** Convert one jsonv2 string cell per its column type; unknowns stay strings. */
export function coerceSnowflakeValue(value: unknown, column: RowType | undefined): unknown {
  if (value === null || value === undefined || typeof value !== 'string') return value ?? null
  const type = (column?.type ?? '').toLowerCase()
  switch (type) {
    case 'fixed': {
      const scale = Number(column?.scale ?? 0)
      const number = Number(value)
      if (!Number.isFinite(number)) return value
      // Past 2^53 a NUMBER(38,0) loses digits as a JS number — keep the exact string.
      if (scale === 0 && !Number.isSafeInteger(number)) return value
      return number
    }
    case 'real':
    case 'float':
    case 'double': {
      const number = Number(value)
      return Number.isFinite(number) ? number : value
    }
    case 'boolean':
      return value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value
    case 'variant':
    case 'object':
    case 'array':
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    case 'date': {
      // Days since the epoch.
      const days = Number(value)
      if (!Number.isFinite(days)) return value
      return new Date(days * 86_400_000).toISOString().slice(0, 10)
    }
    case 'time': {
      const seconds = Number(value)
      if (!Number.isFinite(seconds)) return value
      const whole = Math.floor(seconds)
      const fraction = value.includes('.') ? `.${value.split('.')[1]}` : ''
      return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}${fraction}`
    }
    case 'timestamp_ntz':
    case 'timestamp_ltz':
      return epochSecondsToIso(value)
    case 'timestamp_tz':
      // "<epoch seconds.fraction> <offset minutes + 1440>" — the instant is the epoch part.
      return epochSecondsToIso(value.split(' ')[0])
    default:
      return value
  }
}

function toRecords(rowType: RowType[], data: unknown[][]): Record<string, unknown>[] {
  const names = rowType.map((column, index) => column.name || `COLUMN${index + 1}`)
  return data.map((row) => Object.fromEntries(names.map((name, index) => [name, coerceSnowflakeValue(Array.isArray(row) ? row[index] : undefined, rowType[index])])))
}

/**
 * Run one statement to completion and read its partitions (up to `maxRows`
 * rows). Pure over `request`, so the 202/poll/partition protocol is tested
 * with a fake.
 */
export async function runSnowflakeStatement(params: {
  statement: string
  request: SnowflakeRequest
  bindings?: SnowflakeBindingInput
  database?: string
  schema?: string
  warehouse?: string
  role?: string
  /** Snowflake-side statement timeout, seconds. Defaults to the deadline. */
  timeoutSeconds?: number
  maxRows?: number
  deadlineMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<SnowflakeResult> {
  const sleep = params.sleep ?? defaultSleep
  const now = params.now ?? Date.now
  const deadlineMs = params.deadlineMs ?? DEFAULT_SNOWFLAKE_DEADLINE_MS
  const deadline = now() + deadlineMs
  const maxRows = params.maxRows ?? Number.POSITIVE_INFINITY
  const bindings = snowflakeBindings(params.bindings)
  const timeout = Math.max(1, Math.min(604_800, Math.round(params.timeoutSeconds ?? deadlineMs / 1000)))
  const submitted = await params.request(`/api/v2/statements?requestId=${randomUUID()}`, {
    method: 'POST',
    body: JSON.stringify({
      statement: params.statement,
      timeout,
      ...(params.database ? { database: params.database } : {}),
      ...(params.schema ? { schema: params.schema } : {}),
      ...(params.warehouse ? { warehouse: params.warehouse } : {}),
      ...(params.role ? { role: params.role } : {}),
      ...(bindings ? { bindings } : {}),
    }),
  })
  if (submitted.status !== 200 && submitted.status !== 202) throw describeFailure(submitted, 'Running the statement')
  let current = parse(submitted.text, 'Running the statement')
  let status = submitted.status
  const handle = current.statementHandle
  if (!handle) throw new SnowflakeStatementError('Snowflake returned no statement handle.')

  let wait = POLL_START_MS
  while (status === 202) {
    if (now() >= deadline) {
      // Best effort: stop the warehouse spending credits on a result nobody reads.
      await params.request(`/api/v2/statements/${encodeURIComponent(handle)}/cancel`, { method: 'POST', body: '{}' }).catch(() => undefined)
      throw new SnowflakeStatementError(`The statement (${handle}) was still running after ${Math.round(deadlineMs / 60_000)} minutes and was cancelled. Use a larger warehouse or narrow the query.`)
    }
    await sleep(wait)
    wait = Math.min(POLL_MAX_MS, wait * 2)
    const polled = await params.request(`/api/v2/statements/${encodeURIComponent(handle)}`, { method: 'GET' })
    if (polled.status !== 200 && polled.status !== 202) throw describeFailure(polled, 'Reading the statement')
    status = polled.status
    current = parse(polled.text, 'Reading the statement')
  }

  const rowType = current.resultSetMetaData?.rowType ?? []
  const columns = rowType.map((column, index) => column.name || `COLUMN${index + 1}`)
  const partitions = Math.max(1, current.resultSetMetaData?.partitionInfo?.length ?? 1)
  if (partitions > MAX_PARTITIONS) throw new SnowflakeStatementError(`The result has more than ${MAX_PARTITIONS} partitions; narrow the query.`)
  const rowCount = current.resultSetMetaData?.numRows ?? current.data?.length ?? 0
  const rows = toRecords(rowType, current.data ?? [])
  let read = 1
  for (let partition = 1; partition < partitions && rows.length < maxRows; partition++) {
    const page = await params.request(`/api/v2/statements/${encodeURIComponent(handle)}?partition=${partition}`, { method: 'GET' })
    if (page.status !== 200) throw describeFailure(page, `Reading result partition ${partition}`)
    rows.push(...toRecords(rowType, parse(page.text, `Reading result partition ${partition}`).data ?? []))
    read += 1
  }
  const truncated = rows.length > maxRows || read < partitions
  return { statementHandle: handle, columns, rows: rows.length > maxRows ? rows.slice(0, maxRows) : rows, rowCount, truncated, partitions }
}

/** A request to the account host with the credential applied, SSRF-guarded, bounded in time and size. */
export function snowflakeRequest(host: string, credential: ResolvedHttpCredential): SnowflakeRequest {
  return credentialedWarehouseRequest(host, credential, {
    label: 'Snowflake response',
    headers: {
      'user-agent': 'Backstory/1.0',
      // Key-pair and PAT credentials set their own token type in applyHttpCredential;
      // an OAuth-type credential is declared here. A plain bearer credential sends
      // none, and Snowflake infers the type from the token.
      ...(credential.authType === 'oauth2' ? { 'x-snowflake-authorization-token-type': 'OAUTH' } : {}),
    },
  })
}
