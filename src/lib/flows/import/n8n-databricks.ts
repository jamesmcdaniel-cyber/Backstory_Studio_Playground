import type { WarehouseStepBinding } from './n8n-warehouse'

/**
 * n8n's Databricks node, every resource besides SQL, onto the Databricks
 * plane's workspace-API tools — plus raw HTTP calls to the Jobs API, which n8n
 * has no node for. Pure, like the rest of the importer: plain data out,
 * from-n8n.ts places it on the graph.
 *
 * The operation names and parameters are n8n-nodes-base's own
 * (packages/nodes-base/nodes/Databricks, Databricks.node.ts v1):
 *
 *   files         uploadFile downloadFile deleteFile getFileInfo listDirectory
 *                 createDirectory deleteDirectory           → databricks_files_*
 *   genie         startConversation createMessage           → databricks_genie_ask
 *                 getMessage getSpace getQueryResults
 *                 executeMessageQuery                       → databricks_genie_get_* / _execute_query
 *   modelServing  queryEndpoint                             → databricks_serving_query
 *   unityCatalog  list/get/create/delete × catalog/table/volume/function,
 *                 updateCatalog                             → databricks_unity_catalog_*
 *   vectorSearch  queryIndex getIndex listIndexes createIndex → databricks_vector_search_*
 *
 *   POST …/api/2.x/jobs/run-now       → databricks_run_job { jobId, … }
 *   POST …/api/2.x/jobs/runs/submit   → databricks_run_job { runSpec }
 *
 * n8n omits default-valued parameters on export, so every default below is
 * n8n's own (resource operation defaults, searchMode ANN, numResults 10, …).
 */

export type DatabricksImportHelpers = {
  /** Translate one whole n8n parameter value (expressions → flow tokens). */
  trs: (value: unknown) => string
  /** What $json means for this node — the incoming data a file upload takes. */
  jsonBase?: string
}

/** The value of an n8n resource-locator parameter ({ __rl, mode, value }) or a plain string. */
export function locatorValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const inner = (value as { value?: unknown }).value
    if (typeof inner === 'string') return inner
  }
  return ''
}

/** n8n's default operation per Databricks resource. */
export const DATABRICKS_DEFAULT_OPERATION: Record<string, string> = {
  databricksSql: 'executeQuery',
  files: 'listDirectory',
  genie: 'startConversation',
  modelServing: 'queryEndpoint',
  unityCatalog: 'listTables',
  vectorSearch: 'listIndexes',
}

const FILES: Record<string, string> = {
  uploadFile: 'databricks_files_upload',
  downloadFile: 'databricks_files_download',
  deleteFile: 'databricks_files_delete',
  getFileInfo: 'databricks_files_get_metadata',
  listDirectory: 'databricks_files_list',
  createDirectory: 'databricks_files_mkdir',
  deleteDirectory: 'databricks_files_rmdir',
}
const GENIE: Record<string, string> = {
  startConversation: 'databricks_genie_ask',
  createMessage: 'databricks_genie_ask',
  getMessage: 'databricks_genie_get_message',
  getSpace: 'databricks_genie_get_space',
  getQueryResults: 'databricks_genie_get_query_result',
  executeMessageQuery: 'databricks_genie_execute_query',
}
const VECTOR: Record<string, string> = {
  queryIndex: 'databricks_vector_search_query',
  getIndex: 'databricks_vector_search_get_index',
  listIndexes: 'databricks_vector_search_list_indexes',
  createIndex: 'databricks_vector_search_create_index',
}
/** unityCatalog operation → [tool verb, object type]. */
const UNITY = /^(list|get|create|delete|update)(Catalog|Table|Volume|Function)s?$/
const UNITY_SUPPORTED = new Set([
  'listCatalogs', 'listTables', 'listVolumes', 'listFunctions',
  'getCatalog', 'getTable', 'getVolume', 'getFunction',
  'createCatalog', 'createTable', 'createVolume', 'createFunction',
  'deleteCatalog', 'deleteTable', 'deleteVolume', 'deleteFunction',
  'updateCatalog',
])

/** The plane tool an n8n Databricks resource/operation runs as, or null when there is none. */
export function databricksToolFor(resource: string, operation: string): string | null {
  const op = operation || DATABRICKS_DEFAULT_OPERATION[resource] || ''
  if (resource === 'databricksSql') return op === 'executeQuery' ? 'databricks_sql_query' : null
  if (resource === 'files') return FILES[op] ?? null
  if (resource === 'genie') return GENIE[op] ?? null
  if (resource === 'modelServing') return op === 'queryEndpoint' ? 'databricks_serving_query' : null
  if (resource === 'vectorSearch') return VECTOR[op] ?? null
  if (resource === 'unityCatalog' && UNITY_SUPPORTED.has(op)) return `databricks_unity_catalog_${UNITY.exec(op)![1]}`
  return null
}

// ── parameter translation ─────────────────────────────────────────────────────

/** A string parameter, expressions translated; '' when unset. */
const textParam = (value: unknown, trs: DatabricksImportHelpers['trs']): string =>
  value === undefined || value === null ? '' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : trs(value)

/**
 * An n8n `json` parameter. Literal JSON (expressions only inside string
 * values) becomes a real object whose string leaves carry flow tokens — so a
 * value with quotes in it can never break the JSON at run time. Anything else
 * (a whole-value expression) stays translated text, parsed by the tool.
 */
export function jsonParam(value: unknown, trs: DatabricksImportHelpers['trs']): unknown {
  if (value === undefined || value === null || value === '') return undefined
  const translate = (node: unknown): unknown => {
    if (typeof node === 'string') return node.includes('{{') ? trs(node.startsWith('=') ? node : `=${node}`) : node
    if (Array.isArray(node)) return node.map(translate)
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, translate(item)]))
    return node
  }
  if (typeof value !== 'string') return translate(value)
  const raw = value.startsWith('=') ? value.slice(1) : value
  try {
    return translate(JSON.parse(raw))
  } catch {
    return trs(value)
  }
}

/** A number parameter: kept as a number, or translated when it is an expression. */
const numberParam = (value: unknown, trs: DatabricksImportHelpers['trs']): number | string | undefined =>
  typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? trs(value) : undefined

/** n8n's comma-separated column list → a list; an expression stays one token the tool splits at run time. */
function listParam(value: unknown, trs: DatabricksImportHelpers['trs']): string[] | string | undefined {
  const text = textParam(value, trs)
  if (!text) return undefined
  if (text.includes('{{')) return text
  return text.split(',').map((entry) => entry.trim()).filter(Boolean)
}

/** Drop unset values so Args only shows what the n8n node actually set. */
function compact(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== '' && value !== null))
}

const binding = (toolName: string, args: Record<string, unknown>, notes: string[] = [], warnings: string[] = []): WarehouseStepBinding => ({
  connectionId: 'native:databricks',
  toolName,
  label: 'Databricks',
  kind: 'databricks',
  producesRows: false,
  args: compact(args),
  notes,
  warnings,
})

// ── the node ──────────────────────────────────────────────────────────────────

/**
 * One non-SQL n8n Databricks operation → its tool step, or null when n8n's
 * resource/operation names nothing this plane knows (the caller flags it).
 */
export function databricksApiNodeBinding(resource: string, operationRaw: string, parameters: Record<string, unknown>, helpers: DatabricksImportHelpers): WarehouseStepBinding | null {
  const { trs } = helpers
  const operation = operationRaw || DATABRICKS_DEFAULT_OPERATION[resource] || ''
  const toolName = databricksToolFor(resource, operation)
  if (!toolName || resource === 'databricksSql') return null
  const p = (key: string) => textParam(parameters[key], trs)
  const additional = (parameters.additionalFields ?? {}) as Record<string, unknown>

  if (resource === 'files') {
    const location = { volumePath: p('volumePath') }
    if (operation === 'uploadFile') {
      const field = textParam(parameters.dataFieldName, trs) || 'data'
      const overwrite = additional.overwrite === true || additional.overwrite === 'true'
      return binding(toolName, {
        ...location,
        filePath: p('filePath'),
        file: `{{${helpers.jsonBase ?? 'input'}}}`,
        ...(field !== 'data' ? { dataFieldName: field } : {}),
        ...(overwrite ? { overwrite: true } : {}),
      }, [`Uploads the file the previous step produced (n8n's binary field “${field}”) — or set content to upload text.`])
    }
    if (operation === 'listDirectory') {
      return binding(toolName, { ...location, directoryPath: p('directoryPath'), pageSize: numberParam(additional.pageSize, trs), pageToken: textParam(additional.pageToken, trs) })
    }
    if (operation === 'createDirectory' || operation === 'deleteDirectory') return binding(toolName, { ...location, directoryPath: p('directoryPath') })
    return binding(toolName, { ...location, filePath: p('filePath') }, operation === 'downloadFile'
      ? ['Answers a file reference (fileId, filename, mimeType, size, url, and the text for text files) in place of n8n binary data.']
      : [])
  }

  if (resource === 'genie') {
    const ids = { spaceId: p('spaceId'), conversationId: p('conversationId'), messageId: p('messageId'), attachmentId: p('attachmentId') }
    if (operation === 'startConversation' || operation === 'createMessage') {
      return binding(toolName, {
        spaceId: ids.spaceId,
        ...(operation === 'createMessage' ? { conversationId: ids.conversationId } : {}),
        question: operation === 'createMessage' ? p('message') : p('initialMessage'),
      }, ['Waits for Genie\'s answer and returns its text, SQL and rows (n8n returned as soon as the question was accepted) — any Wait / Get Message polling after it is no longer needed.'])
    }
    if (operation === 'getSpace') return binding(toolName, { spaceId: ids.spaceId })
    if (operation === 'getMessage') return binding(toolName, { spaceId: ids.spaceId, conversationId: ids.conversationId, messageId: ids.messageId })
    return binding(toolName, ids)
  }

  if (resource === 'modelServing') {
    const raw = locatorValue(parameters.endpointName)
    const endpointName = trs(/\/ml\/endpoints\/([a-zA-Z0-9_-]+)/.exec(raw)?.[1] ?? raw)
    const requestBody = jsonParam(parameters.requestBody ?? '{\n  "messages": [\n    {\n      "role": "user",\n      "content": "Hello!"\n    }\n  ]\n}', trs)
    return binding(toolName, { endpointName, requestBody }, ['Posts the request body to the endpoint\'s /invocations URL; the endpoint validates its own input format.'])
  }

  if (resource === 'unityCatalog') {
    const [, verb, kind] = UNITY.exec(operation)!
    const objectType = kind.toLowerCase()
    const catalog = textParam(locatorValue(parameters.catalogName), trs)
    const schema = textParam(locatorValue(parameters.schemaName), trs)
    const fullName = textParam(locatorValue(parameters.fullName), trs)
    if (verb === 'list') return binding(toolName, { objectType, ...(objectType !== 'catalog' ? { catalog, schema } : {}) })
    if (objectType === 'catalog') {
      return binding(toolName, { objectType, name: catalog, ...(verb === 'create' || verb === 'update' ? { comment: p('comment') } : {}) })
    }
    if (objectType === 'volume') {
      const args: Record<string, unknown> = { objectType, catalog, schema, name: p('volumeName') }
      if (verb === 'create') {
        Object.assign(args, { volumeType: p('volumeType') || 'MANAGED', comment: textParam(additional.comment, trs), storageLocation: textParam(additional.storage_location, trs) })
      }
      return binding(toolName, args)
    }
    if (verb === 'get' || verb === 'delete') return binding(toolName, { objectType, fullName })
    if (objectType === 'table') {
      const extra = (parameters.tableAdditionalFields ?? {}) as Record<string, unknown>
      return binding(toolName, {
        objectType, catalog, schema, name: p('tableName'), storageLocation: p('storageLocation'),
        columns: jsonParam(extra.columns, trs), comment: textParam(extra.comment, trs),
      }, ['Registers an external Delta table, as n8n did (the Unity Catalog API creates external tables only).'])
    }
    // createFunction
    return binding(toolName, {
      objectType, catalog, schema, name: p('functionName'),
      inputParams: jsonParam(parameters.inputParams ?? '[]', trs),
      returnType: p('returnType') || 'STRING',
      routineBody: p('routineBody') || 'SQL',
      routineDefinition: p('routineDefinition'),
    })
  }

  // vectorSearch
  if (operation === 'queryIndex') {
    const options = (parameters.options ?? {}) as Record<string, unknown>
    const vector = String(parameters.queryType ?? 'text') === 'vector'
    const rerank = parameters.enableReranking === true
    return binding(toolName, {
      indexName: p('indexName'),
      ...(vector ? { queryVector: jsonParam(parameters.queryVector, trs) } : { queryText: p('queryText') }),
      columns: listParam(parameters.columns, trs),
      numResults: numberParam(parameters.numResults, trs) ?? 10,
      searchMode: p('searchMode') || 'ANN',
      filtersJson: textParam(options.filterExpression, trs),
      scoreThreshold: numberParam(options.scoreThreshold, trs) || undefined,
      ...(rerank ? { reranker: { model: p('rerankerModel') || 'databricks_reranker', columnsToRerank: listParam(parameters.columnsToRerank, trs) ?? [] } } : {}),
    })
  }
  if (operation === 'getIndex') return binding(toolName, { indexName: p('indexName') })
  if (operation === 'listIndexes') return binding(toolName, { endpointName: p('endpointName') })
  // createIndex
  const indexType = p('indexType') || 'DELTA_SYNC'
  return binding(toolName, {
    indexName: p('indexName'),
    endpointName: p('endpointName'),
    primaryKey: p('primaryKey'),
    indexType,
    ...(indexType === 'DIRECT_ACCESS'
      ? { directAccessIndexSpec: jsonParam(parameters.directAccessIndexSpec, trs) }
      : { deltaSyncIndexSpec: jsonParam(parameters.deltaSyncIndexSpec, trs) }),
  })
}

// ── Jobs over HTTP ────────────────────────────────────────────────────────────

const JOBS_URL = /^https:\/\/([a-z0-9.{}_ -]+)\/api\/2\.[0-2]\/jobs\/(run-now|runs\/submit)\/?(?:\?.*)?$/i
/** run-now fields the tool carries; anything else is reported, not silently dropped. */
const RUN_NOW_CARRIED = new Set(['job_id', 'job_parameters', 'notebook_params', 'idempotency_token'])

/**
 * A raw HTTP call to the Jobs API (n8n has no Jobs operation, so workflows
 * call it directly) → databricks_run_job, which also polls the run to its end.
 * Only a POST with a literal JSON object body is rebound; anything else stays
 * an HTTP step.
 */
export function databricksJobHttpBinding(method: string, url: string, body: string | undefined): WarehouseStepBinding | null {
  if (method.toUpperCase() !== 'POST' || !body) return null
  const match = JOBS_URL.exec(url.trim())
  if (!match) return null
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(body) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  const rawHost = match[1].toLowerCase()
  const host = rawHost.includes('{{') || /\s/.test(rawHost) ? '' : rawHost
  const waits = 'Starts the run and waits for it to finish, failing the step if the run fails (n8n\'s call returned the run id at once) — a Wait / runs/get loop after it is no longer needed.'
  if (match[2].toLowerCase() === 'runs/submit') {
    return { ...binding('databricks_run_job', { runSpec: parsed, host }, [waits]), producesRows: false }
  }
  const jobId = parsed.job_id
  if (jobId === undefined || jobId === null || jobId === '') return null
  const dropped = Object.keys(parsed).filter((key) => !RUN_NOW_CARRIED.has(key))
  return binding('databricks_run_job', {
    jobId: String(jobId),
    jobParameters: parsed.job_parameters,
    notebookParams: parsed.notebook_params,
    host,
  }, [waits], dropped.length ? [`its run-now fields ${dropped.join(', ')} are not carried by databricks_run_job — move them to job-level parameters (jobParameters) or submit a one-time run.`] : [])
}
