import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { fetchPublicUrl } from '@/lib/net/ssrf'
import { readResponseBytesLimited } from '@/lib/net/response-body'
import { applyHttpCredential, resolveHttpCredential, type ResolvedHttpCredential } from '@/features/flows/http-auth'
import { DATASET_MAX_BYTES, readStoredFile } from '@/lib/files/storage'
import { isRoiSourceKind, loadRoiSource, ROI_SOURCE_KINDS, type RoiSourceKind } from './sources'
import { missingRequiredColumns, ROI_EXTRACT_CONTRACT } from './source-kinds'
import { rowsToCsv } from './databricks'

/**
 * One extract for an account, from wherever a flow got it, loaded into the
 * Repository tagged for the ROI page — the generic counterpart of the
 * Databricks pull. A flow step hands it ONE of:
 *
 *   url           a CSV/TSV the platform fetches itself (SSRF-guarded, up to
 *                 the dataset limit; the workspace's saved HTTP credential for
 *                 that host is applied when there is one) — the path for files
 *                 of any size: a signed S3/GCS link, a warehouse export, an
 *                 n8n/webhook-served file;
 *   storedFileId  a file already in the workspace's storage (a flow's file
 *                 step, an upload);
 *   csv           the file's text, inline;
 *   rows          JSON objects, one per row (the header is the union of keys).
 *
 * Inline text and rows pass through the canvas, whose step outputs are capped
 * at about a megabyte, so they suit small extracts; everything else goes by
 * url or storedFileId. The result is the same tag loadRoiSource writes:
 * `sourceMetadata.roi = { account, kind, loadedAt }`, which is all the ROI
 * page reads. It also says which of the extract's required columns the header
 * lacks, so a flow author sees a renamed column at load time, not as an empty
 * report section later.
 */

export class RoiExtractLoadError extends Error {}

const FETCH_TIMEOUT_MS = 5 * 60_000

export type LoadRoiExtractParams = {
  organizationId: string
  userId: string
  account: string
  kind: string
  filename?: string
  url?: string
  storedFileId?: string
  csv?: string
  rows?: unknown
  /** Test seams. */
  fetchImpl?: typeof fetch
  credentialFor?: (host: string) => Promise<ResolvedHttpCredential | null>
  load?: typeof loadRoiSource
  readStored?: typeof readStoredFile
}

export type LoadRoiExtractResult = {
  documentId: string
  account: string
  kind: RoiSourceKind
  filename: string
  rows: number
  columns: string[]
  /** Required columns the prep will not find under the names it knows. */
  missingColumns: string[]
  bytes: number
  source: 'url' | 'storedFile' | 'csv' | 'rows'
}

/** The header of a CSV/TSV: the first line, unquoted; the delimiter is a tab when the line has one and no comma before it. */
export function headerOf(text: string): string[] {
  const line = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? ''
  const delimiter = line.includes('\t') && (!line.includes(',') || line.indexOf('\t') < line.indexOf(',')) ? '\t' : ','
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1 } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) { cells.push(cell); cell = '' }
    else cell += ch
  }
  cells.push(cell)
  return cells.map((name) => name.trim()).filter((name, index, all) => name || index < all.length - 1)
}

/** Rows as JSON objects → CSV text; the header is every key in first-seen order. */
export function objectsToCsv(rows: unknown): string {
  if (!Array.isArray(rows) || !rows.length) throw new RoiExtractLoadError('rows must be a non-empty array of objects.')
  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new RoiExtractLoadError('Every row must be an object keyed by column name.')
    for (const key of Object.keys(row as object)) if (!seen.has(key)) { seen.add(key); columns.push(key) }
  }
  return rowsToCsv(columns, (rows as Array<Record<string, unknown>>).map((row) => columns.map((column) => row[column])))
}

function countRows(text: string): number {
  let count = 0
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') quoted = !quoted
    else if (ch === '\n' && !quoted) count += 1
  }
  if (text.length && !text.endsWith('\n')) count += 1
  return Math.max(0, count - 1)
}

function cleanFilename(name: string | undefined, account: string, kind: RoiSourceKind, fallbackExt: string): string {
  const base = (name?.trim() || `${account.replace(/[^\w.-]+/g, '_')}_${kind}${fallbackExt}`).replace(/[/\\]/g, '_').replace(/[\r\n]/g, ' ').slice(0, 200)
  return /\.(csv|tsv)$/i.test(base) ? base : `${base}.csv`
}

/** The workspace's saved HTTP credential for a host, or null: a signed link needs none, a warehouse export endpoint usually does. */
async function savedCredentialFor(organizationId: string, userId: string, host: string): Promise<ResolvedHttpCredential | null> {
  const row = await prisma.httpCredential.findFirst({ where: { organizationId, allowedHost: host, status: { in: ['verified', 'error'] } }, select: { id: true } })
  return row ? resolveHttpCredential(row.id, organizationId, { actorUserId: userId || null, consumer: 'roi.load_extract' }) : null
}

async function fetchExtract(url: string, organizationId: string, userId: string, seams: Pick<LoadRoiExtractParams, 'fetchImpl' | 'credentialFor'>): Promise<{ buffer: Buffer; filename: string | null }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RoiExtractLoadError(`"${url.slice(0, 120)}" is not a URL.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new RoiExtractLoadError('The url must start with https:// (or http://).')
  let request: { url: string; init: RequestInit } = { url, init: { method: 'GET', headers: { accept: 'text/csv, text/tab-separated-values, text/plain, */*' } } }
  const credential = await (seams.credentialFor ?? ((host: string) => savedCredentialFor(organizationId, userId, host)))(parsed.hostname.toLowerCase())
  if (credential) request = await applyHttpCredential(request, credential)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetchPublicUrl(request.url, { ...request.init, signal: controller.signal }, { ...(seams.fetchImpl ? { fetchImpl: seams.fetchImpl } : {}) })
    if (!response.ok) throw new RoiExtractLoadError(`Fetching the extract failed (HTTP ${response.status})${credential ? '' : parsed.pathname.length > 1 && (response.status === 401 || response.status === 403) ? ` — save an HTTP credential for ${parsed.hostname} in Integrations if the link needs one` : ''}.`)
    const bytes = await readResponseBytesLimited(response, DATASET_MAX_BYTES, 'The extract')
    const disposition = response.headers.get('content-disposition') ?? ''
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1]
    const fromPath = decodeURIComponent(parsed.pathname.split('/').pop() ?? '')
    return { buffer: Buffer.from(bytes), filename: named?.trim() || (/\.(csv|tsv)$/i.test(fromPath) ? fromPath : null) }
  } catch (error) {
    if (error instanceof RoiExtractLoadError) throw error
    throw new RoiExtractLoadError(`Fetching the extract failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Load one extract for an account from a url, a stored file, CSV text or rows. Throws on any failure: a flow step must fail when nothing was loaded. */
export async function loadRoiExtract(params: LoadRoiExtractParams): Promise<LoadRoiExtractResult> {
  const account = params.account.trim()
  if (!account) throw new RoiExtractLoadError('Pass the account the extract belongs to, as the ROI page names it.')
  if (account.length > 200) throw new RoiExtractLoadError('Account names can be at most 200 characters.')
  if (!isRoiSourceKind(params.kind)) throw new RoiExtractLoadError(`"${params.kind}" is not an extract kind (one of ${ROI_SOURCE_KINDS.join(', ')}).`)
  const kind: RoiSourceKind = params.kind
  const given = [params.url, params.storedFileId, params.csv, params.rows].filter((value) => value !== undefined && value !== null && value !== '').length
  if (given !== 1) throw new RoiExtractLoadError('Pass exactly one of url, storedFileId, csv or rows.')

  let buffer: Buffer
  let filename: string
  let source: LoadRoiExtractResult['source']
  if (params.url) {
    const fetched = await fetchExtract(params.url.trim(), params.organizationId, params.userId, params)
    buffer = fetched.buffer
    filename = cleanFilename(params.filename || fetched.filename || undefined, account, kind, '.csv')
    source = 'url'
  } else if (params.storedFileId) {
    const stored = await (params.readStored ?? readStoredFile)(params.storedFileId.trim(), params.organizationId)
    if (!stored) throw new RoiExtractLoadError(`No ready file with id ${params.storedFileId} in this workspace.`)
    buffer = stored.buffer
    filename = cleanFilename(params.filename || stored.filename, account, kind, '.csv')
    source = 'storedFile'
  } else if (typeof params.csv === 'string') {
    buffer = Buffer.from(params.csv, 'utf8')
    filename = cleanFilename(params.filename, account, kind, '.csv')
    source = 'csv'
  } else {
    buffer = Buffer.from(objectsToCsv(params.rows), 'utf8')
    filename = cleanFilename(params.filename, account, kind, '.csv')
    source = 'rows'
  }
  if (!buffer.length) throw new RoiExtractLoadError('The extract is empty.')
  if (buffer.length > DATASET_MAX_BYTES) throw new RoiExtractLoadError(`The ${kind} extract is ${(buffer.length / 1e6).toFixed(0)} MB, over the ${DATASET_MAX_BYTES / 1e6} MB dataset limit.`)
  const head = buffer.subarray(0, 1_000_000).toString('utf8')
  if (/^\s*[<{[]/.test(head)) throw new RoiExtractLoadError('The extract is not a CSV or TSV file (it starts like HTML or JSON). Pass rows for JSON, or a link to the exported file.')
  const columns = headerOf(head)
  if (columns.length < 2) throw new RoiExtractLoadError('The extract has fewer than two columns; check that it is a CSV or TSV with a header row.')
  const rows = countRows(buffer.toString('utf8'))
  if (!rows) throw new RoiExtractLoadError('The extract has a header but no rows.')
  const missingColumns = missingRequiredColumns(kind, columns)
  const loaded = await (params.load ?? loadRoiSource)({ organizationId: params.organizationId, userId: params.userId || null, account, kind, filename, buffer, trusted: true })
  apiLogger.info('roi load extract: extract loaded', { organizationId: params.organizationId, account, kind, source, rows, bytes: buffer.length, missingColumns })
  return { documentId: loaded.documentId, account, kind, filename, rows: loaded.rows ?? rows, columns, missingColumns, bytes: buffer.length, source }
}

/** The contract line a tool result or a flow note shows for a kind. */
export function contractLine(kind: RoiSourceKind): string {
  const contract = ROI_EXTRACT_CONTRACT[kind]
  return `${contract.grain} Required: ${contract.required.join(', ')}.`
}
