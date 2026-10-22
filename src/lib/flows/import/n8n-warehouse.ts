import type { AgentHttpEndpoint } from '@/lib/integrations/http-endpoints'

/**
 * n8n → Backstory for data warehouses and agent HTTP tools.
 *
 * Kept out of from-n8n.ts (pure, like it): the Snowflake and Databricks nodes,
 * raw HTTP calls to either statements API, and the agent-side HTTP Request
 * tools. Everything here returns plain data; from-n8n.ts places it on the
 * graph and reports the notes.
 *
 *   n8n-nodes-base.snowflake    executeQuery / insert / update → snowflake_sql_query
 *   n8n-nodes-base.databricks   databricksSql.executeQuery     → databricks_sql_query
 *                               any other resource/operation   → UNMAPPED (kept, flagged)
 *   POST …/api/2.0/sql/statements          → databricks_sql_query
 *   POST <acct>.snowflakecomputing.com/api/v2/statements → snowflake_sql_query
 *
 * SQL is never built by splicing values: generated INSERT/UPDATE statements
 * bind every value, and an n8n query that pasted an expression into a quoted
 * literal ('{{ $json.x }}') becomes a bound parameter instead.
 */

export type WarehouseKind = 'databricks' | 'snowflake'

export type WarehouseStepBinding = {
  connectionId: string
  toolName: string
  label: string
  args: Record<string, unknown>
  /** Kind of warehouse — drives the credential note. */
  kind: WarehouseKind
  /** True for a query whose output is rows (drives per-item wiring downstream). */
  producesRows: boolean
  notes: string[]
  warnings: string[]
}

export type WarehouseUnmapped = { kind: WarehouseKind; unmapped: string; args: Record<string, unknown>; hint: string }

const LABEL: Record<WarehouseKind, string> = { databricks: 'Databricks', snowflake: 'Snowflake' }

/**
 * n8n warehouse credential types → which Backstory credential replaces them.
 * An export never carries the secret, so the note says what to save, where.
 */
export const N8N_WAREHOUSE_CREDENTIALS: Record<string, { kind: WarehouseKind; save: string }> = {
  databricksApi: {
    kind: 'databricks',
    save: 'save a Bearer credential holding a Databricks personal access token, restricted to your workspace host (e.g. dbc-1234abcd-5678.cloud.databricks.com)',
  },
  databricksOAuth2Api: {
    kind: 'databricks',
    save: 'save an OAuth2 credential with client credentials (token URL https://<workspace host>/oidc/v1/token, scope all-apis) for a service principal, restricted to your workspace host',
  },
  snowflake: {
    kind: 'snowflake',
    save: 'save a Snowflake Key Pair or Snowflake Access Token credential for <account>.snowflakecomputing.com — Snowflake\'s SQL API does not accept a username and password, so the n8n password login cannot be reused',
  },
  snowflakeOAuth2Api: {
    kind: 'snowflake',
    save: 'save an OAuth2 credential (refresh token + token URL https://<account>.snowflakecomputing.com/oauth/token-request) or a Snowflake Access Token credential for <account>.snowflakecomputing.com',
  },
}

/** The credential sentence for a node, from its n8n credential types (or the kind's default). */
export function warehouseCredentialNote(kind: WarehouseKind, credentialTypes: string[]): string {
  const matched = credentialTypes.map((type) => N8N_WAREHOUSE_CREDENTIALS[type]).filter((entry) => entry?.kind === kind)
  const save = matched.length ? matched.map((entry) => entry.save).join('; or ') : kind === 'snowflake' ? N8N_WAREHOUSE_CREDENTIALS.snowflake.save : N8N_WAREHOUSE_CREDENTIALS.databricksApi.save
  return `its n8n ${LABEL[kind]} credential does not transfer — in Integrations, ${save}. The step finds it by host.`
}

// ── identifiers (mirrors n8n's own Snowflake escaping) ────────────────────────

/** n8n's escapeSnowflakeIdentifier: quoted, uppercased unless already quoted. */
export function escapeSnowflakeIdentifier(identifier: string): string {
  if (identifier.startsWith('"') && identifier.endsWith('"') && identifier.length > 2) {
    const bare = identifier.slice(1, -1).replace(/""/g, '"')
    return `"${bare.replace(/"/g, '""')}"`
  }
  return `"${identifier.toUpperCase().replace(/"/g, '""')}"`
}

/** n8n's escapeSnowflakeObjectIdentifier: db.schema.table, each part escaped. */
export function escapeSnowflakeObjectIdentifier(identifier: string): string {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < identifier.length; index++) {
    const char = identifier[index]
    if (char === '"') {
      if (inQuotes && identifier[index + 1] === '"') {
        current += '""'
        index++
      } else {
        inQuotes = !inQuotes
        current += char
      }
    } else if (char === '.' && !inQuotes) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts.map((part) => escapeSnowflakeIdentifier(part.trim())).join('.')
}

// ── query parameterization ─────────────────────────────────────────────────────

export type ParameterizedSql = {
  statement: string
  /** Values in binding order (flow tokens or literals). */
  bindings: string[]
  /** Expressions that still splice into the SQL text (identifiers, fragments). */
  spliced: string[]
}

const VALUE_CONTEXT = /(?:=|<>|!=|<=|>=|<|>|\bLIKE|\bILIKE|\bLIMIT|\bOFFSET)\s*$/i

/**
 * Turn an n8n query's expressions into bind variables where they stand for a
 * VALUE: a quoted literal holding an expression ('{{ $json.name }}', or
 * 'prefix-{{ $json.id }}') becomes one placeholder whose binding is the
 * literal's text; a bare expression right after a comparison, LIKE, LIMIT or
 * OFFSET becomes one too. Anything else (a table name from an expression) has
 * no bind form and stays spliced — reported in `spliced`.
 *
 * `style` picks the placeholder: '?' (Snowflake positional — interleaved with
 * any '?' the query already had, which take `existing` values in order),
 * 'numbered' (:N continuing after `existing`) or 'named' (:pN, Databricks).
 * `toToken` translates one n8n expression body into a flow token.
 */
export function parameterizeN8nSql(
  rawQuery: string,
  toToken: (expression: string) => string,
  options: { style: 'positional' | 'named'; existing?: string[] },
): ParameterizedSql {
  const query = rawQuery.startsWith('=') ? rawQuery.slice(1) : rawQuery
  const existing = [...(options.existing ?? [])]
  const numbered = options.style === 'positional' && /(^|[^:\w]):\d+\b/.test(query.replace(/'(?:[^']|'')*'/g, "''"))
  const bindings: string[] = numbered ? [...existing] : []
  const spliced: string[] = []
  let named = 0
  const placeholder = () => {
    if (options.style === 'named') return `:p${++named}`
    return numbered ? `:${bindings.length}` : '?'
  }
  const pattern = /'((?:[^']|'')*)'|\{\{\s*([^{}]+?)\s*\}\}|\?/g
  let out = ''
  let last = 0
  for (let match = pattern.exec(query); match; match = pattern.exec(query)) {
    out += query.slice(last, match.index)
    last = pattern.lastIndex
    const [whole, literal, bare] = match
    if (literal !== undefined) {
      if (!/\{\{[^{}]+\}\}/.test(literal)) {
        out += whole
        continue
      }
      const value = literal.replace(/''/g, "'").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, expression: string) => toToken(expression))
      bindings.push(value)
      out += placeholder()
      continue
    }
    if (bare !== undefined) {
      if (VALUE_CONTEXT.test(out)) {
        bindings.push(toToken(bare))
        out += placeholder()
      } else {
        spliced.push(bare)
        out += toToken(bare)
      }
      continue
    }
    // An existing positional '?' takes the next n8n Query Parameter.
    if (!numbered && options.style === 'positional') {
      bindings.push(existing.shift() ?? '')
    }
    out += whole
  }
  out += query.slice(last)
  return { statement: out, bindings, spliced }
}

/** Split n8n's comma-separated Query Parameters, keeping commas inside {{ }}. */
export function splitQueryReplacement(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let index = 0; index < value.length; index++) {
    const pair = value.slice(index, index + 2)
    if (pair === '{{') { depth++; current += pair; index++; continue }
    if (pair === '}}' && depth > 0) { depth--; current += pair; index++; continue }
    if (value[index] === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += value[index]
  }
  if (current.trim() || parts.length) parts.push(current.trim())
  return parts
}

// ── node mappings ──────────────────────────────────────────────────────────────

/** A plain field name usable in a flow token path; anything else can't be read by name. */
const TOKEN_FIELD = /^[A-Za-z_$][\w$]*$/

/**
 * The n8n Snowflake node. `expr` translates a raw n8n expression body to a
 * flow token ({{ $json.x }} → {{step.….output.x}}); `trs` translates a whole
 * n8n parameter value; `jsonBase` is what $json means for this node.
 */
export function snowflakeNodeBinding(
  parameters: Record<string, unknown>,
  helpers: { expr: (expression: string) => string; trs: (value: unknown) => string; jsonBase: string },
): WarehouseStepBinding | WarehouseUnmapped {
  // n8n omits default-valued parameters on export: this node defaults to
  // insert, but a node carrying a query and no table is an executeQuery.
  const operation = String(parameters.operation ?? (parameters.query !== undefined && parameters.table === undefined ? 'executeQuery' : 'insert'))
  const base = { connectionId: 'native:snowflake', toolName: 'snowflake_sql_query', label: 'Snowflake', kind: 'snowflake' as const }
  if (operation === 'executeQuery') {
    const replacement = (parameters.options as { queryReplacement?: unknown } | undefined)?.queryReplacement
    const existing = typeof replacement === 'string' && replacement.trim()
      ? splitQueryReplacement(helpers.trs(replacement.startsWith('=') || !replacement.includes('{{') ? replacement : `=${replacement}`))
      : Array.isArray(replacement) ? replacement.map((value) => helpers.trs(value)) : []
    const sql = parameterizeN8nSql(String(parameters.query ?? ''), helpers.expr, { style: 'positional', existing })
    return {
      ...base,
      producesRows: true,
      args: { statement: sql.statement, ...(sql.bindings.length ? { bindings: sql.bindings } : {}) },
      notes: [],
      warnings: sql.spliced.length
        ? [`its query splices ${sql.spliced.map((expression) => `{{ ${expression.slice(0, 40)} }}`).join(', ')} into the SQL text at run time — fine for a table name, unsafe for a value; bind values with ? and the step's bindings instead.`]
        : [],
    }
  }
  if (operation === 'insert' || operation === 'update') {
    const table = String(parameters.table ?? '').trim()
    const columns = String(parameters.columns ?? '').split(',').map((column) => column.trim()).filter(Boolean)
    const updateKey = String(parameters.updateKey ?? 'id').trim() || 'id'
    if (!table || /\{\{|^=/.test(table) || columns.some((column) => /\{\{|^=/.test(column)) || (operation === 'update' && /\{\{|^=/.test(updateKey))) {
      return { kind: 'snowflake', unmapped: `Snowflake ${operation} with a computed table or column list`, args: { table, columns: parameters.columns ?? '' }, hint: 'write the INSERT/UPDATE with ? bindings on snowflake_sql_query' }
    }
    if (operation === 'update' && !columns.includes(updateKey)) columns.unshift(updateKey)
    const value = (column: string) => {
      const field = column.replace(/^"|"$/g, '')
      return TOKEN_FIELD.test(field) ? `{{${helpers.jsonBase}.${field}}}` : ''
    }
    const unreadable = columns.filter((column) => !value(column))
    const quotedTable = escapeSnowflakeObjectIdentifier(table)
    const statement = operation === 'insert'
      ? `INSERT INTO ${quotedTable} (${columns.map(escapeSnowflakeIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      : `UPDATE ${quotedTable} SET ${columns.map((column) => `${escapeSnowflakeIdentifier(column)} = ?`).join(',')} WHERE ${escapeSnowflakeIdentifier(updateKey)} = ?`
    const bindings = [...columns.map(value), ...(operation === 'update' ? [value(updateKey)] : [])]
    return {
      ...base,
      producesRows: false,
      args: { statement, bindings },
      notes: [`${operation === 'insert' ? 'Inserts' : 'Updates'} ${quotedTable} with every value bound from the incoming item (${columns.join(', ')}).`],
      warnings: unreadable.length ? [`the column(s) ${unreadable.join(', ')} can't be read from the incoming item by name — set their bindings on the step.`] : [],
    }
  }
  return { kind: 'snowflake', unmapped: `Snowflake ${operation}`, args: parameters, hint: 'use snowflake_sql_query with the equivalent SQL' }
}

function locatorValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const inner = (value as { value?: unknown }).value
    if (typeof inner === 'string') return inner
  }
  return ''
}

/** The n8n Databricks node (v1: resource databricksSql is the only one with an equivalent). */
export function databricksNodeBinding(
  parameters: Record<string, unknown>,
  helpers: { expr: (expression: string) => string; trs: (value: unknown) => string },
): WarehouseStepBinding | WarehouseUnmapped {
  const resource = String(parameters.resource ?? 'databricksSql')
  const operation = String(parameters.operation ?? (resource === 'databricksSql' ? 'executeQuery' : ''))
  if (resource === 'databricksSql' && operation === 'executeQuery') {
    const rawWarehouse = locatorValue(parameters.warehouseId)
    // The URL locator mode stores the pasted URL; n8n extracts the id at run time.
    const warehouseId = helpers.trs(/\/sql\/warehouses\/([a-zA-Z0-9]+)/.exec(rawWarehouse)?.[1] ?? rawWarehouse)
    const declared = ((parameters.queryParameters as { parameters?: Array<{ name?: unknown; value?: unknown; type?: unknown }> } | undefined)?.parameters ?? [])
      .filter((entry) => typeof entry.name === 'string' && entry.name)
      .map((entry) => ({ name: String(entry.name), value: helpers.trs(entry.value ?? ''), ...(typeof entry.type === 'string' && entry.type ? { type: entry.type } : {}) }))
    const sql = parameterizeN8nSql(String(parameters.query ?? ''), helpers.expr, { style: 'named' })
    const parameters_ = [...declared, ...sql.bindings.map((value, index) => ({ name: `p${index + 1}`, value }))]
    return {
      connectionId: 'native:databricks',
      toolName: 'databricks_sql_query',
      label: 'Databricks',
      kind: 'databricks',
      producesRows: true,
      args: {
        statement: sql.statement,
        ...(warehouseId ? { warehouseId } : {}),
        ...(parameters_.length ? { parameters: parameters_ } : {}),
      },
      notes: warehouseId ? [] : ['No SQL warehouse was set — the step uses the workspace\'s only (or only running) warehouse.'],
      warnings: sql.spliced.length
        ? [`its query splices ${sql.spliced.map((expression) => `{{ ${expression.slice(0, 40)} }}`).join(', ')} into the SQL text at run time — fine for a table name, unsafe for a value; use a :name parameter instead.`]
        : [],
    }
  }
  const HINTS: Record<string, string> = {
    files: 'call the Files API (/api/2.0/fs/files/…) from an HTTP step with your Databricks credential',
    genie: 'call the Genie API (/api/2.0/genie/spaces/…) from an HTTP step with your Databricks credential, or query the tables directly with databricks_sql_query',
    modelServing: 'call the serving endpoint (/serving-endpoints/<name>/invocations) from an HTTP step with your Databricks credential',
    unityCatalog: 'use databricks_sql_query (SHOW / DESCRIBE / CREATE … statements) or the Unity Catalog API from an HTTP step',
    vectorSearch: 'call the Vector Search API (/api/2.0/vector-search/…) from an HTTP step with your Databricks credential',
  }
  return {
    kind: 'databricks',
    unmapped: `Databricks ${resource}.${operation || '?'}`,
    args: parameters,
    hint: HINTS[resource] ?? 'use databricks_sql_query or databricks_run_job, or an HTTP step with your Databricks credential',
  }
}

/**
 * A raw HTTP call to either statements API → the warehouse tool, which also
 * polls, reads every chunk/partition and answers records. Only a POST whose
 * JSON body carries a literal statement is rebound; anything else (a
 * computed body, a manual GET poll) stays an HTTP step.
 */
export function warehouseHttpBinding(method: string, url: string, body: string | undefined): WarehouseStepBinding | null {
  if (method.toUpperCase() !== 'POST' || !body) return null
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(body) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof parsed.statement !== 'string' || !parsed.statement.trim()) return null
  const databricks = /^https:\/\/([a-z0-9.-]+)\/api\/2\.0\/sql\/statements\/?(?:\?.*)?$/i.exec(url)
  if (databricks) {
    const host = databricks[1].toLowerCase()
    return {
      connectionId: 'native:databricks',
      toolName: 'databricks_sql_query',
      label: 'Databricks',
      kind: 'databricks',
      producesRows: true,
      args: {
        statement: parsed.statement,
        ...(typeof parsed.warehouse_id === 'string' && parsed.warehouse_id ? { warehouseId: parsed.warehouse_id } : {}),
        ...(Array.isArray(parsed.parameters) && parsed.parameters.length ? { parameters: parsed.parameters } : {}),
        ...(typeof parsed.catalog === 'string' && parsed.catalog ? { catalog: parsed.catalog } : {}),
        ...(typeof parsed.schema === 'string' && parsed.schema ? { schema: parsed.schema } : {}),
        ...(host.includes('{{') ? {} : { host }),
      },
      notes: [],
      warnings: [],
    }
  }
  const snowflake = /^https:\/\/([a-z0-9.{}_-]+\.snowflakecomputing\.com)\/api\/v2\/statements\/?(?:\?.*)?$/i.exec(url)
  if (snowflake) {
    const host = snowflake[1].toLowerCase()
    const placeholderHost = /your[_-]?account|\{\{/i.test(host)
    return {
      connectionId: 'native:snowflake',
      toolName: 'snowflake_sql_query',
      label: 'Snowflake',
      kind: 'snowflake',
      producesRows: true,
      args: {
        statement: parsed.statement,
        ...(parsed.bindings && typeof parsed.bindings === 'object' ? { bindings: parsed.bindings } : {}),
        ...Object.fromEntries((['warehouse', 'database', 'schema', 'role'] as const)
          .filter((key) => typeof parsed[key] === 'string' && parsed[key])
          .map((key) => [key, parsed[key]])),
        ...(placeholderHost ? {} : { host }),
      },
      notes: [],
      warnings: [],
    }
  }
  return null
}

// ── agent HTTP tools ───────────────────────────────────────────────────────────

type ToolHttpParameter = { name?: unknown; valueProvider?: unknown; value?: unknown }

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie)$|api[-_]?key|token|secret|password/i

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

/** `{name}` (toolHttpRequest) and `{{ $fromAI('name', …) }}` (httpRequestTool) → `{{name}}`. */
function modelPlaceholders(text: string): string {
  return text
    .replace(/\{\{\s*\$fromAI\(\s*['"`]([A-Za-z_][\w]*)['"`][^}]*\)\s*\}\}/g, '{{$1}}')
    .replace(/(^|[^{])\{([A-Za-z_][\w-]*)\}(?!\})/g, (_m, before: string, name: string) => `${before}{{${name.replace(/-/g, '_')}}}`)
}

function keyValues(collection: unknown, placeholder: boolean): Record<string, string> {
  const values = ((collection as { values?: ToolHttpParameter[]; parameters?: ToolHttpParameter[] } | undefined)?.values
    ?? (collection as { parameters?: ToolHttpParameter[] } | undefined)?.parameters ?? [])
  const out: Record<string, string> = {}
  for (const entry of values) {
    if (typeof entry.name !== 'string' || !entry.name) continue
    const provider = String(entry.valueProvider ?? 'fieldValue')
    const raw = typeof entry.value === 'string' ? entry.value.replace(/^=/, '') : entry.value === undefined ? '' : String(entry.value)
    out[entry.name] = placeholder && provider.startsWith('model') ? `{{${entry.name.replace(/[^\w]/g, '_')}}}` : modelPlaceholders(raw)
  }
  return out
}

/**
 * An n8n agent's HTTP Request tool (toolHttpRequest, or the newer
 * httpRequestTool) → a configured API endpoint on the created agent: its own
 * named tool whose placeholders the model fills. Auth is bound later by host.
 * Expressions over workflow data have no meaning on an agent and are dropped
 * from the endpoint (reported by the caller).
 */
export function agentEndpointFromN8nTool(sub: { name?: string; type?: string; parameters?: Record<string, unknown> }, index: number): AgentHttpEndpoint | null {
  const p = sub.parameters ?? {}
  const url = modelPlaceholders(String(p.url ?? '').replace(/^=/, '')).trim()
  if (!/^https?:\/\//i.test(url)) return null
  const method = String(p.method ?? 'GET').toUpperCase()
  const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
  const queryMode = String(p.specifyQuery ?? 'keypair')
  const headerMode = String(p.specifyHeaders ?? 'keypair')
  const bodyMode = String(p.specifyBody ?? 'keypair')
  const query = p.sendQuery === true && queryMode === 'keypair' ? keyValues(p.parametersQuery ?? p.queryParameters, true) : {}
  // A secret typed straight into a header must not land in agent metadata —
  // auth comes from the host-bound credential instead.
  const headers = Object.fromEntries(Object.entries(
    p.sendHeaders === true && headerMode === 'keypair' ? keyValues(p.parametersHeaders ?? p.headerParameters, true) : {},
  ).filter(([header]) => !SECRET_HEADER.test(header)))
  let body: string | undefined
  if (p.sendBody === true) {
    if (bodyMode === 'json' && typeof p.jsonBody === 'string') body = modelPlaceholders(p.jsonBody.replace(/^=/, ''))
    else if (bodyMode === 'model') body = '{{body}}'
    else body = JSON.stringify(keyValues(p.parametersBody ?? p.bodyParameters, true))
  }
  const name = String(sub.name ?? `HTTP tool ${index + 1}`).slice(0, 60)
  const description = typeof p.toolDescription === 'string' ? p.toolDescription.trim().slice(0, 500) : ''
  return {
    id: `n8n-${slugify(name) || 'http'}-${index + 1}`,
    name,
    ...(description ? { description } : {}),
    method: (allowed as readonly string[]).includes(method) ? method as AgentHttpEndpoint['method'] : 'GET',
    url,
    ...(Object.keys(query).length ? { query } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { bodyMode: 'json' as const, body } : {}),
  }
}
