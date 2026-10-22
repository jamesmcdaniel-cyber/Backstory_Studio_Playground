import { apiLogger } from '@/lib/logger'
import { DATASET_MAX_BYTES } from '@/lib/files/storage'
import {
  assertDatabricksHost,
  DatabricksStatementError,
  databricksRequest,
  runWarehouseStatement,
  type DatabricksRequest,
} from '@/lib/warehouse/databricks'
import { warehouseCredentialForHost } from '@/lib/warehouse/credentials'
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
 *   run      the generic statement client (@/lib/warehouse/databricks):
 *            submit, poll until SUCCEEDED, collect every chunk
 *   load     rows → CSV (the manifest's column names as the header) → loadRoiSource
 *
 * Authentication is the workspace's saved HTTP credential for the Databricks
 * host (a personal access token as a bearer credential, say): host-locked by
 * the credential store, applied by applyHttpCredential, never in the graph.
 */

// The statement client is the generic one in @/lib/warehouse/databricks; it is
// re-exported here so existing ROI callers and tests keep their import path.
export {
  assertDatabricksHost,
  DatabricksStatementError,
  DEFAULT_STATEMENT_DEADLINE_MS,
  databricksRequest,
  runWarehouseStatement,
  type DatabricksRequest,
  type WarehouseResult,
} from '@/lib/warehouse/databricks'

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
function credentialForHost(organizationId: string, host: string, actorUserId: string | null) {
  return warehouseCredentialForHost(organizationId, host, {
    kind: 'databricks',
    actorUserId,
    consumer: 'roi.databricks_pull',
    missingMessage: `No saved HTTP credential for ${host}. Save one in Integrations (a Databricks personal access token as a bearer credential, restricted to that host) and run again.`,
  }).catch((error: unknown) => {
    throw error instanceof DatabricksStatementError ? error : new DatabricksStatementError(error instanceof Error ? error.message : String(error))
  })
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
  // The generic client answers a result-less statement (DDL/DML) with no
  // columns; an extract that has none is a broken query, not an empty one.
  if (!result.columns.length) throw new DatabricksStatementError('The statement succeeded but its result has no columns.')
  const csv = rowsToCsv(result.columns, result.rows)
  const buffer = Buffer.from(csv, 'utf8')
  if (buffer.length > DATASET_MAX_BYTES) throw new DatabricksStatementError(`The ${kind} extract is ${(buffer.length / 1e6).toFixed(0)} MB, over the ${DATASET_MAX_BYTES / 1e6} MB dataset limit; narrow the query.`)
  const filename = (params.filename?.trim() || `${account.replace(/[^\w.-]+/g, '_')}_${kind}.csv`).replace(/[/\\]/g, '_')
  const loaded = await loadRoiSource({ organizationId: params.organizationId, userId: params.userId || null, account, kind, filename: filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`, buffer, trusted: true })
  apiLogger.info('roi databricks pull: extract loaded', { organizationId: params.organizationId, account, kind, rows: result.rows.length, chunks: result.chunks, truncated: result.truncated, ms: Date.now() - started })
  return { documentId: loaded.documentId, kind, account, filename, rows: result.rows.length, columns: result.columns.length, truncated: result.truncated, statementId: result.statementId, bytes: buffer.length }
}
