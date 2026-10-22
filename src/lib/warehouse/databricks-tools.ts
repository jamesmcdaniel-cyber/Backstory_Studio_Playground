import type { FlowFileReference } from '@/lib/flows/file-ref'
import type { DatabricksRequest } from './databricks'
import {
  DEFAULT_GENIE_DEADLINE_MS,
  askGenie,
  createVolumeDirectory,
  deleteVolumeDirectory,
  deleteVolumeFile,
  downloadVolumeFile,
  executeGenieQuery,
  genieResultRecords,
  getGenieMessage,
  getGenieQueryResult,
  getGenieSpace,
  getServingEndpoint,
  listServingEndpoints,
  listVolumeDirectory,
  queryServingEndpoint,
  unityCreate,
  unityDelete,
  unityGet,
  unityList,
  unityObjectType,
  unityUpdate,
  uploadVolumeFile,
  vectorSearchCreateIndex,
  vectorSearchDeleteData,
  vectorSearchGetIndex,
  vectorSearchListEndpoints,
  vectorSearchListIndexes,
  vectorSearchQuery,
  vectorSearchUpsert,
  volumeDisplayPath,
  volumeFileMetadata,
  volumeTarget,
  DatabricksApiError,
} from './databricks-api'

/**
 * The Databricks workspace-API tools (Files, Genie, Model Serving, Unity
 * Catalog, Vector Search): specs for the catalogue and their execution over a
 * credentialed request. WarehouseToolClient (./tools) resolves the host's
 * credential and hands the request in; read/write classification lives in
 * ./tool-classify.
 *
 * Files never travel as bytes in flow data: a download is saved as a
 * StoredFile and answered as a file reference ({ fileId, filename, mimeType,
 * size, url, content? }); an upload takes such a reference (or plain text).
 */

type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }

const DEFAULT_MAX_ROWS = 10_000
const MAX_ROWS_LIMIT = 100_000
/** Largest text body an upload accepts inline (bigger payloads come in as stored files). */
const MAX_INLINE_UPLOAD_BYTES = 10_000_000

const host = { type: 'string', description: 'The workspace host, e.g. dbc-a1b2c3d4-e5f6.cloud.databricks.com. Optional when this workspace has saved a credential for exactly one Databricks host.' }
const volumePath = { type: 'string', description: 'The volume as catalog.schema.volume (e.g. main.default.landing).' }
const filePath = { type: 'string', description: 'Path of the file inside the volume, e.g. exports/accounts.csv (no leading slash).' }
const directoryPath = { type: 'string', description: 'Path of the directory inside the volume, e.g. exports/2026 (no leading slash).' }
const fullPath = { type: 'string', description: 'Alternatively, the full path /Volumes/<catalog>/<schema>/<volume>/… in place of volumePath + the inner path.' }
const spaceId = { type: 'string', description: 'The Genie space id (from the space URL).' }
const conversationId = { type: 'string', description: 'The Genie conversation id.' }
const messageId = { type: 'string', description: 'The Genie message id.' }
const attachmentId = { type: 'string', description: 'The query attachment id on the message.' }
const maxRows = { type: 'number', description: `Most rows to return as records (default ${DEFAULT_MAX_ROWS.toLocaleString('en-US')}, at most ${MAX_ROWS_LIMIT.toLocaleString('en-US')}).` }
const objectType = { type: 'string', enum: ['catalog', 'schema', 'table', 'volume', 'function'], description: 'Which kind of Unity Catalog object.' }
const ucRef = {
  catalog: { type: 'string', description: 'Catalog name.' },
  schema: { type: 'string', description: 'Schema name (or catalog.schema).' },
  name: { type: 'string', description: 'The object\'s own name (for a catalog, the catalog name).' },
  fullName: { type: 'string', description: 'Alternatively the full name: catalog, catalog.schema or catalog.schema.object.' },
}
const indexName = { type: 'string', description: 'The vector index name, catalog.schema.index.' }

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { ...properties, host }, ...(required.length ? { required } : {}) },
})

export const DATABRICKS_API_TOOLS: ToolSpec[] = [
  // ── Files ──
  tool('databricks_files_upload', 'Upload a file to a Unity Catalog volume. Pass `file` (a file from an earlier step) or `content` (text). Fails when the file exists unless overwrite is true. A write.', {
    volumePath, filePath, path: fullPath,
    file: { description: 'A file from an earlier step (its file reference, or the step output that carries one).' },
    content: { type: 'string', description: 'Text to upload, in place of a file.' },
    contentType: { type: 'string', description: 'Content type to send (defaults to the file\'s own, else application/octet-stream).' },
    overwrite: { type: 'boolean', description: 'Replace an existing file (default false).' },
  }),
  tool('databricks_files_download', 'Download a file from a Unity Catalog volume. Answers a file reference ({ fileId, filename, mimeType, size, url, content? } — content is the text for text-like files) that later steps can read or upload elsewhere.', { volumePath, filePath, path: fullPath }),
  tool('databricks_files_delete', 'Delete a file from a Unity Catalog volume. A write.', { volumePath, filePath, path: fullPath }),
  tool('databricks_files_list', 'List a directory in a Unity Catalog volume ({ contents: [{ path, name, is_directory, file_size, last_modified }], next_page_token }). Leave directoryPath empty for the volume root.', {
    volumePath, directoryPath, path: fullPath,
    pageSize: { type: 'number', description: 'Entries per page (default 1000).' },
    pageToken: { type: 'string', description: 'next_page_token from a previous call.' },
  }),
  tool('databricks_files_mkdir', 'Create a directory (and any missing parents) in a Unity Catalog volume. A write.', { volumePath, directoryPath, path: fullPath }),
  tool('databricks_files_rmdir', 'Delete an empty directory from a Unity Catalog volume. A write.', { volumePath, directoryPath, path: fullPath }),
  tool('databricks_files_get_metadata', 'Read a volume file\'s metadata (size, content type, last modified) without downloading it.', { volumePath, filePath, path: fullPath }),

  // ── Genie ──
  tool('databricks_genie_ask', 'Ask a Databricks Genie space a question in plain English and wait for the answer: { text, sql, result: { rows, columns }, conversation_id, message_id, status }. Pass conversationId to ask a follow-up in the same conversation.', {
    spaceId, question: { type: 'string', description: 'The question.' }, conversationId,
    waitForCompletion: { type: 'boolean', description: 'Wait for Genie to finish (default true). False answers right after the question is accepted.' },
    includeResults: { type: 'boolean', description: 'Fetch the rows when Genie answers with a query (default true).' },
    maxRows,
    timeoutMinutes: { type: 'number', description: 'Give up waiting after this many minutes (default 10, at most 30).' },
  }, ['spaceId', 'question']),
  tool('databricks_genie_get_space', 'Read a Genie space\'s details (title, description, warehouse).', { spaceId }, ['spaceId']),
  tool('databricks_genie_get_message', 'Read a Genie conversation message: its status, text and query attachments.', { spaceId, conversationId, messageId }, ['spaceId', 'conversationId', 'messageId']),
  tool('databricks_genie_get_query_result', 'Read the rows of a Genie message\'s query attachment (the raw statement_response plus rows as records).', { spaceId, conversationId, messageId, attachmentId, maxRows }, ['spaceId', 'conversationId', 'messageId', 'attachmentId']),
  tool('databricks_genie_execute_query', 'Re-run the SQL of a Genie message\'s query attachment (Genie writes read-only queries) and return the fresh rows.', { spaceId, conversationId, messageId, attachmentId, maxRows }, ['spaceId', 'conversationId', 'messageId', 'attachmentId']),

  // ── Model Serving ──
  tool('databricks_serving_query', 'Query a Model Serving endpoint. requestBody is what the endpoint expects: chat ({ messages: [{ role, content }] }), completions ({ prompt }), embeddings ({ input }), or a model\'s dataframe_records / dataframe_split / inputs / instances.', {
    endpointName: { type: 'string', description: 'The serving endpoint name.' },
    requestBody: { type: 'object', description: 'The JSON body to send.' },
  }, ['endpointName', 'requestBody']),
  tool('databricks_serving_list', 'List the workspace\'s Model Serving endpoints.', {}),
  tool('databricks_serving_get', 'Read a Model Serving endpoint\'s configuration and state.', { endpointName: { type: 'string', description: 'The serving endpoint name.' } }, ['endpointName']),

  // ── Unity Catalog ──
  tool('databricks_unity_catalog_list', 'List Unity Catalog catalogs, or the schemas of a catalog, or the tables / volumes / functions of a schema.', {
    objectType, catalog: ucRef.catalog, schema: ucRef.schema,
    maxResults: { type: 'number', description: 'Page size.' },
    pageToken: { type: 'string', description: 'next_page_token from a previous call.' },
  }, ['objectType']),
  tool('databricks_unity_catalog_get', 'Read a Unity Catalog catalog, schema, table (with its columns), volume or function.', { objectType, ...ucRef }, ['objectType']),
  tool('databricks_unity_catalog_create', 'Create a Unity Catalog catalog, schema, external Delta table (storageLocation, columns), volume (volumeType MANAGED/EXTERNAL) or SQL function (inputParams, returnType, routineDefinition). A write.', {
    objectType, ...ucRef,
    comment: { type: 'string' },
    storageLocation: { type: 'string', description: 'Storage URL (external tables and volumes).' },
    volumeType: { type: 'string', enum: ['MANAGED', 'EXTERNAL'] },
    columns: { type: 'array', description: 'Table columns: [{ name, type_name, type_text, position }].', items: { type: 'object' } },
    inputParams: { type: ['array', 'object'], description: 'Function parameters: [{ name, type_name, type_text }] (or { parameters: [...] }).' },
    returnType: { type: 'string', description: 'Function return type (default STRING).' },
    routineBody: { type: 'string', description: 'Function language (default SQL).' },
    routineDefinition: { type: 'string', description: 'Function body, e.g. RETURN x + 1.' },
  }, ['objectType']),
  tool('databricks_unity_catalog_update', 'Update a Unity Catalog catalog or schema: comment, owner or new name. A write.', {
    objectType, ...ucRef,
    comment: { type: 'string' }, owner: { type: 'string' }, newName: { type: 'string' },
  }, ['objectType']),
  tool('databricks_unity_catalog_delete', 'Delete a Unity Catalog catalog, schema, table, volume or function. A write.', {
    objectType, ...ucRef,
    force: { type: 'boolean', description: 'Catalogs and schemas: delete even when not empty.' },
  }, ['objectType']),

  // ── Vector Search ──
  tool('databricks_vector_search_query', 'Search a Databricks Vector Search index by text or by vector; answers the matches as records under rows (each with its score).', {
    indexName,
    queryText: { type: 'string', description: 'Text to search for (embedded by the index\'s model).' },
    queryVector: { type: 'array', items: { type: 'number' }, description: 'A precomputed embedding, in place of queryText.' },
    columns: { type: 'array', items: { type: 'string' }, description: 'Columns to return.' },
    numResults: { type: 'number', description: 'Most matches to return (default 10).' },
    searchMode: { type: 'string', enum: ['ANN', 'HYBRID'], description: 'ANN (vector similarity, default) or HYBRID (vector + keyword).' },
    filtersJson: { type: 'string', description: 'Filter, e.g. {"category": "docs"} (or a SQL-like filter expression for HYBRID/standard endpoints).' },
    scoreThreshold: { type: 'number', description: 'Minimum score, 0–1.' },
    reranker: { type: 'object', description: '{ model?: "databricks_reranker", columnsToRerank: ["text"] }' },
    maxRows,
  }, ['indexName', 'columns']),
  tool('databricks_vector_search_list_indexes', 'List the vector indexes on a Vector Search endpoint.', {
    endpointName: { type: 'string', description: 'The Vector Search endpoint name.' },
    pageToken: { type: 'string' },
  }, ['endpointName']),
  tool('databricks_vector_search_get_index', 'Read a vector index\'s definition and status.', { indexName }, ['indexName']),
  tool('databricks_vector_search_list_endpoints', 'List the workspace\'s Vector Search endpoints.', { pageToken: { type: 'string' } }),
  tool('databricks_vector_search_create_index', 'Create a vector index: DELTA_SYNC (deltaSyncIndexSpec — source_table, embedding columns, pipeline_type) or DIRECT_ACCESS (directAccessIndexSpec — embedding_vector_columns, schema_json). A write.', {
    indexName,
    endpointName: { type: 'string', description: 'The Vector Search endpoint to host it.' },
    primaryKey: { type: 'string' },
    indexType: { type: 'string', enum: ['DELTA_SYNC', 'DIRECT_ACCESS'] },
    deltaSyncIndexSpec: { type: 'object' },
    directAccessIndexSpec: { type: 'object' },
  }, ['indexName', 'endpointName', 'primaryKey']),
  tool('databricks_vector_search_upsert', 'Insert or update rows in a Direct Access vector index (each row has the primary key, its vector and columns). A write.', {
    indexName, rows: { type: 'array', items: { type: 'object' }, description: 'The rows to upsert.' },
  }, ['indexName', 'rows']),
  tool('databricks_vector_search_delete_data', 'Delete rows from a Direct Access vector index by primary key. A write.', {
    indexName, primaryKeys: { type: 'array', items: { type: 'string' } },
  }, ['indexName', 'primaryKeys']),
]

export const DATABRICKS_API_TOOL_NAMES: ReadonlySet<string> = new Set(DATABRICKS_API_TOOLS.map((spec) => spec.name))

// ── file storage seam ─────────────────────────────────────────────────────────

export type DatabricksFileStore = {
  /** Largest file a download may bring in, by name (datasets get the larger ceiling). */
  maxBytes(filename: string): Promise<number>
  save(params: { organizationId: string; userId: string; filename: string; mimeType: string; bytes: Uint8Array }): Promise<FlowFileReference>
  read(fileId: string, organizationId: string): Promise<{ filename: string; mimeType: string; bytes: Uint8Array } | null>
}

/**
 * The live store — the same StoredFile path an HTTP step's file download takes.
 * Loaded lazily (storage pulls in the Supabase client), and swappable in tests.
 */
export const databricksFileStore: DatabricksFileStore = {
  async maxBytes(filename) {
    const { maxBytesForFile } = await import('@/lib/files/storage')
    return maxBytesForFile(filename)
  },
  async save({ organizationId, userId, filename, mimeType, bytes }) {
    const [{ saveStoredFile }, { fileReference }, { extractTextAuto, isSupported }, { truncateWithMarker }] = await Promise.all([
      import('@/lib/files/storage'),
      import('@/lib/flows/file-ref'),
      import('@/lib/knowledge/extract'),
      import('@/lib/flows/truncate'),
    ])
    const buffer = Buffer.from(bytes)
    const saved = await saveStoredFile({ organizationId, userId: userId || null, filename, mimeType, buffer })
    // Like an HTTP download: unreadable text degrades to none rather than failing the step.
    const content = isSupported(saved.mimeType, filename)
      ? truncateWithMarker(await extractTextAuto(buffer, saved.mimeType, filename).catch(() => ''), 200_000)
      : undefined
    return fileReference(saved, { content })
  },
  async read(fileId, organizationId) {
    const { readStoredFile } = await import('@/lib/files/storage')
    const file = await readStoredFile(fileId, organizationId)
    return file ? { filename: file.filename, mimeType: file.mimeType, bytes: new Uint8Array(file.buffer) } : null
  },
}

// ── args ──────────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>

const str = (args: Args, ...keys: string[]): string => {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

const optionalStr = (args: Args, key: string): string | undefined => {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

const bounded = (value: unknown, fallback: number, max: number): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), max) : fallback
}

const flag = (value: unknown, fallback: boolean): boolean =>
  value === undefined || value === null || value === '' ? fallback : value === true || value === 'true'

/** A tool arg given as JSON (object/array) or as JSON text — flow args are templated strings. */
function jsonArg(args: Args, key: string): unknown {
  const value = args[key]
  if (typeof value !== 'string') return value
  if (!value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    throw new DatabricksApiError(`"${key}" must be JSON, not plain text.`)
  }
}

/** A list given as an array, JSON text, or comma-separated text. */
function listArg(args: Args, key: string): string[] {
  const value = args[key]
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) {
    const parsed = jsonArg(args, key)
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry).trim()).filter(Boolean)
  }
  return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function objectArgOf(args: Args, key: string): Record<string, unknown> {
  const value = jsonArg(args, key)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DatabricksApiError(`"${key}" must be a JSON object.`)
  return value as Record<string, unknown>
}

const target = (args: Args, what: 'file' | 'directory') => volumeTarget({
  volumePath: str(args, 'volumePath', 'volume'),
  path: str(args, 'path'),
  inner: what === 'file' ? str(args, 'filePath') : str(args, 'directoryPath'),
}, what)

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** The stored file (or inline text) an upload sends, from whatever shape an earlier step produced. */
async function uploadSource(args: Args, organizationId: string, store: DatabricksFileStore): Promise<{ bytes: Uint8Array; contentType?: string; name?: string }> {
  const find = (value: unknown, depth = 0): { fileId?: string; content?: string; mimeType?: string; filename?: string } | null => {
    if (depth > 3 || value === undefined || value === null || value === '') return null
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.startsWith('{')) {
        try { return find(JSON.parse(trimmed), depth + 1) } catch { return null }
      }
      return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed) ? { fileId: trimmed } : null
    }
    if (Array.isArray(value)) return value.length === 1 ? find(value[0], depth + 1) : null
    if (!isRecord(value)) return null
    if (typeof value.fileId === 'string' && value.fileId) return { fileId: value.fileId, ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}), ...(typeof value.filename === 'string' ? { filename: value.filename } : {}) }
    // Convert-to-File shape ({ filename, mimeType, content }).
    if (typeof value.content === 'string' && (typeof value.filename === 'string' || typeof value.mimeType === 'string')) {
      return { content: value.content, ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}), ...(typeof value.filename === 'string' ? { filename: value.filename } : {}) }
    }
    for (const key of [str(args, 'dataFieldName'), 'file', 'data', 'output', 'binary'].filter(Boolean)) {
      if (key in value) {
        const nested = find(value[key], depth + 1)
        if (nested) return nested
      }
    }
    return null
  }
  const source = find(args.file) ?? find(args.fileId) ?? (typeof args.content === 'string' ? { content: args.content } : null)
  if (!source) throw new DatabricksApiError('Pass the file to upload (a file from an earlier step) or text as content.')
  if (source.fileId) {
    const file = await store.read(source.fileId, organizationId)
    if (!file) throw new DatabricksApiError('The file to upload is no longer available — run the step that produced it again.')
    return { bytes: file.bytes, contentType: file.mimeType, name: file.filename }
  }
  const bytes = new TextEncoder().encode(source.content ?? '')
  if (bytes.byteLength > MAX_INLINE_UPLOAD_BYTES) throw new DatabricksApiError(`Text to upload is larger than ${MAX_INLINE_UPLOAD_BYTES / 1_000_000} MB — store it as a file first.`)
  return { bytes, contentType: source.mimeType ?? 'text/plain; charset=utf-8', ...(source.filename ? { name: source.filename } : {}) }
}

// ── execution ─────────────────────────────────────────────────────────────────

export type DatabricksApiContext = {
  request: DatabricksRequest
  organizationId: string
  userId: string
  files?: DatabricksFileStore
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Run one Databricks workspace-API tool. The caller has already resolved host + credential. */
export async function runDatabricksApiTool(name: string, args: Args, ctx: DatabricksApiContext): Promise<unknown> {
  const { request } = ctx
  const files = ctx.files ?? databricksFileStore
  const rows = () => bounded(args.maxRows, DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT)
  switch (name) {
    // Files
    case 'databricks_files_upload': {
      const destination = target(args, 'file')
      const source = await uploadSource(args, ctx.organizationId, files)
      await uploadVolumeFile(request, destination, source.bytes, { contentType: str(args, 'contentType') || source.contentType, overwrite: flag(args.overwrite, false) })
      return { success: true, path: volumeDisplayPath(destination), size: source.bytes.byteLength, overwrite: flag(args.overwrite, false) }
    }
    case 'databricks_files_download': {
      const source = target(args, 'file')
      const fileName = source.rest[source.rest.length - 1] ?? 'downloaded-file'
      const downloaded = await downloadVolumeFile(request, source, await files.maxBytes(fileName))
      const reference = await files.save({ organizationId: ctx.organizationId, userId: ctx.userId, filename: downloaded.fileName, mimeType: downloaded.contentType, bytes: downloaded.bytes })
      return { ...reference, fileName: downloaded.fileName, contentType: downloaded.contentType, path: volumeDisplayPath(source), catalog: source.catalog, schema: source.schema, volume: source.volume, filePath: source.rest.join('/') }
    }
    case 'databricks_files_delete': {
      const source = target(args, 'file')
      await deleteVolumeFile(request, source)
      return { success: true, path: volumeDisplayPath(source) }
    }
    case 'databricks_files_get_metadata':
      return volumeFileMetadata(request, target(args, 'file'))
    case 'databricks_files_list':
      return listVolumeDirectory(request, target(args, 'directory'), {
        ...(args.pageSize !== undefined && args.pageSize !== '' ? { pageSize: bounded(args.pageSize, 1000, 1000) } : {}),
        ...(str(args, 'pageToken') ? { pageToken: str(args, 'pageToken') } : {}),
      })
    case 'databricks_files_mkdir': {
      const directory = target(args, 'directory')
      if (!directory.rest.length) throw new DatabricksApiError('Pass the directory path to create inside the volume.')
      await createVolumeDirectory(request, directory)
      return { success: true, path: volumeDisplayPath(directory) }
    }
    case 'databricks_files_rmdir': {
      const directory = target(args, 'directory')
      if (!directory.rest.length) throw new DatabricksApiError('Pass the directory path to delete inside the volume (the volume root itself cannot be deleted here).')
      await deleteVolumeDirectory(request, directory)
      return { success: true, path: volumeDisplayPath(directory) }
    }

    // Genie
    case 'databricks_genie_ask':
      return askGenie({
        request,
        spaceId: str(args, 'spaceId'),
        question: str(args, 'question', 'content', 'message'),
        ...(str(args, 'conversationId') ? { conversationId: str(args, 'conversationId') } : {}),
        waitForCompletion: flag(args.waitForCompletion, true),
        includeResults: flag(args.includeResults, true),
        maxRows: rows(),
        deadlineMs: bounded(args.timeoutMinutes, DEFAULT_GENIE_DEADLINE_MS / 60_000, 30) * 60_000,
        ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        ...(ctx.now ? { now: ctx.now } : {}),
      })
    case 'databricks_genie_get_space':
      return getGenieSpace(request, str(args, 'spaceId'))
    case 'databricks_genie_get_message':
      return getGenieMessage(request, { spaceId: str(args, 'spaceId'), conversationId: str(args, 'conversationId'), messageId: str(args, 'messageId') })
    case 'databricks_genie_get_query_result':
    case 'databricks_genie_execute_query': {
      const ids = { spaceId: str(args, 'spaceId'), conversationId: str(args, 'conversationId'), messageId: str(args, 'messageId'), attachmentId: str(args, 'attachmentId') }
      const response = name === 'databricks_genie_execute_query' ? await executeGenieQuery(request, ids) : await getGenieQueryResult(request, ids)
      return { ...response, ...genieResultRecords(response, rows()) }
    }

    // Model Serving
    case 'databricks_serving_query':
      return queryServingEndpoint(request, str(args, 'endpointName', 'endpoint', 'name'), objectArgOf(args, 'requestBody'))
    case 'databricks_serving_list':
      return listServingEndpoints(request)
    case 'databricks_serving_get':
      return getServingEndpoint(request, str(args, 'endpointName', 'endpoint', 'name'))

    // Unity Catalog
    case 'databricks_unity_catalog_list':
    case 'databricks_unity_catalog_get':
    case 'databricks_unity_catalog_create':
    case 'databricks_unity_catalog_update':
    case 'databricks_unity_catalog_delete': {
      const type = unityObjectType(args.objectType)
      const ref = {
        ...(str(args, 'catalog', 'catalogName') ? { catalog: str(args, 'catalog', 'catalogName') } : {}),
        ...(str(args, 'schema', 'schemaName') ? { schema: str(args, 'schema', 'schemaName') } : {}),
        ...(str(args, 'name') ? { name: str(args, 'name') } : {}),
        ...(str(args, 'fullName') ? { fullName: str(args, 'fullName') } : {}),
      }
      if (name === 'databricks_unity_catalog_list') {
        return unityList(request, type, { ...ref, ...(args.maxResults !== undefined && args.maxResults !== '' ? { maxResults: bounded(args.maxResults, 1000, 10_000) } : {}), ...(str(args, 'pageToken') ? { pageToken: str(args, 'pageToken') } : {}) })
      }
      if (name === 'databricks_unity_catalog_get') return unityGet(request, type, ref)
      if (name === 'databricks_unity_catalog_delete') return unityDelete(request, type, { ...ref, force: flag(args.force, false) })
      if (name === 'databricks_unity_catalog_update') {
        return unityUpdate(request, type, { ...ref, ...(optionalStr(args, 'comment') !== undefined ? { comment: optionalStr(args, 'comment') } : {}), ...(str(args, 'owner') ? { owner: str(args, 'owner') } : {}), ...(str(args, 'newName') ? { newName: str(args, 'newName') } : {}) })
      }
      const columns = jsonArg(args, 'columns')
      const inputParams = jsonArg(args, 'inputParams')
      return unityCreate(request, type, {
        ...ref,
        ...(str(args, 'comment') ? { comment: str(args, 'comment') } : {}),
        ...(str(args, 'storageLocation') ? { storageLocation: str(args, 'storageLocation') } : {}),
        ...(str(args, 'volumeType') ? { volumeType: str(args, 'volumeType') } : {}),
        ...(columns !== undefined ? { columns } : {}),
        ...(inputParams !== undefined ? { inputParams } : {}),
        ...(str(args, 'returnType') ? { returnType: str(args, 'returnType') } : {}),
        ...(str(args, 'routineBody') ? { routineBody: str(args, 'routineBody') } : {}),
        ...(optionalStr(args, 'routineDefinition') ? { routineDefinition: optionalStr(args, 'routineDefinition') } : {}),
      })
    }

    // Vector Search
    case 'databricks_vector_search_query': {
      const vector = jsonArg(args, 'queryVector')
      const reranker = jsonArg(args, 'reranker') as { model?: unknown; columnsToRerank?: unknown } | undefined
      const rerank = reranker && typeof reranker === 'object' ? listArg(reranker as Args, 'columnsToRerank') : []
      const threshold = Number(args.scoreThreshold)
      return vectorSearchQuery(request, {
        indexName: str(args, 'indexName'),
        ...(str(args, 'queryText') ? { queryText: str(args, 'queryText') } : {}),
        ...(Array.isArray(vector) && vector.length ? { queryVector: vector.map(Number) } : {}),
        columns: listArg(args, 'columns'),
        numResults: bounded(args.numResults, 10, 1000),
        ...(str(args, 'searchMode') ? { searchMode: str(args, 'searchMode') } : {}),
        ...(str(args, 'filtersJson', 'filterExpression') ? { filtersJson: str(args, 'filtersJson', 'filterExpression') } : {}),
        ...(Number.isFinite(threshold) && threshold > 0 ? { scoreThreshold: Math.min(threshold, 1) } : {}),
        ...(rerank.length ? { reranker: { ...(typeof reranker?.model === 'string' && reranker.model ? { model: reranker.model } : {}), columnsToRerank: rerank } } : {}),
      }, rows())
    }
    case 'databricks_vector_search_list_indexes':
      return vectorSearchListIndexes(request, str(args, 'endpointName'), str(args, 'pageToken') || undefined)
    case 'databricks_vector_search_get_index':
      return vectorSearchGetIndex(request, str(args, 'indexName'))
    case 'databricks_vector_search_list_endpoints':
      return vectorSearchListEndpoints(request, str(args, 'pageToken') || undefined)
    case 'databricks_vector_search_create_index':
      return vectorSearchCreateIndex(request, {
        indexName: str(args, 'indexName'),
        endpointName: str(args, 'endpointName'),
        primaryKey: str(args, 'primaryKey'),
        ...(str(args, 'indexType') ? { indexType: str(args, 'indexType') } : {}),
        ...(args.deltaSyncIndexSpec !== undefined ? { deltaSyncIndexSpec: jsonArg(args, 'deltaSyncIndexSpec') } : {}),
        ...(args.directAccessIndexSpec !== undefined ? { directAccessIndexSpec: jsonArg(args, 'directAccessIndexSpec') } : {}),
      })
    case 'databricks_vector_search_upsert': {
      const list = jsonArg(args, 'rows')
      if (!Array.isArray(list) || list.some((entry) => !isRecord(entry))) throw new DatabricksApiError('"rows" must be a list of objects.')
      return vectorSearchUpsert(request, str(args, 'indexName'), list as Record<string, unknown>[])
    }
    case 'databricks_vector_search_delete_data':
      return vectorSearchDeleteData(request, str(args, 'indexName'), listArg(args, 'primaryKeys'))
  }
  throw new DatabricksApiError(`Unknown Databricks tool: ${name}`)
}
