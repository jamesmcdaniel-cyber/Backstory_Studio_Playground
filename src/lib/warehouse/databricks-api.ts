import { parseJson, type DatabricksRequest } from './databricks'
import { defaultSleep, type WarehouseRequestInit } from './http'

/**
 * The rest of Databricks' workspace REST API — everything n8n's Databricks
 * node does besides SQL — as pure functions over the injected, credentialed
 * request (see ./http: SSRF-guarded, host-pinned, time- and size-bounded):
 *
 *   Files           /api/2.0/fs/files/Volumes/…, /api/2.0/fs/directories/Volumes/…
 *   Genie           /api/2.0/genie/spaces/{space}/start-conversation, …/conversations/{c}/messages/{m}
 *   Model Serving   /serving-endpoints/{name}/invocations, /api/2.0/serving-endpoints
 *   Unity Catalog   /api/2.1/unity-catalog/{catalogs|schemas|tables|volumes|functions}
 *   Vector Search   /api/2.0/vector-search/{indexes|endpoints}
 *
 * Every caller-supplied name lands in a URL path, so each one goes through
 * `segment`: dot segments ('.', '..', and their percent-encoded forms, which
 * the URL parser also collapses) are refused and everything else is
 * percent-encoded — a crafted file path must not walk the credential over to
 * another API on the same host.
 */

// A plain Error subclass: extending DatabricksStatementError here would read
// that class while ./databricks may still be initialising (the tool planes
// sit on an import cycle through http-auth), which throws at load time.
export class DatabricksApiError extends Error {}

type Json = Record<string, unknown>

// ── shared plumbing ───────────────────────────────────────────────────────────

/** One URL path segment from a caller-supplied value: never a dot segment, always encoded. */
export function segment(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  if (!text) throw new DatabricksApiError(`Pass the ${what}.`)
  let decoded = text
  try {
    decoded = decodeURIComponent(text)
  } catch { /* not percent-encoded — judged as typed */ }
  if (decoded === '.' || decoded === '..' || /[\u0000-\u001f\u007f/\\]/.test(decoded)) {
    throw new DatabricksApiError(`"${text.slice(0, 80)}" is not a valid ${what}.`)
  }
  return encodeURIComponent(text)
}

function query(params: Record<string, string | number | boolean | undefined | null | Array<string | number>>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) for (const entry of value) search.append(key, String(entry))
    else search.append(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function apiFailure(response: { status: number; text: string }, what: string): DatabricksApiError {
  let detail = response.text.slice(0, 300)
  try {
    const parsed = JSON.parse(response.text) as { message?: string; error_code?: string }
    if (parsed.message) detail = `${parsed.error_code ? `${parsed.error_code}: ` : ''}${parsed.message}`
  } catch { /* plain text stays as read */ }
  if (!detail) detail = 'no detail'
  if (response.status === 401 || response.status === 403) detail = `${detail} — check the saved HTTP credential for this host (its token or service principal needs access to this resource; see the permissions in docs/warehouse-connectors.md).`
  return new DatabricksApiError(`${what} failed (HTTP ${response.status}): ${detail}`)
}

async function call<T = Json>(request: DatabricksRequest, path: string, init: WarehouseRequestInit, what: string): Promise<T> {
  const response = await request(path, init)
  if (!response.ok) throw apiFailure(response, what)
  if (!response.text.trim()) return {} as T
  return parseJson<T>(response.text, what)
}

/** A list/object of rows in Databricks' JSON_ARRAY shape → records, capped. */
function records(columns: string[], rows: unknown[][], maxRows: number): { rows: Json[]; rowCount: number; truncated: boolean } {
  const kept = rows.slice(0, maxRows)
  return {
    rows: kept.map((row) => Object.fromEntries(columns.map((column, index) => [column, Array.isArray(row) ? row[index] ?? null : null]))),
    rowCount: rows.length,
    truncated: rows.length > maxRows,
  }
}

// ── Files (Unity Catalog volumes) ─────────────────────────────────────────────

export type VolumeTarget = { catalog: string; schema: string; volume: string; rest: string[] }

/**
 * Where a Files call points: n8n's `volumePath` (catalog.schema.volume) plus a
 * path inside it, or a full `/Volumes/catalog/schema/volume/…` path.
 */
export function volumeTarget(args: { volumePath?: string; path?: string; inner?: string }, what: 'file' | 'directory'): VolumeTarget {
  const full = (args.path ?? '').trim()
  if (full) {
    const parts = full.replace(/^\/+/, '').split('/').filter(Boolean)
    if (parts[0]?.toLowerCase() !== 'volumes' || parts.length < 4) {
      throw new DatabricksApiError(`"${full.slice(0, 120)}" is not a volume path — expected /Volumes/<catalog>/<schema>/<volume>/…`)
    }
    return { catalog: parts[1], schema: parts[2], volume: parts[3], rest: parts.slice(4) }
  }
  const volumeParts = (args.volumePath ?? '').trim().replace(/^\/?volumes\//i, '').split(/[./]/).filter(Boolean)
  if (volumeParts.length !== 3) {
    throw new DatabricksApiError('Volume path must be catalog.schema.volume (e.g. main.default.my_volume), or pass a full /Volumes/… path.')
  }
  const rest = (args.inner ?? '').split('/').filter(Boolean)
  if (what === 'file' && !rest.length) throw new DatabricksApiError('Pass the file path inside the volume (e.g. folder/file.csv).')
  return { catalog: volumeParts[0], schema: volumeParts[1], volume: volumeParts[2], rest }
}

function volumeUrl(api: 'files' | 'directories', target: VolumeTarget): string {
  const parts = [target.catalog, target.schema, target.volume].map((part, index) => segment(part, ['catalog', 'schema', 'volume'][index]))
  const rest = target.rest.map((part) => segment(part, 'path segment'))
  return `/api/2.0/fs/${api}/Volumes/${[...parts, ...rest].join('/')}`
}

export function volumeDisplayPath(target: VolumeTarget): string {
  return `/Volumes/${[target.catalog, target.schema, target.volume, ...target.rest].join('/')}`
}

/** A file's content type from its name, when the volume answered with none (or octet-stream). */
export function guessContentType(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop() ?? ''
  const known: Record<string, string> = {
    csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    jsonl: 'application/x-ndjson', xml: 'application/xml', html: 'text/html', yaml: 'application/yaml', yml: 'application/yaml',
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
    parquet: 'application/vnd.apache.parquet', zip: 'application/zip', gz: 'application/gzip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return known[extension] ?? 'application/octet-stream'
}

export async function uploadVolumeFile(request: DatabricksRequest, target: VolumeTarget, bytes: Uint8Array, options: { contentType?: string; overwrite?: boolean }): Promise<void> {
  await call(request, `${volumeUrl('files', target)}${query({ overwrite: options.overwrite ? 'true' : 'false' })}`, {
    method: 'PUT',
    body: bytes,
    contentType: options.contentType || 'application/octet-stream',
  }, 'Uploading the file')
}

export type DownloadedVolumeFile = { bytes: Uint8Array; fileName: string; contentType: string }

/** Download a file, refusing (while it streams) one larger than `maxBytes`. */
export async function downloadVolumeFile(request: DatabricksRequest, target: VolumeTarget, maxBytes: number): Promise<DownloadedVolumeFile> {
  const response = await request(volumeUrl('files', target), { method: 'GET', binary: true, maxBytes })
  if (!response.ok) throw apiFailure(response, 'Downloading the file')
  const fileName = target.rest[target.rest.length - 1] || 'downloaded-file'
  const declared = (response.headers?.['content-type'] ?? '').split(';')[0].trim()
  const contentType = declared && declared !== 'application/octet-stream' ? declared : guessContentType(fileName)
  return { bytes: response.bytes ?? new Uint8Array(), fileName, contentType }
}

export async function deleteVolumeFile(request: DatabricksRequest, target: VolumeTarget): Promise<void> {
  await call(request, volumeUrl('files', target), { method: 'DELETE' }, 'Deleting the file')
}

export async function volumeFileMetadata(request: DatabricksRequest, target: VolumeTarget): Promise<Json> {
  const response = await request(volumeUrl('files', target), { method: 'HEAD' })
  if (!response.ok) throw apiFailure(response, 'Reading the file metadata')
  const headers = response.headers ?? {}
  const length = Number(headers['content-length'])
  return {
    path: volumeDisplayPath(target),
    contentLength: Number.isFinite(length) ? length : null,
    contentType: headers['content-type'] ?? null,
    lastModified: headers['last-modified'] ?? null,
  }
}

export async function listVolumeDirectory(request: DatabricksRequest, target: VolumeTarget, options: { pageSize?: number; pageToken?: string }): Promise<Json> {
  return call(request, `${volumeUrl('directories', target)}${query({ page_size: options.pageSize, page_token: options.pageToken })}`, { method: 'GET' }, 'Listing the directory')
}

export async function createVolumeDirectory(request: DatabricksRequest, target: VolumeTarget): Promise<void> {
  await call(request, volumeUrl('directories', target), { method: 'PUT' }, 'Creating the directory')
}

export async function deleteVolumeDirectory(request: DatabricksRequest, target: VolumeTarget): Promise<void> {
  await call(request, volumeUrl('directories', target), { method: 'DELETE' }, 'Deleting the directory')
}

// ── Genie ─────────────────────────────────────────────────────────────────────

export const DEFAULT_GENIE_DEADLINE_MS = 10 * 60_000
const GENIE_POLL_MS = 3_000
/** Message states after which Genie never changes the message again. */
const GENIE_TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'QUERY_RESULT_EXPIRED'])

type GenieAttachment = { attachment_id?: string; id?: string; text?: { content?: string }; query?: { query?: string; description?: string; title?: string; statement_id?: string } }
type GenieMessage = {
  id?: string
  message_id?: string
  conversation_id?: string
  space_id?: string
  status?: string
  content?: string
  attachments?: GenieAttachment[]
  error?: { error?: string; type?: string }
}

const genieBase = (spaceId: string) => `/api/2.0/genie/spaces/${segment(spaceId, 'Genie space id')}`

/** Records from a Genie query result (an embedded SQL statement response). */
export function genieResultRecords(response: Json, maxRows: number): { columns: string[]; rows: Json[]; rowCount: number; truncated: boolean } {
  const statement = (response.statement_response ?? response) as {
    manifest?: { schema?: { columns?: Array<{ name?: string }> }; truncated?: boolean; total_chunk_count?: number }
    result?: { data_array?: unknown[][] }
  }
  const columns = (statement.manifest?.schema?.columns ?? []).map((column) => column.name ?? '')
  const shaped = records(columns, statement.result?.data_array ?? [], maxRows)
  return { columns, ...shaped, truncated: shaped.truncated || statement.manifest?.truncated === true || (statement.manifest?.total_chunk_count ?? 1) > 1 }
}

export async function getGenieSpace(request: DatabricksRequest, spaceId: string): Promise<Json> {
  return call(request, genieBase(spaceId), { method: 'GET' }, 'Reading the Genie space')
}

export async function getGenieMessage(request: DatabricksRequest, ids: { spaceId: string; conversationId: string; messageId: string }): Promise<Json> {
  return call(request, `${genieBase(ids.spaceId)}/conversations/${segment(ids.conversationId, 'conversation id')}/messages/${segment(ids.messageId, 'message id')}`, { method: 'GET' }, 'Reading the Genie message')
}

type AttachmentIds = { spaceId: string; conversationId: string; messageId: string; attachmentId: string }
const attachmentBase = (ids: AttachmentIds) =>
  `${genieBase(ids.spaceId)}/conversations/${segment(ids.conversationId, 'conversation id')}/messages/${segment(ids.messageId, 'message id')}/attachments/${segment(ids.attachmentId, 'attachment id')}`

export async function getGenieQueryResult(request: DatabricksRequest, ids: AttachmentIds): Promise<Json> {
  return call(request, `${attachmentBase(ids)}/query-result`, { method: 'GET' }, 'Reading the Genie query result')
}

export async function executeGenieQuery(request: DatabricksRequest, ids: AttachmentIds): Promise<Json> {
  return call(request, `${attachmentBase(ids)}/execute-query`, { method: 'POST', body: '{}' }, 'Running the Genie query')
}

export type GenieAnswer = {
  conversation_id: string
  message_id: string
  conversationId: string
  messageId: string
  status: string
  /** Genie's prose answer (its text attachments, joined). */
  text?: string
  /** The SQL Genie wrote, when it answered with a query. */
  sql?: string
  queryDescription?: string
  attachmentId?: string
  /** The query's rows as records, when it answered with a query and results were asked for. */
  result?: { columns: string[]; rows: Json[]; rowCount: number; truncated: boolean }
  attachments: GenieAttachment[]
  message: GenieMessage
}

/**
 * Ask a Genie space a question — a new conversation, or a follow-up in
 * `conversationId` — and (by default) poll the message until Genie is done.
 * A FAILED / CANCELLED / expired answer throws with Genie's own reason; a
 * completed answer with a query also fetches its rows (bounded by maxRows).
 */
export async function askGenie(params: {
  request: DatabricksRequest
  spaceId: string
  question: string
  conversationId?: string
  waitForCompletion?: boolean
  includeResults?: boolean
  maxRows: number
  deadlineMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<GenieAnswer> {
  const sleep = params.sleep ?? defaultSleep
  const now = params.now ?? Date.now
  const deadlineMs = params.deadlineMs ?? DEFAULT_GENIE_DEADLINE_MS
  const deadline = now() + deadlineMs
  const question = params.question.trim()
  if (!question) throw new DatabricksApiError('Pass the question to ask Genie.')
  const base = genieBase(params.spaceId)
  const started = params.conversationId
    ? await call<GenieMessage>(params.request, `${base}/conversations/${segment(params.conversationId, 'conversation id')}/messages`, { method: 'POST', body: JSON.stringify({ content: question }) }, 'Asking Genie')
    : await call<{ conversation_id?: string; message_id?: string; message?: GenieMessage }>(params.request, `${base}/start-conversation`, { method: 'POST', body: JSON.stringify({ content: question }) }, 'Asking Genie')
  const startedMessage: GenieMessage = 'message' in started && started.message ? started.message : started as GenieMessage
  const conversationId = (started as { conversation_id?: string }).conversation_id ?? startedMessage.conversation_id ?? params.conversationId ?? ''
  const messageId = (started as { message_id?: string }).message_id ?? startedMessage.message_id ?? startedMessage.id ?? ''
  if (!conversationId || !messageId) throw new DatabricksApiError('Genie accepted the question but returned no conversation or message id.')

  let message = startedMessage
  const answer = (): GenieAnswer => {
    const attachments = message.attachments ?? []
    const text = attachments.map((attachment) => attachment.text?.content?.trim()).filter(Boolean).join('\n\n')
    const queryAttachment = attachments.find((attachment) => attachment.query?.query)
    return {
      conversation_id: conversationId,
      message_id: messageId,
      conversationId,
      messageId,
      status: message.status ?? 'SUBMITTED',
      ...(text ? { text } : {}),
      ...(queryAttachment?.query?.query ? { sql: queryAttachment.query.query } : {}),
      ...(queryAttachment?.query?.description ? { queryDescription: queryAttachment.query.description } : {}),
      ...(queryAttachment ? { attachmentId: queryAttachment.attachment_id ?? queryAttachment.id } : {}),
      attachments,
      message,
    }
  }
  if (params.waitForCompletion === false) return answer()

  for (;;) {
    const status = message.status ?? 'SUBMITTED'
    if (GENIE_TERMINAL.has(status)) break
    if (now() >= deadline) {
      throw new DatabricksApiError(`Genie was still ${status.toLowerCase().replace(/_/g, ' ')} after ${Math.round(deadlineMs / 60_000)} minutes (conversation ${conversationId}, message ${messageId}) — read it later with databricks_genie_get_message, or raise timeoutMinutes.`)
    }
    await sleep(GENIE_POLL_MS)
    message = await getGenieMessage(params.request, { spaceId: params.spaceId, conversationId, messageId }) as GenieMessage
  }
  if (message.status !== 'COMPLETED') {
    const reason = message.error?.error || message.error?.type
    throw new DatabricksApiError(`Genie's answer ${String(message.status).toLowerCase().replace(/_/g, ' ')}${reason ? `: ${reason.slice(0, 500)}` : '.'} (conversation ${conversationId}, message ${messageId})`)
  }
  const done = answer()
  if (params.includeResults !== false && done.attachmentId) {
    const result = await getGenieQueryResult(params.request, { spaceId: params.spaceId, conversationId, messageId, attachmentId: done.attachmentId })
    done.result = genieResultRecords(result, params.maxRows)
  }
  return done
}

// ── Model Serving ─────────────────────────────────────────────────────────────

const endpointName = (name: unknown) => {
  const text = typeof name === 'string' ? name.trim() : ''
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(text)) throw new DatabricksApiError(`"${text.slice(0, 80)}" is not a serving endpoint name (letters, digits, - and _).`)
  return text
}

export async function queryServingEndpoint(request: DatabricksRequest, name: string, body: Json): Promise<Json> {
  const endpoint = endpointName(name)
  const response = await call<unknown>(request, `/serving-endpoints/${endpoint}/invocations`, { method: 'POST', body: JSON.stringify(body) }, `Querying serving endpoint ${endpoint}`)
  const shaped = response && typeof response === 'object' && !Array.isArray(response) ? response as Json : { result: response }
  return { ...shaped, _metadata: { endpoint } }
}

export async function listServingEndpoints(request: DatabricksRequest): Promise<Json> {
  return call(request, '/api/2.0/serving-endpoints', { method: 'GET' }, 'Listing serving endpoints')
}

export async function getServingEndpoint(request: DatabricksRequest, name: string): Promise<Json> {
  return call(request, `/api/2.0/serving-endpoints/${endpointName(name)}`, { method: 'GET' }, 'Reading the serving endpoint')
}

// ── Unity Catalog ─────────────────────────────────────────────────────────────

export type UnityObjectType = 'catalog' | 'schema' | 'table' | 'volume' | 'function'
export const UNITY_OBJECT_TYPES: readonly UnityObjectType[] = ['catalog', 'schema', 'table', 'volume', 'function']
const UNITY_COLLECTION: Record<UnityObjectType, string> = { catalog: 'catalogs', schema: 'schemas', table: 'tables', volume: 'volumes', function: 'functions' }
const UC = '/api/2.1/unity-catalog'

export type UnityRef = { catalog?: string; schema?: string; name?: string; fullName?: string }

export function unityObjectType(value: unknown): UnityObjectType {
  const text = typeof value === 'string' ? value.trim().toLowerCase().replace(/s$/, '') : ''
  if ((UNITY_OBJECT_TYPES as readonly string[]).includes(text)) return text as UnityObjectType
  throw new DatabricksApiError(`objectType must be one of ${UNITY_OBJECT_TYPES.join(', ')}.`)
}

/** "catalog.schema" given as the schema (n8n's hint says "full schema name") splits into both. */
function splitSchema(ref: UnityRef): { catalog?: string; schema?: string } {
  const schema = ref.schema?.trim()
  if (schema && schema.includes('.') && !schema.startsWith('`')) {
    const [catalog, bare] = schema.split('.', 2)
    return { catalog: ref.catalog?.trim() || catalog, schema: bare }
  }
  return { catalog: ref.catalog?.trim() || undefined, schema: schema || undefined }
}

/** The object's full name: catalog | catalog.schema | catalog.schema.name. */
export function unityFullName(type: UnityObjectType, ref: UnityRef): string {
  if (ref.fullName?.trim()) return ref.fullName.trim()
  if (type === 'catalog') {
    const name = ref.name?.trim() || ref.catalog?.trim()
    if (!name) throw new DatabricksApiError('Pass the catalog name.')
    return name
  }
  const { catalog, schema } = splitSchema(ref)
  if (type === 'schema') {
    const name = ref.name?.trim() || schema
    if (!catalog || !name) throw new DatabricksApiError('Pass the catalog and schema (or fullName catalog.schema).')
    return `${catalog}.${name}`
  }
  if (!catalog || !schema || !ref.name?.trim()) throw new DatabricksApiError(`Pass catalog, schema and name for the ${type} (or fullName catalog.schema.${type}).`)
  return `${catalog}.${schema}.${ref.name.trim()}`
}

export async function unityList(request: DatabricksRequest, type: UnityObjectType, ref: UnityRef & { maxResults?: number; pageToken?: string }): Promise<Json> {
  const { catalog, schema } = splitSchema(ref)
  if (type !== 'catalog' && !catalog) throw new DatabricksApiError(`Listing ${UNITY_COLLECTION[type]} needs the catalog.`)
  if ((type === 'table' || type === 'volume' || type === 'function') && !schema) throw new DatabricksApiError(`Listing ${UNITY_COLLECTION[type]} needs the catalog and the schema.`)
  return call(request, `${UC}/${UNITY_COLLECTION[type]}${query({
    ...(type !== 'catalog' ? { catalog_name: catalog } : {}),
    ...(type === 'table' || type === 'volume' || type === 'function' ? { schema_name: schema } : {}),
    max_results: ref.maxResults,
    page_token: ref.pageToken,
  })}`, { method: 'GET' }, `Listing ${UNITY_COLLECTION[type]}`)
}

export async function unityGet(request: DatabricksRequest, type: UnityObjectType, ref: UnityRef): Promise<Json> {
  return call(request, `${UC}/${UNITY_COLLECTION[type]}/${segment(unityFullName(type, ref), `${type} name`)}`, { method: 'GET' }, `Reading the ${type}`)
}

export async function unityDelete(request: DatabricksRequest, type: UnityObjectType, ref: UnityRef & { force?: boolean }): Promise<Json> {
  const fullName = unityFullName(type, ref)
  await call(request, `${UC}/${UNITY_COLLECTION[type]}/${segment(fullName, `${type} name`)}${query({ force: ref.force && (type === 'catalog' || type === 'schema') ? 'true' : undefined })}`, { method: 'DELETE' }, `Deleting the ${type}`)
  return { success: true, objectType: type, fullName }
}

export async function unityUpdate(request: DatabricksRequest, type: UnityObjectType, ref: UnityRef & { comment?: string; owner?: string; newName?: string }): Promise<Json> {
  if (type !== 'catalog' && type !== 'schema') throw new DatabricksApiError('Updating is supported for catalogs and schemas (comment, owner, new name).')
  const body: Json = {
    ...(ref.comment !== undefined ? { comment: ref.comment } : {}),
    ...(ref.owner ? { owner: ref.owner } : {}),
    ...(ref.newName ? { new_name: ref.newName } : {}),
  }
  if (!Object.keys(body).length) throw new DatabricksApiError('Pass what to change: comment, owner or newName.')
  return call(request, `${UC}/${UNITY_COLLECTION[type]}/${segment(unityFullName(type, ref), `${type} name`)}`, { method: 'PATCH', body: JSON.stringify(body) }, `Updating the ${type}`)
}

export type UnityCreate = UnityRef & {
  comment?: string
  storageLocation?: string
  volumeType?: string
  columns?: unknown
  inputParams?: unknown
  returnType?: string
  routineBody?: string
  routineDefinition?: string
}

/** The create body for each object type — the same shapes n8n's node sends. */
export function unityCreateBody(type: UnityObjectType, spec: UnityCreate): Json {
  const name = spec.name?.trim()
  const { catalog, schema } = splitSchema(spec)
  const comment = spec.comment?.trim()
  if (type === 'catalog') {
    const catalogName = name || catalog
    if (!catalogName) throw new DatabricksApiError('Pass the catalog name.')
    return { name: catalogName, ...(comment ? { comment } : {}) }
  }
  if (!catalog) throw new DatabricksApiError(`Creating a ${type} needs the catalog.`)
  if (type === 'schema') {
    const schemaName = name || schema
    if (!schemaName) throw new DatabricksApiError('Pass the schema name.')
    return { name: schemaName, catalog_name: catalog, ...(comment ? { comment } : {}) }
  }
  if (!schema || !name) throw new DatabricksApiError(`Creating a ${type} needs the catalog, the schema and its name.`)
  if (type === 'table') {
    if (!spec.storageLocation?.trim()) throw new DatabricksApiError('Creating a table needs storageLocation — the Unity Catalog API registers external Delta tables only (use databricks_sql_query with CREATE TABLE for a managed one).')
    return {
      catalog_name: catalog,
      schema_name: schema,
      name,
      table_type: 'EXTERNAL',
      data_source_format: 'DELTA',
      storage_location: spec.storageLocation.trim(),
      ...(Array.isArray(spec.columns) && spec.columns.length ? { columns: spec.columns } : {}),
      ...(comment ? { comment } : {}),
    }
  }
  if (type === 'volume') {
    const volumeType = (spec.volumeType?.trim() || 'MANAGED').toUpperCase()
    if (volumeType !== 'MANAGED' && volumeType !== 'EXTERNAL') throw new DatabricksApiError('volumeType must be MANAGED or EXTERNAL.')
    if (volumeType === 'EXTERNAL' && !spec.storageLocation?.trim()) throw new DatabricksApiError('An EXTERNAL volume needs storageLocation.')
    return {
      catalog_name: catalog,
      schema_name: schema,
      name,
      volume_type: volumeType,
      ...(spec.storageLocation?.trim() ? { storage_location: spec.storageLocation.trim() } : {}),
      ...(comment ? { comment } : {}),
    }
  }
  // function
  if (!spec.routineDefinition?.trim()) throw new DatabricksApiError('Creating a function needs routineDefinition (its body, e.g. RETURN x + 1).')
  const raw = Array.isArray(spec.inputParams) ? spec.inputParams : (spec.inputParams as { parameters?: unknown[] } | undefined)?.parameters ?? []
  const parameters = (raw as Array<Record<string, unknown>>).map((param) => ({
    ...param,
    type_text: param.type_text ?? param.type_name,
    type_json: param.type_json ?? JSON.stringify({ name: param.type_name }),
  }))
  const returnType = spec.returnType?.trim() || 'STRING'
  return {
    function_info: {
      name,
      catalog_name: catalog,
      schema_name: schema,
      input_params: { parameters },
      data_type: returnType,
      full_data_type: returnType,
      specific_name: name,
      parameter_style: 'S',
      security_type: 'DEFINER',
      sql_data_access: 'CONTAINS_SQL',
      is_deterministic: false,
      is_null_call: true,
      routine_body: spec.routineBody?.trim() || 'SQL',
      routine_definition: spec.routineDefinition,
    },
  }
}

export async function unityCreate(request: DatabricksRequest, type: UnityObjectType, spec: UnityCreate): Promise<Json> {
  return call(request, `${UC}/${UNITY_COLLECTION[type]}`, { method: 'POST', body: JSON.stringify(unityCreateBody(type, spec)) }, `Creating the ${type}`)
}

// ── Vector Search ─────────────────────────────────────────────────────────────

const VS = '/api/2.0/vector-search'

export type VectorQuery = {
  indexName: string
  queryText?: string
  queryVector?: number[]
  columns: string[]
  numResults: number
  searchMode?: string
  filtersJson?: string
  scoreThreshold?: number
  reranker?: { model?: string; columnsToRerank: string[] }
}

export async function vectorSearchQuery(request: DatabricksRequest, spec: VectorQuery, maxRows: number): Promise<Json> {
  if (!spec.columns.length) throw new DatabricksApiError('Pass the columns to return (e.g. ["id", "text"]).')
  if (!spec.queryText?.trim() && !spec.queryVector?.length) throw new DatabricksApiError('Pass queryText or queryVector.')
  const mode = (spec.searchMode?.trim() || 'ANN').toUpperCase()
  if (mode !== 'ANN' && mode !== 'HYBRID') throw new DatabricksApiError('searchMode must be ANN or HYBRID.')
  const body: Json = {
    num_results: spec.numResults,
    query_type: mode,
    columns: spec.columns,
    ...(spec.queryText?.trim() ? { query_text: spec.queryText } : { query_vector: spec.queryVector }),
    ...(spec.filtersJson?.trim() ? { filters_json: spec.filtersJson } : {}),
    ...(spec.scoreThreshold ? { score_threshold: spec.scoreThreshold } : {}),
    ...(spec.reranker ? { reranker: { model: spec.reranker.model || 'databricks_reranker', parameters: { columns_to_rerank: spec.reranker.columnsToRerank } } } : {}),
  }
  const response = await call<{ manifest?: { columns?: Array<{ name?: string }> }; result?: { data_array?: unknown[][] } } & Json>(
    request, `${VS}/indexes/${segment(spec.indexName, 'index name')}/query`, { method: 'POST', body: JSON.stringify(body) }, 'Querying the vector index')
  const columns = (response.manifest?.columns ?? []).map((column) => column.name ?? '')
  return { ...response, columns, ...records(columns, response.result?.data_array ?? [], maxRows) }
}

export async function vectorSearchListIndexes(request: DatabricksRequest, endpoint: string, pageToken?: string): Promise<Json> {
  if (!endpoint.trim()) throw new DatabricksApiError('Pass the vector search endpoint name whose indexes to list.')
  return call(request, `${VS}/indexes${query({ endpoint_name: endpoint.trim(), page_token: pageToken })}`, { method: 'GET' }, 'Listing vector indexes')
}

export async function vectorSearchGetIndex(request: DatabricksRequest, indexName: string): Promise<Json> {
  return call(request, `${VS}/indexes/${segment(indexName, 'index name')}`, { method: 'GET' }, 'Reading the vector index')
}

export async function vectorSearchListEndpoints(request: DatabricksRequest, pageToken?: string): Promise<Json> {
  return call(request, `${VS}/endpoints${query({ page_token: pageToken })}`, { method: 'GET' }, 'Listing vector search endpoints')
}

export async function vectorSearchCreateIndex(request: DatabricksRequest, spec: {
  indexName: string
  endpointName: string
  primaryKey: string
  indexType?: string
  deltaSyncIndexSpec?: unknown
  directAccessIndexSpec?: unknown
}): Promise<Json> {
  const indexType = (spec.indexType?.trim() || 'DELTA_SYNC').toUpperCase()
  if (indexType !== 'DELTA_SYNC' && indexType !== 'DIRECT_ACCESS') throw new DatabricksApiError('indexType must be DELTA_SYNC or DIRECT_ACCESS.')
  if (!spec.indexName.trim() || !spec.endpointName.trim() || !spec.primaryKey.trim()) throw new DatabricksApiError('Creating an index needs indexName, endpointName and primaryKey.')
  const indexSpec = indexType === 'DELTA_SYNC' ? spec.deltaSyncIndexSpec : spec.directAccessIndexSpec
  if (!indexSpec || typeof indexSpec !== 'object') throw new DatabricksApiError(`Creating a ${indexType} index needs ${indexType === 'DELTA_SYNC' ? 'deltaSyncIndexSpec' : 'directAccessIndexSpec'} (an object).`)
  return call(request, `${VS}/indexes`, {
    method: 'POST',
    body: JSON.stringify({
      name: spec.indexName.trim(),
      endpoint_name: spec.endpointName.trim(),
      primary_key: spec.primaryKey.trim(),
      index_type: indexType,
      [indexType === 'DELTA_SYNC' ? 'delta_sync_index_spec' : 'direct_access_index_spec']: indexSpec,
    }),
  }, 'Creating the vector index')
}

/** Upsert rows into a Direct Access index. */
export async function vectorSearchUpsert(request: DatabricksRequest, indexName: string, rows: Json[]): Promise<Json> {
  if (!rows.length) throw new DatabricksApiError('Pass the rows to upsert (a list of objects with the primary key, vector and columns).')
  return call(request, `${VS}/indexes/${segment(indexName, 'index name')}/upsert-data`, { method: 'POST', body: JSON.stringify({ inputs_json: JSON.stringify(rows) }) }, 'Upserting into the vector index')
}

/** Delete rows from a Direct Access index by primary key. */
export async function vectorSearchDeleteData(request: DatabricksRequest, indexName: string, primaryKeys: string[]): Promise<Json> {
  if (!primaryKeys.length) throw new DatabricksApiError('Pass the primary keys of the rows to delete.')
  return call(request, `${VS}/indexes/${segment(indexName, 'index name')}/delete-data${query({ primary_keys: primaryKeys })}`, { method: 'DELETE' }, 'Deleting from the vector index')
}
