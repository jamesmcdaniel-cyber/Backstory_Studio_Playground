import type { FlowGraph, FlowNode, ConditionOp, OutputField, FieldType } from '@/lib/flows/graph'
import { FIELD_TYPES } from '@/lib/flows/graph'

/**
 * Import an n8n workflow JSON (Workflows → Download) as a Backstory flow —
 * the reverse of export/to-n8n.ts. Structural nodes (trigger, HTTP, IF,
 * Switch, Filter, Set, Code, Merge, Wait) convert to native steps and run
 * immediately; LLM chains become native `ai` steps shaped by op (extract /
 * categorize / summarize / ask — they run on our models); an n8n AI Agent
 * with tool or memory sub-nodes becomes a real Agent step, and the returned
 * `agents` specs carry its instructions, model and tool bindings so the
 * import route can create the actual agent; app nodes with no native
 * equivalent import as unbound Tool steps or runnable passthrough stubs.
 *
 * n8n connections are keyed by node NAME; node ids are kept as-is. n8n loops
 * (Loop Over Items) are back-edges — our graph is a DAG, so any connection
 * that would close a cycle is dropped with a warning.
 */

type N8nNodeIn = {
  id?: string
  name?: string
  type?: string
  parameters?: Record<string, unknown>
  position?: [number, number]
  notes?: string
  disabled?: boolean
  /** n8n node-level error policy: stopWorkflow (default) / continueRegularOutput /
   * continueErrorOutput (routes failures out the second output). */
  onError?: string
  /** Legacy spelling of continueRegularOutput. */
  continueOnFail?: boolean
  retryOnFail?: boolean
  maxTries?: number
  waitBetweenTries?: number
  alwaysOutputData?: boolean
  /** n8n app/action nodes carry their credential bindings here — the signal
   * that a node talks to an external service and should import as a Tool step. */
  credentials?: Record<string, unknown>
}

/** Our node kinds whose data schema carries onError / retries / alwaysOutputData. */
const ACTION_SETTING_KINDS = new Set(['agent', 'ai', 'code', 'http', 'tool', 'subflow'])

/**
 * n8n credential TYPE name → our Nango provider. Verified against n8n's
 * credential schemas (packages/nodes-base/credentials); lets an app node we
 * have no parameter mapping for still arrive bound to the right integration.
 */
const CREDENTIAL_TYPE_PROVIDERS: Record<string, { key: string; label: string }> = {
  slackApi: { key: 'slack', label: 'Slack' },
  slackOAuth2Api: { key: 'slack', label: 'Slack' },
  gmailOAuth2: { key: 'gmail', label: 'Gmail' },
  googleSheetsOAuth2Api: { key: 'google_sheets', label: 'Google Sheets' },
  googleSheetsTriggerOAuth2Api: { key: 'google_sheets', label: 'Google Sheets' },
  googleDriveOAuth2Api: { key: 'google_drive', label: 'Google Drive' },
  salesforceOAuth2Api: { key: 'salesforce', label: 'Salesforce' },
  salesforceJwtApi: { key: 'salesforce', label: 'Salesforce' },
  hubspotApi: { key: 'hubspot', label: 'HubSpot' },
  hubspotAppToken: { key: 'hubspot', label: 'HubSpot' },
  hubspotOAuth2Api: { key: 'hubspot', label: 'HubSpot' },
  hubspotDeveloperApi: { key: 'hubspot', label: 'HubSpot' },
  notionApi: { key: 'notion', label: 'Notion' },
  notionOAuth2Api: { key: 'notion', label: 'Notion' },
  airtableApi: { key: 'airtable', label: 'Airtable' },
  airtableTokenApi: { key: 'airtable', label: 'Airtable' },
  airtableOAuth2Api: { key: 'airtable', label: 'Airtable' },
  jiraSoftwareCloudApi: { key: 'jira', label: 'Jira' },
  jiraSoftwareCloudOAuth2Api: { key: 'jira', label: 'Jira' },
  jiraSoftwareServerApi: { key: 'jira', label: 'Jira' },
  jiraSoftwareServerPatApi: { key: 'jira', label: 'Jira' },
  zendeskApi: { key: 'zendesk', label: 'Zendesk' },
  zendeskOAuth2Api: { key: 'zendesk', label: 'Zendesk' },
  linearApi: { key: 'linear', label: 'Linear' },
  linearOAuth2Api: { key: 'linear', label: 'Linear' },
  asanaApi: { key: 'asana', label: 'Asana' },
  asanaOAuth2Api: { key: 'asana', label: 'Asana' },
  githubApi: { key: 'github', label: 'GitHub' },
  githubOAuth2Api: { key: 'github', label: 'GitHub' },
  githubAppApi: { key: 'github', label: 'GitHub' },
  mondayComApi: { key: 'monday', label: 'Monday' },
  mondayComOAuth2Api: { key: 'monday', label: 'Monday' },
  figmaApi: { key: 'figma', label: 'Figma' },
  confluenceCloudApi: { key: 'confluence', label: 'Confluence' },
}

/**
 * n8n node-level settings → the matching fields on our node data. These are
 * the settings every n8n node has (Settings tab); dropping them silently
 * changes runtime behavior (no retries, failures stop instead of routing).
 */
function nodeSettingsFrom(node: N8nNodeIn): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  if (node.onError === 'continueErrorOutput') settings.onError = 'route'
  else if (node.onError === 'continueRegularOutput' || node.continueOnFail) settings.onError = 'continue'
  if (node.retryOnFail) {
    settings.retries = Math.max(0, Math.min(5, (Number(node.maxTries) || 3) - 1))
    if (Number(node.waitBetweenTries) > 0) settings.retryDelayMs = Math.min(60_000, Number(node.waitBetweenTries))
  }
  if (node.alwaysOutputData) settings.alwaysOutputData = true
  return settings
}

/** One node's outgoing ports: `main` plus AI cluster types (ai_tool, ai_languageModel, …). */
type N8nConnectionPorts = { main?: Array<Array<{ node?: string; index?: number }>> } & Record<
  string,
  Array<Array<{ node?: string; index?: number }>> | undefined
>

type N8nWorkflowIn = {
  name?: string
  nodes?: N8nNodeIn[]
  /** n8n pin data: recorded per-node mock outputs, keyed by node NAME. */
  pinData?: Record<string, unknown>
  connections?: Record<string, N8nConnectionPorts>
}

/**
 * Everything the import route needs to CREATE a real agent for an imported
 * n8n AI Agent cluster. The graph's agent step carries `placeholderId` as its
 * agentId; the route swaps in the created agent's real id.
 */
export type N8nAgentSpec = {
  placeholderId: string
  name: string
  /** Composed objective: the n8n system message plus a tool inventory brief. */
  instructions: string
  /** The n8n model id (informational — the created agent runs on our models). */
  model?: string
  /** Integration keys guessed from app-tool sub-nodes (gmail, slack, …). */
  integrations: string[]
  /** MCP server URLs from mcpClientTool sub-nodes — matched to org connections by the route. */
  mcpEndpoints: string[]
  tools: Array<{ name: string; kind: 'mcp' | 'integration' | 'http' | 'code' | 'subworkflow' | 'utility'; description: string }>
  hasMemory: boolean
}

export type N8nImportResult = { name: string; graph: FlowGraph; warnings: string[]; agents: N8nAgentSpec[] }

/** n8n export shape: a nodes array where entries carry an n8n-style `type`. */
export function looksLikeN8nWorkflow(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  const record = json as Record<string, unknown>
  if (typeof record.format === 'string') return false // a Backstory package
  const nodes = record.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return false
  return nodes.every((n) => n && typeof n === 'object' && typeof (n as N8nNodeIn).type === 'string')
}

/**
 * Translate n8n expressions back into flow tokens (reverse of
 * export/to-n8n.ts translateTokens). `names` maps n8n node NAME → flow node id.
 * `jsonBase` is what `$json` means FOR THIS NODE: in n8n it is the incoming
 * item — the direct upstream's output — not the trigger input (except for the
 * first step, where they coincide).
 */
export function fromN8nExpression(
  value: string,
  names: Map<string, string>,
  jsonBase = 'trigger.input',
  onUntranslatable?: (expr: string) => void,
): string {
  if (typeof value !== 'string' || !value.startsWith('=')) return value
  const body = value.slice(1)
  // A PLAIN data path (a.b.c, a[0], a["key"]) — anything else (a ternary, &&,
  // a Math/Date call) is real JS, which must fall through to onUntranslatable
  // instead of silently mistranslating into a garbage token.
  const isPlainPath = (path: string | undefined): boolean =>
    path === undefined || /^[\w$]+(?:\.[\w$]+|\[(?:\d+|"[^"]*"|'[^']*')\])*$/.test(path)
  const translated = body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, expr: string) => {
    // $json.path → the node's incoming item
    const jsonMatch = expr.match(/^\$json(?:\.(.+))?$/)
    if (jsonMatch && isPlainPath(jsonMatch[1])) return `{{${jsonBase}${jsonMatch[1] ? '.' + jsonMatch[1] : ''}}}`
    // $node["Name"].json.path  |  $('Name').item.json.path  |  $('Name').json.path
    const dollarMatch = expr.match(/^\$\((?:"|')(.+?)(?:"|')\)(?:\.(item|first\(\)))?\.json(?:\.(.+))?$/)
    const bracketMatch = dollarMatch ? null : expr.match(/^\$node\[(?:"|')(.+?)(?:"|')\]\.json(?:\.(.+))?$/)
    const nodeName = dollarMatch?.[1] ?? bracketMatch?.[1]
    if (nodeName !== undefined) {
      const path = dollarMatch ? dollarMatch[3] : bracketMatch?.[2]
      if (!isPlainPath(path)) {
        onUntranslatable?.(expr)
        return `{{${expr}}}`
      }
      // `.item` (and legacy $node["X"].json) is n8n's PAIRED item — the named
      // node's item for the CURRENT item. Inside a per-item step ({{item}}
      // base) that is the current item itself, whose fields flow down the main
      // chain; `.first()` stays a whole-step reference.
      const paired = dollarMatch ? dollarMatch[2] !== 'first()' : true
      if (jsonBase === 'item' && paired) return `{{item${path ? '.' + path : ''}}}`
      const id = names.get(nodeName) ?? nodeName
      return `{{step.${id}.output${path ? '.' + path : ''}}}`
    }
    // Unknown expression — kept visible as text for the user to fix; a JS
    // call (Date.now(), Math.*) will NOT evaluate in our templates.
    onUntranslatable?.(expr)
    return `{{${expr}}}`
  })
  return translated
}

/**
 * n8n Code-node compatibility shim, prepended to imported code so the n8n
 * runtime API works inside our sandbox (which exposes `input`, `context`,
 * `console`): `$('Node Name')` reads context.steps via the embedded
 * label→id map, `$input`/`$json` wrap the incoming value in n8n's item shape,
 * and a returned array of {json} items unwraps to the plain values downstream
 * Backstory steps consume.
 */
export function withN8nCodeShim(code: string, labelToId: Record<string, string>): string {
  return `/* n8n compatibility shim (added on import — the original code is below, unchanged) */
const __n8nLabelToId = ${JSON.stringify(labelToId)};
const __n8nItems = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
/* n8n items are always objects; a primitive (an agent's reply text, an AI
 * step's answer) wraps the way its n8n producer would have shaped it. */
const __n8nJson = (v) => (v !== null && typeof v === 'object' ? v : { output: v, text: v });
const __n8nWrap = (v) => __n8nItems(v).map((v2) => ({ json: __n8nJson(v2) }));
const $ = (name) => {
  const id = __n8nLabelToId[name] ?? name;
  const out = context && context.steps && context.steps[id] ? context.steps[id].output : undefined;
  const items = __n8nWrap(out);
  return {
    first: () => items[0],
    last: () => items[items.length - 1],
    all: () => items,
    item: items[0],
    json: items[0] ? items[0].json : undefined,
  };
};
const $input = {
  all: () => __n8nWrap(input),
  first: () => __n8nWrap(input)[0],
  last: () => { const a = __n8nWrap(input); return a[a.length - 1]; },
  item: __n8nWrap(input)[0],
};
const $json = ($input.first() || {}).json;
/* Legacy n8n Code API: "items" is the incoming item list. */
const items = $input.all();
/* Minimal luxon-style $now/$today — enough for the minus/plus/toISO/toFormat
 * date math n8n expressions lean on. UTC, like the platform's date ops. */
const __n8nUnitMs = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
const __n8nSpanMs = (n, unit) => {
  if (n && typeof n === 'object') return Object.entries(n).reduce((sum, [u, v]) => sum + __n8nSpanMs(v, u), 0);
  const key = String(unit || 'day').toLowerCase().replace(/s$/, '');
  return Number(n) * (__n8nUnitMs[key] || __n8nUnitMs.day);
};
const __n8nDT = (ms) => ({
  toISO: () => new Date(ms).toISOString(),
  toMillis: () => ms,
  valueOf: () => ms,
  toString: () => new Date(ms).toISOString(),
  toFormat: (f) => {
    const d = new Date(ms); const p = (v, w) => String(v).padStart(w || 2, '0');
    return String(f)
      .replace(/yyyy/g, String(d.getUTCFullYear())).replace(/MM/g, p(d.getUTCMonth() + 1))
      .replace(/dd/g, p(d.getUTCDate())).replace(/HH/g, p(d.getUTCHours()))
      .replace(/mm/g, p(d.getUTCMinutes())).replace(/ss/g, p(d.getUTCSeconds()));
  },
  minus: (n, unit) => __n8nDT(ms - __n8nSpanMs(n, unit)),
  plus: (n, unit) => __n8nDT(ms + __n8nSpanMs(n, unit)),
});
const $now = __n8nDT(Date.now());
const $today = __n8nDT(new Date().setUTCHours(0, 0, 0, 0));
const __n8nUnwrap = (r) =>
  Array.isArray(r)
    ? r.map((x) => (x && typeof x === 'object' && 'json' in x ? x.json : x))
    : r && typeof r === 'object' && 'json' in r
      ? r.json
      : r;
return __n8nUnwrap(await (async () => {
${code}
})());`
}

/** True when an n8n `=…` value contains an expression our templates can't
 * evaluate (a ternary, a Math/Date call — real JS, not a plain data path). */
function hasUntranslatableJs(value: unknown, names: Map<string, string>, jsonBase: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('=')) return false
  let found = false
  fromN8nExpression(value, names, jsonBase, () => {
    found = true
  })
  return found
}

/** Escape literal text destined for a JS template literal. */
function escapeForTemplateLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/**
 * An n8n assignment value as a JS expression for the code sandbox (where the
 * n8n runtime shim makes $json / $('Node') work verbatim): `={{ expr }}` is
 * the expression itself, `=text {{ expr }}` a template literal, and a plain
 * value a literal coerced by its declared n8n type.
 */
function n8nValueToJs(value: unknown, declaredType?: string): string {
  if (typeof value === 'string' && value.startsWith('=')) {
    const body = value.slice(1)
    const single = body.trim().match(/^\{\{([\s\S]+)\}\}$/)
    if (single && !single[1].includes('}}')) return `(${single[1].trim()})`
    const parts: string[] = []
    let last = 0
    for (const match of body.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      parts.push(escapeForTemplateLiteral(body.slice(last, match.index)))
      parts.push('${' + match[1].trim() + '}')
      last = match.index + match[0].length
    }
    parts.push(escapeForTemplateLiteral(body.slice(last)))
    return '`' + parts.join('') + '`'
  }
  if (declaredType === 'number') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? String(numeric) : JSON.stringify(String(value ?? ''))
  }
  if (declaredType === 'boolean') return String(value === true || value === 'true')
  if (declaredType === 'array' || declaredType === 'object') {
    if (typeof value === 'string') {
      try {
        return JSON.stringify(JSON.parse(value))
      } catch {
        return JSON.stringify(value)
      }
    }
    return JSON.stringify(value ?? null)
  }
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return JSON.stringify(value === undefined || value === null ? '' : String(value))
}

/**
 * Rewrite every raw (untranslatable-JS) `{{ expr }}` token in a translated
 * template to `{{step.<computeId>.output.<key>}}`, collecting the expressions
 * in `exprs` (expr → key, deduplicated) for an inserted compute code step.
 * Flow tokens (trigger./step./item) pass through untouched.
 */
function hoistRawExpressions(value: string, computeId: string, exprs: Map<string, string>): string {
  return value.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (full, expr: string) => {
    if (/^(?:trigger\.|step\.|item\b)/.test(expr)) return full
    let key = exprs.get(expr)
    if (!key) {
      key = `expr${exprs.size}`
      exprs.set(expr, key)
    }
    return `{{step.${computeId}.output.${key}}}`
  })
}

/** n8n resourceLocator values ({ mode, value }) or plain strings → the string. */
function locatorValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const inner = (value as { value?: unknown }).value
    if (typeof inner === 'string') return inner
  }
  return ''
}

/**
 * A binding onto one of the platform's OWN integration tools. Imported app
 * nodes prefer these over raw API/tool stubs: the step arrives bound to the
 * capability (`nango:slack`, `native:email`, …) instead of asking the user to
 * rebuild the call. `missing` names a capability the platform doesn't cover
 * yet — the step stays an unbound tool step and the warning says exactly what
 * to add.
 */
type IntegrationBinding =
  | { connectionId: string; toolName: string; args: Record<string, unknown>; label: string; note?: string; warning?: string }
  | { missing: string }
  | null

/**
 * n8n's `url` locator mode stores the pasted URL verbatim; the file id is
 * extracted by the node at run time. Mirror that here so the tool arg gets the
 * bare id, not a URL the API would reject.
 */
function googleFileId(value: unknown): string {
  const raw = locatorValue(value)
  const match = /\/(?:d|folders)\/([a-zA-Z0-9_-]{5,})/.exec(raw)
  return match ? match[1] : raw
}

/**
 * The column → value mapping an n8n Sheets write carries: the v4+
 * resourceMapper (`columns.value`), or the legacy fieldsUi/fields key-pair
 * lists. Null when the node maps input automatically (nothing static to copy).
 */
function sheetColumnValues(
  parameters: Record<string, unknown>,
  trs: (value: unknown) => string,
): { columns: string[]; values: string[] } | null {
  const mapper = parameters.columns as { mappingMode?: string; value?: unknown } | undefined
  if (mapper && typeof mapper === 'object') {
    const value = mapper.value
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length) return { columns: entries.map(([k]) => k), values: entries.map(([, v]) => trs(v)) }
    }
    return null
  }
  const legacy =
    (parameters.fieldsUi as { fieldValues?: unknown[] } | undefined)?.fieldValues ??
    (parameters.fields as { values?: unknown[] } | undefined)?.values
  if (Array.isArray(legacy) && legacy.length) {
    const pairs = legacy
      .map((entry) => entry as { column?: unknown; columnName?: unknown; fieldValue?: unknown })
      .filter((entry) => entry && typeof entry === 'object')
    if (pairs.length) {
      return {
        columns: pairs.map((p) => String(p.column ?? p.columnName ?? '')),
        values: pairs.map((p) => trs(p.fieldValue)),
      }
    }
  }
  return null
}

/**
 * The record payload an n8n Salesforce create/update carries: the resource's
 * top-level scalar params (company, lastname, …) plus the additional/update
 * fields collection. Salesforce's REST API matches field names
 * case-insensitively, so n8n's lowercased param names post fine as-is.
 */
function salesforceFields(
  parameters: Record<string, unknown>,
  trs: (value: unknown) => string,
): Record<string, unknown> {
  const SKIP = new Set(['resource', 'operation', 'authentication', 'query', 'externalId', 'externalIdValue'])
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (SKIP.has(key) || key.endsWith('Id') || key.endsWith('Ui')) continue
    if (typeof value === 'string') fields[key] = trs(value)
    else if (typeof value === 'number' || typeof value === 'boolean') fields[key] = value
  }
  for (const collection of [parameters.additionalFields, parameters.updateFields]) {
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue
    for (const [key, value] of Object.entries(collection as Record<string, unknown>)) {
      fields[key] = typeof value === 'string' ? trs(value) : value
    }
  }
  return fields
}

/** n8n stores Salesforce resources lowercased (`lead`); post the SObject name. */
function salesforceSobject(resource: string): string {
  return resource ? resource.charAt(0).toUpperCase() + resource.slice(1) : resource
}

/** The record id an n8n Salesforce update/get names: `recordId` or `<resource>Id`. */
function salesforceRecordId(parameters: Record<string, unknown>): unknown {
  if (parameters.recordId !== undefined) return parameters.recordId
  const idKey = Object.keys(parameters).find((key) => key.endsWith('Id') && key !== 'externalId')
  return idKey ? parameters[idKey] : undefined
}

/** Map an n8n APP node (slack, gmail, drive, …) onto a platform integration tool. */
function integrationBindingFor(type: string, parameters: Record<string, unknown>, tr: (v: string) => string): IntegrationBinding {
  const operation = String(parameters.operation ?? '')
  const resource = String(parameters.resource ?? '')
  const trs = (value: unknown) => tr(String(value ?? ''))
  switch (type) {
    case 'n8n-nodes-base.slack': {
      if (!resource || resource === 'message') {
        if (!operation || operation === 'post') {
          const threadTs = (parameters.otherOptions as { thread_ts?: { replyValues?: Array<{ thread_ts?: unknown }> } } | undefined)
            ?.thread_ts?.replyValues?.[0]?.thread_ts
          return {
            connectionId: 'nango:slack',
            toolName: 'slack_post_message',
            label: 'Slack',
            args: {
              channel: trs(locatorValue(parameters.channelId ?? parameters.channel)),
              text: trs(parameters.text),
              ...(threadTs ? { thread_ts: trs(threadTs) } : {}),
            },
          }
        }
        if (operation === 'getAll' || operation === 'history') {
          return {
            connectionId: 'nango:slack',
            toolName: 'slack_read_messages',
            label: 'Slack',
            args: { channel: trs(locatorValue(parameters.channelId ?? parameters.channel)), limit: Number(parameters.limit ?? 30) || 30 },
          }
        }
      }
      if (resource === 'channel' && (operation === 'getAll' || operation === 'list')) {
        return { connectionId: 'nango:slack', toolName: 'slack_list_channels', label: 'Slack', args: {} }
      }
      return { missing: `Slack ${resource || 'message'}.${operation || 'post'}` }
    }
    case 'n8n-nodes-base.gmail': {
      if (!resource || resource === 'message') {
        if (!operation || operation === 'send') {
          const options = (parameters.options ?? {}) as { ccList?: unknown; bccList?: unknown }
          return {
            connectionId: 'nango:gmail',
            toolName: 'gmail_send_email',
            label: 'Gmail',
            args: {
              to: trs(parameters.sendTo ?? parameters.to),
              subject: trs(parameters.subject),
              body: trs(parameters.message ?? parameters.body),
              ...(options.ccList ? { cc: trs(options.ccList) } : {}),
              ...(options.bccList ? { bcc: trs(options.bccList) } : {}),
            },
          }
        }
        if (operation === 'getAll' || operation === 'list') {
          return { connectionId: 'nango:gmail', toolName: 'gmail_list_messages', label: 'Gmail', args: { q: trs((parameters.filters as { q?: unknown } | undefined)?.q ?? parameters.q) } }
        }
        if (operation === 'get') {
          return { connectionId: 'nango:gmail', toolName: 'gmail_read_message', label: 'Gmail', args: { id: trs(parameters.messageId) } }
        }
      }
      return { missing: `Gmail ${resource || 'message'}.${operation || 'send'}` }
    }
    case 'n8n-nodes-base.emailSend':
      return {
        connectionId: 'native:email',
        toolName: 'send',
        label: 'Email',
        args: { to: trs(parameters.toEmail), subject: trs(parameters.subject), body: trs(parameters.html ?? parameters.text) },
      }
    case 'n8n-nodes-base.googleDrive': {
      if (operation === 'list' || operation === 'search') {
        return { connectionId: 'nango:google_drive', toolName: 'google_drive_list_files', label: 'Google Drive', args: { q: trs(parameters.queryString ?? parameters.query) } }
      }
      if (operation === 'download' || operation === 'get') {
        return { connectionId: 'nango:google_drive', toolName: 'google_drive_read_file', label: 'Google Drive', args: { fileId: trs(locatorValue(parameters.fileId)) } }
      }
      // upload / update / share… — Drive is connected read-only today.
      return { missing: `Google Drive ${operation || 'upload'} (the Drive integration is read-only — list/read files)` }
    }
    case 'n8n-nodes-base.googleSheets': {
      const spreadsheetId = trs(googleFileId(parameters.documentId ?? parameters.sheetId))
      const range = trs(locatorValue(parameters.range ?? parameters.sheetName))
      if (!operation || operation === 'read' || operation === 'readRows' || operation === 'getAll' || operation === 'lookup') {
        return { connectionId: 'nango:google_sheets', toolName: 'google_sheets_read_range', label: 'Google Sheets', args: { spreadsheetId, range } }
      }
      if (operation === 'append' || operation === 'appendOrUpdate' || operation === 'update') {
        const mapped = sheetColumnValues(parameters, trs)
        const append = operation !== 'update'
        return {
          connectionId: 'nango:google_sheets',
          toolName: append ? 'google_sheets_append_row' : 'google_sheets_update_range',
          label: 'Google Sheets',
          // append takes one row; update takes rows-of-rows.
          args: { spreadsheetId, range, values: mapped ? (append ? mapped.values : [mapped.values]) : [] },
          ...(mapped
            ? { note: `Writes the columns ${mapped.columns.join(', ')} in that order — check it matches the sheet.` }
            : { warning: 'its column mapping does not transfer — set the row values on the step.' }),
        }
      }
      return { missing: `Google Sheets ${operation}` }
    }
    case 'n8n-nodes-base.salesforce': {
      if (operation === 'query' || operation === 'search') {
        return { connectionId: 'nango:salesforce', toolName: 'salesforce_query', label: 'Salesforce', args: { soql: trs(parameters.query) } }
      }
      if (operation === 'create') {
        return {
          connectionId: 'nango:salesforce',
          toolName: 'salesforce_create_record',
          label: 'Salesforce',
          args: { sobject: salesforceSobject(resource), fields: salesforceFields(parameters, trs) },
        }
      }
      if (operation === 'update') {
        return {
          connectionId: 'nango:salesforce',
          toolName: 'salesforce_update_record',
          label: 'Salesforce',
          args: {
            sobject: salesforceSobject(resource),
            id: trs(locatorValue(salesforceRecordId(parameters))),
            fields: salesforceFields(parameters, trs),
          },
        }
      }
      if (operation === 'get') {
        return {
          connectionId: 'nango:salesforce',
          toolName: 'salesforce_get_record',
          label: 'Salesforce',
          args: { sobject: salesforceSobject(resource), id: trs(locatorValue(salesforceRecordId(parameters))) },
        }
      }
      return { missing: `Salesforce ${operation}` }
    }
    case 'n8n-nodes-base.snowflake':
      return { missing: 'Snowflake (no Snowflake integration exists yet)' }
    default:
      return null
  }
}

/**
 * Map a raw HTTP node aimed at a known provider API onto a platform
 * integration tool — a Slack conversations.history call becomes the Slack
 * integration's read-messages tool instead of a hand-authed HTTP request.
 * `url` and `body` arrive TRANSLATED (flow tokens, not n8n expressions).
 */
function httpIntegrationBindingFor(
  method: string,
  url: string,
  body: string | undefined,
  warn: (msg: string) => void,
  nodeName: string,
): Extract<IntegrationBinding, { connectionId: string }> | null {
  const slack = url.match(/^https:\/\/slack\.com\/api\/([a-zA-Z.]+)(\?([^#]*))?/)
  if (!slack) return null
  const endpoint = slack[1]
  const query = new Map(
    (slack[3] ?? '')
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=')
        return eq === -1 ? [pair, ''] : ([pair.slice(0, eq), pair.slice(eq + 1)] as [string, string])
      }),
  )
  const decoded = (key: string) => {
    const raw = query.get(key)
    if (raw === undefined) return undefined
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  if (endpoint === 'conversations.history') {
    const dropped = ['oldest', 'latest', 'inclusive', 'cursor'].filter((key) => query.has(key))
    if (dropped.length) {
      warn(
        `“${nodeName}”: bound to the Slack integration's read-messages tool — it reads the newest messages only, so the ${dropped.join('/')} parameter(s) were dropped (add a time-window option to slack_read_messages to keep them).`,
      )
    }
    return {
      connectionId: 'nango:slack',
      toolName: 'slack_read_messages',
      label: 'Slack',
      args: { channel: decoded('channel') ?? '', limit: Number(decoded('limit') ?? 30) || 30 },
    }
  }
  if (endpoint === 'conversations.list') {
    return { connectionId: 'nango:slack', toolName: 'slack_list_channels', label: 'Slack', args: {} }
  }
  if (endpoint === 'chat.postMessage' && method.toUpperCase() === 'POST') {
    try {
      const parsed = JSON.parse(body ?? '') as { channel?: unknown; text?: unknown }
      if (typeof parsed.channel === 'string' && typeof parsed.text === 'string') {
        return { connectionId: 'nango:slack', toolName: 'slack_post_message', label: 'Slack', args: { channel: parsed.channel, text: parsed.text } }
      }
    } catch {
      /* body isn't simple JSON — keep the HTTP step */
    }
  }
  return null
}

const OPERATION_TO_OP: Record<string, ConditionOp> = {
  equals: 'eq',
  notEquals: 'neq',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  regex: 'matches',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  larger: 'gt',
  largerEqual: 'gte',
  smaller: 'lt',
  smallerEqual: 'lte',
  exists: 'exists',
  notExists: 'notExists',
  empty: 'isEmpty',
  notEmpty: 'isNotEmpty',
  true: 'isTrue',
  false: 'isFalse',
  after: 'after',
  before: 'before',
}

type RawClause = { leftValue?: unknown; rightValue?: unknown; operator?: { operation?: string } }

function clausesFrom(parameters: Record<string, unknown>, tr: (v: string) => string, warn: (msg: string) => void, nodeName: string) {
  const conditions = (parameters.conditions ?? {}) as { combinator?: string; conditions?: RawClause[]; options?: { caseSensitive?: boolean } }
  const raw = Array.isArray(conditions.conditions) ? conditions.conditions : []
  // n8n stores case handling once per node (v2 `options.caseSensitive`, plus a
  // node-level `options.ignoreCase` on some versions); ours is per clause.
  const ignoreCase =
    conditions.options?.caseSensitive === false || (parameters.options as { ignoreCase?: boolean } | undefined)?.ignoreCase === true
  const clauses = raw.map((c) => {
    const operation = c.operator?.operation ?? 'equals'
    const op = OPERATION_TO_OP[operation]
    if (!op) warn(`“${nodeName}”: condition operator “${operation}” has no equivalent — imported as “equals”; review it.`)
    return {
      left: tr(String(c.leftValue ?? '')),
      op: op ?? ('eq' as ConditionOp),
      right: tr(String(c.rightValue ?? '')),
      ...(ignoreCase ? { ignoreCase: true } : {}),
    }
  })
  return { clauses, match: conditions.combinator === 'or' ? ('any' as const) : ('all' as const) }
}

function noteText(node: N8nNodeIn): string {
  const heading = `n8n step “${node.name ?? node.type}” (${node.type}) has no native equivalent — replace it with a Tool or HTTP step.`
  const params = node.parameters && Object.keys(node.parameters).length ? `\n\nOriginal parameters:\n${JSON.stringify(node.parameters, null, 2).slice(0, 3000)}` : ''
  return `${heading}${params}`.slice(0, 5000)
}

/** n8n scheduleTrigger rule.interval → our schedule shape (imported paused). */
function scheduleFromRule(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  const interval = ((parameters?.rule as { interval?: Array<Record<string, unknown>> })?.interval ?? [])[0] ?? {}
  const cron = (parameters?.cronExpression ?? interval.expression) as string | undefined
  if (typeof cron === 'string' && cron.trim()) return { type: 'cron', cron, isActive: false }
  const hour = typeof interval.triggerAtHour === 'number' ? interval.triggerAtHour : undefined
  const time = hour !== undefined ? `${String(hour).padStart(2, '0')}:00` : undefined
  const field = String(interval.field ?? 'days')
  const type = field.startsWith('week') ? 'weekly' : field.startsWith('hour') || field.startsWith('minute') ? 'hourly' : field.startsWith('month') ? 'monthly' : 'daily'
  return { type, ...(time ? { time } : {}), isActive: false }
}

const TRIGGER_TYPES: Record<string, 'manual' | 'webhook' | 'schedule'> = {
  'n8n-nodes-base.manualTrigger': 'manual',
  'n8n-nodes-base.webhook': 'webhook',
  'n8n-nodes-base.scheduleTrigger': 'schedule',
  'n8n-nodes-base.cron': 'schedule',
  // A chat trigger is a webhook wearing a chat UI: callers POST { chatInput }.
  '@n8n/n8n-nodes-langchain.chatTrigger': 'webhook',
  // A form trigger is a webhook fed by the submitted fields.
  'n8n-nodes-base.formTrigger': 'webhook',
  // "When executed by another workflow" — a subflow entry point; runs on demand.
  'n8n-nodes-base.executeWorkflowTrigger': 'manual',
}

/**
 * Any *Trigger node not declared above (whatsAppTrigger, telegramTrigger,
 * gmailTrigger, errorTrigger, …) is a provider event source — the closest
 * native shape is a webhook trigger the provider's automation posts to.
 */
function n8nTriggerType(type: string | undefined): 'manual' | 'webhook' | 'schedule' | undefined {
  if (!type) return undefined
  return TRIGGER_TYPES[type] ?? (/Trigger$/.test(type) ? 'webhook' : undefined)
}

/** The n8n AI Agent node — with tool/memory sub-nodes it imports as a real Agent step. */
const AGENT_NODE_TYPE = '@n8n/n8n-nodes-langchain.agent'
/** LangChain classifier chains: one main OUTPUT per category — needs a routing switch. */
const CLASSIFIER_TYPES = new Set(['@n8n/n8n-nodes-langchain.textClassifier', '@n8n/n8n-nodes-langchain.sentimentAnalysis'])

function isLlmType(type: string): boolean {
  return type.startsWith('@n8n/n8n-nodes-langchain.') || /openai|anthropic|chatmodel|\.ai\b/i.test(type)
}

/** n8n `model` parameter: a plain id or a resourceLocator { mode, value }. */
function rawModelName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    const inner = (value as { value?: unknown }).value
    if (typeof inner === 'string' && inner.trim()) return inner.trim()
  }
  return undefined
}

/** googleSheets → "google sheets" — the shape connector keys match on. */
function deCamel(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

function fieldTypeOf(value: unknown): OutputField['type'] {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return 'any'
}

/** Output fields from a structured-parser JSON example ({"state": "CA"} → state:string). */
function fieldsFromJsonExample(example: unknown): OutputField[] {
  if (typeof example !== 'string' || !example.trim()) return []
  try {
    const parsed = JSON.parse(example) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({ name, type: fieldTypeOf(value) }))
  } catch {
    return []
  }
}

/** Output fields from a manual JSON Schema's top-level properties. */
function fieldsFromJsonSchema(schema: unknown): OutputField[] {
  if (typeof schema !== 'string' || !schema.trim()) return []
  try {
    const parsed = JSON.parse(schema) as { properties?: Record<string, { type?: unknown; description?: unknown }> }
    if (!parsed?.properties || typeof parsed.properties !== 'object') return []
    return Object.entries(parsed.properties).map(([name, def]) => ({
      name,
      type: (['string', 'number', 'boolean', 'object', 'array'] as const).includes(def?.type as 'string') ? (def.type as OutputField['type']) : 'any',
      ...(typeof def?.description === 'string' && def.description ? { description: def.description } : {}),
    }))
  } catch {
    return []
  }
}

/** Output fields declared by an ai_outputParser sub-node (structured output parser). */
function fieldsFromOutputParser(parameters: Record<string, unknown>): OutputField[] {
  if (parameters.schemaType === 'manual') return fieldsFromJsonSchema(parameters.inputSchema)
  return fieldsFromJsonExample(parameters.jsonSchemaExample)
}

/** Extract the most prompt-shaped string an LLM node carries. */
function llmInstructions(parameters: Record<string, unknown>, tr: (v: string) => string): string {
  for (const key of ['text', 'prompt', 'systemMessage', 'message', 'content']) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return tr(value)
  }
  return ''
}

/** Map one non-trigger n8n node to a flow node (or null to skip entirely). */
function mapNode(
  node: N8nNodeIn,
  id: string,
  tr: (v: string) => string,
  warn: (msg: string) => void,
  labelToId: Map<string, string>,
  jsonBase: string,
): FlowNode | null {
  const type = node.type ?? ''
  const parameters = node.parameters ?? {}
  const label = node.name?.trim() || undefined
  const name = node.name ?? type

  switch (type) {
    case 'n8n-nodes-base.stickyNote':
      return { id, type: 'note', data: { text: String(parameters.content ?? '').slice(0, 5000) } } as FlowNode
    case 'n8n-nodes-base.noOp':
      // n8n's No-Op passes items through mid-chain — a note would run as
      // output-less annotation and break downstream references to this step
      // ({{step.<id>.output.…}} resolves to nothing). A passthrough code step
      // keeps the data flowing under the same id.
      return {
        id,
        type: 'code',
        data: {
          label,
          language: 'javascript',
          mode: 'all',
          code: `// Imported from n8n No-Op${node.notes ? ` — ${String(node.notes).slice(0, 500).replace(/\n/g, ' ')}` : ''}: passes its input through unchanged.\nreturn input`,
        },
      } as FlowNode
    case 'n8n-nodes-base.httpRequest': {
      const sendBody = parameters.sendBody === true || typeof parameters.jsonBody === 'string'
      const pairs = (source: unknown): Record<string, string> =>
        Object.fromEntries(
          (((source as { parameters?: Array<{ name?: string; value?: unknown }> })?.parameters ?? [])
            .filter((p) => typeof p.name === 'string' && p.name)
            .map((p) => [String(p.name), tr(String(p.value ?? ''))])),
        )
      const method = typeof parameters.method === 'string' ? parameters.method : 'GET'
      const url = tr(String(parameters.url ?? ''))
      const body = sendBody && typeof parameters.jsonBody === 'string' ? tr(parameters.jsonBody) : undefined
      // A raw call to a known provider API binds to the platform's OWN
      // integration tool instead — connection-managed auth beats a hand-pasted
      // header, and the step gets the provider's identity on the canvas.
      const bound = httpIntegrationBindingFor(method, url, body, warn, name)
      if (bound) {
        warn(`“${name}”: bound to the platform's ${bound.label} integration (${bound.toolName}) — its n8n credential is replaced by your connected ${bound.label} account.`)
        return {
          id,
          type: 'tool',
          data: {
            label,
            connectionId: bound.connectionId,
            toolName: bound.toolName,
            args: JSON.stringify(bound.args),
            note: `Imported from an n8n HTTP call to ${url.split('?')[0]}; now runs through the connected ${bound.label} integration.`,
          },
        } as FlowNode
      }
      const query = parameters.sendQuery === true ? pairs(parameters.queryParameters) : {}
      const headers = parameters.sendHeaders === true ? pairs(parameters.headerParameters) : {}
      if (parameters.authentication || node.credentials) {
        warn(`“${name}”: its n8n credential does not transfer — add the auth header (or an MCP connection) on the HTTP step before running.`)
      }
      return {
        id,
        type: 'http',
        data: {
          label,
          method,
          url,
          ...(Object.keys(query).length ? { query: JSON.stringify(query) } : {}),
          ...(Object.keys(headers).length ? { headers: JSON.stringify(headers) } : {}),
          ...(body !== undefined ? { bodyMode: 'json', body } : {}),
        },
      } as FlowNode
    }
    case 'n8n-nodes-base.if': {
      const { clauses, match } = clausesFrom(parameters, tr, warn, name)
      return { id, type: 'condition', data: { label, match, clauses } } as FlowNode
    }
    case 'n8n-nodes-base.filter': {
      const { clauses, match } = clausesFrom(parameters, tr, warn, name)
      return { id, type: 'filter', data: { label, match, clauses } } as FlowNode
    }
    case 'n8n-nodes-base.switch': {
      const rules = ((parameters.rules as { values?: Array<{ conditions?: { conditions?: RawClause[] }; outputKey?: string }> })?.values ?? [])
      const cases = rules.map((rule, index) => {
        const first = rule.conditions?.conditions?.[0]
        if ((rule.conditions?.conditions?.length ?? 0) > 1) {
          warn(`“${name}”: a Switch rule had multiple conditions — only the first was imported.`)
        }
        const operation = first?.operator?.operation ?? 'equals'
        return {
          id: `case-${index}`,
          ...(rule.outputKey ? { label: rule.outputKey } : {}),
          left: tr(String(first?.leftValue ?? '')),
          op: OPERATION_TO_OP[operation] ?? ('eq' as ConditionOp),
          right: tr(String(first?.rightValue ?? '')),
        }
      })
      return { id, type: 'switch', data: { label, cases } } as FlowNode
    }
    case 'n8n-nodes-base.set': {
      const assignments =
        ((parameters.assignments as { assignments?: Array<{ name?: string; value?: unknown; type?: string }> })?.assignments ?? [])
      const entries = assignments.filter((a) => typeof a.name === 'string' && a.name)
      // Assignments carrying real JS ({{ a ? b : c }}, Date.now()) can't run
      // as template fields — but the code sandbox shim executes the ORIGINAL
      // n8n expressions verbatim, so such a Set imports as a Code step.
      if (entries.some((a) => hasUntranslatableJs(a.value, labelToId, jsonBase))) {
        const body = `return {\n${entries.map((a) => `  ${JSON.stringify(String(a.name))}: ${n8nValueToJs(a.value, a.type)},`).join('\n')}\n}`
        warn(`“${name}”: its assignments use JS expressions — imported as a Code step that evaluates the original n8n expressions.`)
        return {
          id,
          type: 'code',
          data: {
            label,
            language: 'javascript',
            mode: 'all',
            input: `{{${jsonBase}}}`,
            code: withN8nCodeShim(
              `// Imported from n8n Set — its assignment expressions run as real JS here.\n${body}`,
              Object.fromEntries(labelToId),
            ),
          },
        } as FlowNode
      }
      const fields = entries.map((a) => ({
        name: String(a.name),
        value: tr(String(a.value ?? '')),
        ...(a.type && (FIELD_TYPES as readonly string[]).includes(String(a.type)) ? { type: a.type as FieldType } : {}),
      }))
      // n8n's "Include Other Input Fields" (v3.3+) / "Keep Only Set" (≤3.2,
      // inverted). Ours is all-or-nothing — selective include modes fall back
      // to all, loudly.
      const includeOthers = parameters.includeOtherFields === true || parameters.keepOnlySet === false
      const include = String(parameters.include ?? 'all')
      if (includeOthers && include !== 'all') {
        warn(`“${name}”: n8n included only SOME other input fields (“${include}”) — imported including ALL of them; trim downstream if needed.`)
      }
      return {
        id,
        type: 'transform',
        data: { label, fields, ...(includeOthers ? { includeOtherFields: true } : {}) },
      } as FlowNode
    }
    case 'n8n-nodes-base.code': {
      const python = String(parameters.language ?? '').toLowerCase().includes('python')
      let original = String((python ? parameters.pythonCode : parameters.jsCode) ?? parameters.jsCode ?? parameters.pythonCode ?? '')
      // Embedded binary assets (base64 data URIs) can push a code node past
      // our 100K cap and sink the whole import — strip them to placeholders
      // (the code structure survives; the assets should live outside code).
      const stripped = original.replace(/(["'`])(data:[^"'`\\]{500,})\1/g, '$1data:asset-removed-on-import$1')
      if (stripped !== original) {
        warn(`“${name}”: large embedded data-URI asset(s) were removed on import (they exceeded the code size limit) — host them externally and reference by URL.`)
        original = stripped
      }
      if (original.length > 95_000) {
        warn(`“${name}”: code exceeds the 100K limit even after asset removal — truncated; the step will need repair.`)
        original = `${original.slice(0, 95_000)}\n// [truncated on import — code exceeded the 100K limit]`
      }
      if (python && /\$input|\$json|_\(/.test(original)) {
        warn(`“${name}”: Python code using the n8n runtime API imported as-is — review it (the JS compatibility shim doesn’t apply to Python).`)
      }
      return {
        id,
        type: 'code',
        data: {
          label,
          language: python ? 'python' : 'javascript',
          mode: parameters.mode === 'runOnceForEachItem' ? 'each' : 'all',
          // JS gets the n8n runtime shim so $('Node'), $input, $json and
          // [{json}] returns work unchanged in our sandbox.
          code: python ? original : withN8nCodeShim(original, Object.fromEntries(labelToId)),
        },
      } as FlowNode
    }
    case 'n8n-nodes-base.merge': {
      const mode = String(parameters.mode ?? 'append')
      if (mode === 'combine' || mode === 'mergeByKey' || mode === 'mergeByIndex') {
        const combineBy = mode === 'mergeByIndex' ? 'combineByPosition' : String(parameters.combineBy ?? 'combineByFields')
        if (combineBy === 'combineByFields') {
          const fieldSpec =
            String(parameters.fieldsToMatchString ?? '').trim() ||
            String(
              ((parameters.mergeByFields as { values?: Array<{ field1?: unknown }> })?.values?.[0]?.field1 ?? parameters.propertyName1 ?? ''),
            ).trim()
          const key = fieldSpec.split(',')[0]?.trim() ?? ''
          if (fieldSpec.includes(',')) {
            warn(`“${name}”: Merge matched on several fields — imported matching on “${key}” only.`)
          }
          const joinMode = String(parameters.joinMode ?? 'keepMatches')
          if (joinMode !== 'keepMatches' && joinMode !== 'keepEverything') {
            warn(`“${name}”: Merge output mode “${joinMode}” has no equivalent — imported as a full join by key; review it.`)
          }
          return {
            id,
            type: 'join',
            data: { label, mode: 'combineByKey', ...(key ? { key } : {}), ...(joinMode === 'keepEverything' ? { includeUnpaired: true } : {}) },
          } as FlowNode
        }
        if (combineBy === 'combineByPosition') {
          return { id, type: 'join', data: { label, mode: 'combineByPosition' } } as FlowNode
        }
        if (combineBy === 'combineAll') {
          return { id, type: 'join', data: { label, mode: 'allCombinations' } } as FlowNode
        }
      }
      if (mode === 'combineBySql' || mode === 'chooseBranch') {
        warn(`“${name}”: Merge mode “${mode}” has no equivalent — imported as append; review it.`)
      }
      return { id, type: 'join', data: { label, mode: 'append' } } as FlowNode
    }
    case 'n8n-nodes-base.respondToWebhook':
      // The webhook trigger's default response mode replies with the run's
      // result — a named `output` step makes this node's payload BE that result.
      return {
        id,
        type: 'output',
        data: { label, outputs: [{ name: 'response', value: tr(String(parameters.responseBody ?? '')) }] },
      } as FlowNode
    case 'n8n-nodes-base.wait': {
      if (parameters.resume === 'webhook') return { id, type: 'wait', data: { label, mode: 'webhook' } } as FlowNode
      if (parameters.resume === 'specificTime') {
        return { id, type: 'wait', data: { label, mode: 'until', until: tr(String(parameters.dateTime ?? '')) } } as FlowNode
      }
      const unit = String(parameters.unit ?? 'minutes')
      return {
        id,
        type: 'wait',
        data: {
          label,
          mode: 'duration',
          amount: String(parameters.amount ?? '1'),
          unit: (['seconds', 'minutes', 'hours', 'days'] as const).includes(unit as 'minutes') ? (unit as 'minutes') : 'minutes',
        },
      } as FlowNode
    }
    case 'n8n-nodes-base.splitInBatches':
      // Only reached when the loop branch is EMPTY (loops with a body import
      // as native Loop steps in the main pass).
      warn(`“${name}”: a Loop Over Items with no body steps — imported as a note; add a Loop step if you rebuild it.`)
      return { id, type: 'note', data: { text: noteText(node) } } as FlowNode
    case 'n8n-nodes-base.extractFromFile': {
      // Files flow through Backstory as references carrying pre-extracted text
      // (`.content` for text/CSV/JSON/PDF) — extraction is reading + parsing it.
      const operation = String(parameters.operation ?? 'text')
      const parseTail =
        operation === 'fromJson'
          ? 'return JSON.parse(text)'
          : operation === 'csv'
            ? `const lines = text.split(/\\r?\\n/).filter((l) => l.trim())
const parseLine = (line) => { const out = []; let cur = ''; let q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += ch } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = '' } else cur += ch } out.push(cur); return out }
const header = parseLine(lines[0] || '')
return lines.slice(1).map((l) => { const cells = parseLine(l); return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])) })`
            : 'return { data: text, filename: ref ? ref.filename : undefined }'
      if (['xls', 'xlsx', 'ods', 'binaryToPropery'].includes(operation)) {
        warn(`“${name}”: spreadsheet/binary extraction (${operation}) can't run in the flow sandbox — the step passes the file reference through; convert the file to CSV upstream.`)
        return { id, type: 'code', data: { label, language: 'javascript', mode: 'all', code: `// Imported from n8n Extract From File (${operation}) — spreadsheet/binary\n// extraction is not available in the sandbox; the file reference passes through.\nreturn input` } } as FlowNode
      }
      return {
        id,
        type: 'code',
        data: {
          label,
          language: 'javascript',
          mode: 'all',
          code: `// Imported from n8n Extract From File (${operation}): reads the incoming
// file reference's extracted text and parses it.
const ref = input && typeof input === 'object' && typeof input.fileId === 'string'
  ? input
  : input && typeof input === 'object'
    ? Object.values(input).find((v) => v && typeof v === 'object' && typeof v.fileId === 'string')
    : null
const text = ref && typeof ref.content === 'string' ? ref.content : typeof input === 'string' ? input : null
if (text == null) return input // nothing extractable — pass the value through
${parseTail}`,
        },
      } as FlowNode
    }
    case 'n8n-nodes-base.convertToFile': {
      const operation = String(parameters.operation ?? 'toText')
      const options = (parameters.options ?? {}) as { fileName?: unknown }
      const fileName = typeof options.fileName === 'string' && options.fileName ? options.fileName : undefined
      const sourceProperty =
        typeof parameters.sourceProperty === 'string' && parameters.sourceProperty ? parameters.sourceProperty : undefined
      // A dynamic n8n fileName (`={{ $json.account }}_report.html`) becomes a
      // JS template literal over the current item's fields.
      const fileNameJs = (fallback: string): string => {
        if (!fileName) return JSON.stringify(fallback)
        if (!fileName.startsWith('=')) return JSON.stringify(fileName)
        const raw = fileName.slice(1)
        const parts: string[] = []
        let last = 0
        for (const match of raw.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)) {
          parts.push(escapeForTemplateLiteral(raw.slice(last, match.index)))
          const expr = match[1].trim()
          const jsonPath = expr.match(/^\$json\.([\w$.]+)$/)
          parts.push('${' + (jsonPath ? `json.${jsonPath[1]}` : expr) + '}')
          last = match.index + match[0].length
        }
        parts.push(escapeForTemplateLiteral(raw.slice(last)))
        return '`' + parts.join('') + '`'
      }
      // toText (and toJson in 'each' mode) makes one file PER ITEM — n8n keeps
      // the item's json fields alongside the binary, so spreading them lets
      // downstream steps keep referencing item fields. toJson's default mode
      // and csv aggregate everything into one file.
      const perItemFile = (mimeType: string, defaultName: string, contentExpr: string): string => `const list = Array.isArray(input) ? input : [input]
const files = list.map((item) => {
  const json = item && typeof item === 'object' ? item : {}
  const content = ${contentExpr}
  return { ...json, filename: ${fileNameJs(defaultName)}, mimeType: ${JSON.stringify(mimeType)}, content }
})
return Array.isArray(input) ? files : files[0]`
      const body =
        operation === 'toJson'
          ? parameters.mode === 'each'
            ? perItemFile(
                'application/json',
                'data.json',
                sourceProperty ? `JSON.stringify(json[${JSON.stringify(sourceProperty)}] ?? null, null, 2)` : 'JSON.stringify(json, null, 2)',
              )
            : `const json = (Array.isArray(input) ? input[0] : input) ?? {}
return { filename: ${fileNameJs('data.json')}, mimeType: 'application/json', content: JSON.stringify(input, null, 2) }`
          : operation === 'csv'
            ? `const rows = Array.isArray(input) ? input : [input]
const keys = Array.from(new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : []))))
const cell = (v) => { const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
const lines = [keys.join(',')].concat(rows.map((r) => keys.map((k) => cell(r && typeof r === 'object' ? r[k] : undefined)).join(',')))
const json = rows[0] && typeof rows[0] === 'object' ? rows[0] : {}
return { filename: ${fileNameJs('data.csv')}, mimeType: 'text/csv', content: lines.join('\\n') }`
            : operation === 'toText'
              ? perItemFile(
                  'text/plain',
                  'data.txt',
                  sourceProperty
                    ? `String(json[${JSON.stringify(sourceProperty)}] ?? '')`
                    : `typeof item === 'string' ? item : JSON.stringify(item, null, 2)`,
                )
              : null
      if (!body) {
        warn(`“${name}”: Convert to File (${operation}) has no sandbox equivalent — the step passes its input through; use CSV/JSON/text conversion instead.`)
        return { id, type: 'code', data: { label, language: 'javascript', mode: 'all', code: `// Imported from n8n Convert to File (${operation}) — this format can't be\n// produced in the sandbox; the input passes through unchanged.\nreturn input` } } as FlowNode
      }
      return {
        id,
        type: 'code',
        data: {
          label,
          language: 'javascript',
          mode: 'all',
          code: `// Imported from n8n Convert to File (${operation}): produces a file-shaped
// object ({ filename, mimeType, content }) downstream steps can template.
${body}`,
        },
      } as FlowNode
    }
    case 'n8n-nodes-base.stopAndError': {
      const reason =
        parameters.errorType === 'errorObject'
          ? String(parameters.errorObject ?? 'Stopped with an error (imported from n8n).')
          : String(parameters.errorMessage ?? 'Stopped with an error (imported from n8n).')
      return { id, type: 'stop', data: { label, reason: tr(reason) } } as FlowNode
    }
    case 'n8n-nodes-base.executeWorkflow': {
      warn(`“${name}”: calls another n8n workflow — import that workflow as a flow too, then pick it on this Subflow step.`)
      return { id, type: 'subflow', data: { flowId: '', input: `{{${jsonBase}}}` } } as FlowNode
    }
    // ——— LangChain chains → native ai steps shaped by op ———
    case '@n8n/n8n-nodes-langchain.chainLlm': {
      const messages = ((parameters.messages as { messageValues?: Array<{ message?: unknown }> })?.messageValues ?? [])
        .map((m) => tr(String(m.message ?? '')).trim())
        .filter(Boolean)
        .join('\n\n')
      const text = typeof parameters.text === 'string' && parameters.text.trim() ? tr(parameters.text) : `{{${jsonBase}}}`
      return { id, type: 'ai', data: { label, aiOp: 'ask', input: text, ...(messages ? { instructions: messages } : {}) } } as FlowNode
    }
    case '@n8n/n8n-nodes-langchain.chainSummarization':
      return { id, type: 'ai', data: { label, aiOp: 'summarize', input: `{{${jsonBase}}}` } } as FlowNode
    case '@n8n/n8n-nodes-langchain.informationExtractor': {
      const attributes = ((parameters.attributes as { attributes?: Array<{ name?: string; type?: string; description?: string }> })?.attributes ?? [])
        .filter((a) => typeof a.name === 'string' && a.name)
        .map((a) => ({
          name: String(a.name),
          // n8n attribute types are string/number/boolean/date — date has no
          // slot in our field types, so it reads back as a string.
          type: (['string', 'number', 'boolean'] as const).includes(a.type as 'string') ? (a.type as OutputField['type']) : 'string',
          ...(a.description ? { description: a.description } : {}),
        }))
      const outputFields = attributes.length ? attributes : fieldsFromOutputParser(parameters)
      const input = typeof parameters.text === 'string' && parameters.text.trim() ? tr(parameters.text) : `{{${jsonBase}}}`
      return { id, type: 'ai', data: { label, aiOp: 'extract', input, ...(outputFields.length ? { outputFields } : {}) } } as FlowNode
    }
    case '@n8n/n8n-nodes-langchain.textClassifier': {
      const categories = ((parameters.categories as { categories?: Array<{ category?: string; description?: string }> })?.categories ?? [])
        .filter((c) => typeof c.category === 'string' && c.category)
      const input = typeof parameters.inputText === 'string' && parameters.inputText.trim() ? tr(parameters.inputText) : `{{${jsonBase}}}`
      const guidance = categories
        .filter((c) => c.description)
        .map((c) => `${c.category}: ${c.description}`)
        .join('\n')
      if ((parameters.options as { multiClass?: unknown })?.multiClass === true) {
        warn(`“${name}”: n8n allowed multiple classes per item — the imported step picks exactly one category.`)
      }
      return {
        id,
        type: 'ai',
        data: { label, aiOp: 'categorize', input, categories: categories.map((c) => String(c.category)), ...(guidance ? { instructions: guidance } : {}) },
      } as FlowNode
    }
    case '@n8n/n8n-nodes-langchain.sentimentAnalysis': {
      const raw = String((parameters.options as { categories?: unknown })?.categories ?? 'Positive, Neutral, Negative')
      const categories = raw.split(',').map((c) => c.trim()).filter(Boolean)
      const input = typeof parameters.inputText === 'string' && parameters.inputText.trim() ? tr(parameters.inputText) : `{{${jsonBase}}}`
      return { id, type: 'ai', data: { label, aiOp: 'categorize', input, categories } } as FlowNode
    }
    // A model-only Agent (no tool/memory sub-nodes — those import as real
    // Agent steps upstream of this switch) is just an LLM call.
    case AGENT_NODE_TYPE: {
      const systemMessage = String((parameters.options as { systemMessage?: unknown })?.systemMessage ?? '').trim()
      const input = typeof parameters.text === 'string' && parameters.text.trim() ? tr(parameters.text) : `{{${jsonBase}}}`
      warn(`“${name}”: an AI Agent with no tools imported as a native AI step running on Backstory models — review its instructions.`)
      return { id, type: 'ai', data: { label, aiOp: 'ask', input, ...(systemMessage ? { instructions: tr(systemMessage) } : {}) } } as FlowNode
    }
    // Pure data utilities → native data ops (config differs, so each warns to
    // review its settings; `input` reads the upstream so the op has data).
    case 'n8n-nodes-base.sort':
    case 'n8n-nodes-base.limit':
    case 'n8n-nodes-base.removeDuplicates':
    case 'n8n-nodes-base.aggregate':
    case 'n8n-nodes-base.summarize':
    case 'n8n-nodes-base.splitOut': {
      if (type === 'n8n-nodes-base.splitOut') {
        // Split Out translates faithfully: the field to split becomes the
        // flatten op's field, and each element carries the other fields along.
        const field = typeof parameters.fieldToSplitOut === 'string' ? parameters.fieldToSplitOut.trim() : ''
        return { id, type: 'data', data: { label, op: 'flatten', input: `{{${jsonBase}}}`, ...(field ? { by: field } : {}) } } as FlowNode
      }
      const op = type.split('.').pop() as 'sort' | 'limit' | 'removeDuplicates' | 'aggregate' | 'summarize'
      warn(`“${name}”: imported as a native “${op}” data step — its settings don't transfer 1:1; review them.`)
      return { id, type: 'data', data: { label, op, input: `{{${jsonBase}}}` } } as FlowNode
    }
    // Date & Time → the native date ops. n8n's operations map 1:1 where one
    // exists; anything else falls back to a format step with a warning.
    case 'n8n-nodes-base.dateTime': {
      const operation = String(parameters.operation ?? 'formatDate')
      const dateInput = typeof parameters.date === 'string' && parameters.date.trim() ? tr(parameters.date) : `{{${jsonBase}}}`
      const unit = String(parameters.timeUnit ?? parameters.units ?? 'days')
      if (operation === 'addToDate' || operation === 'subtractFromDate') {
        const magnitude = String(parameters.duration ?? parameters.value ?? '1')
        const amount = operation === 'subtractFromDate' && !magnitude.startsWith('-') ? `-${magnitude}` : magnitude
        return { id, type: 'data', data: { label, op: 'dateShift', input: dateInput, amount: tr(amount), unit } } as FlowNode
      }
      if (operation === 'getTimeBetweenDates') {
        const start = typeof parameters.startDate === 'string' && parameters.startDate.trim() ? tr(parameters.startDate) : `{{${jsonBase}}}`
        const end = typeof parameters.endDate === 'string' && parameters.endDate.trim() ? tr(parameters.endDate) : `{{${jsonBase}}}`
        return { id, type: 'data', data: { label, op: 'dateDiff', input: start, to: end, unit } } as FlowNode
      }
      if (operation === 'extractDate') {
        const part = String(parameters.part ?? 'date')
        return { id, type: 'data', data: { label, op: 'datePart', input: dateInput, part } } as FlowNode
      }
      if (operation !== 'formatDate' && operation !== 'getCurrentDate') {
        warn(`“${name}”: the “${operation}” date operation has no direct equivalent — imported as a date format step; review it.`)
      }
      const format = typeof parameters.format === 'string' && /^[YMDHms\s:./-]+$/.test(parameters.format) ? parameters.format : undefined
      return { id, type: 'data', data: { label, op: 'formatDate', input: operation === 'getCurrentDate' ? '{{now}}' : dateInput, ...(format ? { format } : {}) } } as FlowNode
    }
    // Rename Keys → the renameKeys op; each n8n pair maps to a rename row.
    case 'n8n-nodes-base.renameKeys': {
      const pairs = ((parameters.keys as { key?: unknown[] })?.key ?? [])
        .filter((entry): entry is { currentKey?: unknown; newKey?: unknown } => Boolean(entry && typeof entry === 'object'))
        .map((entry) => ({ name: String(entry.currentKey ?? ''), value: String(entry.newKey ?? '') }))
        .filter((entry) => entry.name && entry.value)
      if (!pairs.length) warn(`“${name}”: no key pairs found — open the step and add the renames.`)
      return { id, type: 'data', data: { label, op: 'renameKeys', input: `{{${jsonBase}}}`, fields: pairs } } as FlowNode
    }
    // Markdown ⇄ HTML → the two conversion ops.
    case 'n8n-nodes-base.markdown': {
      const toHtml = String(parameters.mode ?? 'markdownToHtml') === 'markdownToHtml'
      const source = toHtml ? parameters.markdown : parameters.html
      const input = typeof source === 'string' && source.trim() ? tr(source) : `{{${jsonBase}}}`
      return { id, type: 'data', data: { label, op: toHtml ? 'markdownToHtml' : 'htmlToMarkdown', input } } as FlowNode
    }
    // XML ⇄ JSON → parse/build ops.
    case 'n8n-nodes-base.xml': {
      const toJson = String(parameters.mode ?? 'xmlToJson') === 'xmlToJson'
      return { id, type: 'data', data: { label, op: toJson ? 'xmlParse' : 'xmlBuild', input: `{{${jsonBase}}}` } } as FlowNode
    }
    default: {
      // MAIN-chain vector store nodes: a query ("load") is a Knowledge search;
      // ingestion ("insert"/"update") belongs in Knowledge uploads, not a flow.
      if (type.startsWith('@n8n/n8n-nodes-langchain.vectorStore')) {
        const mode = String(parameters.mode ?? 'load')
        if (mode === 'load' || mode === 'retrieve') {
          const query = typeof parameters.prompt === 'string' && parameters.prompt.trim() ? tr(parameters.prompt) : typeof parameters.query === 'string' && parameters.query.trim() ? tr(parameters.query) : `{{${jsonBase}}}`
          const rawTopK = Number(parameters.topK ?? parameters.limit ?? 5)
          warn(`“${name}”: imported as a Knowledge search — upload the documents it queried under Knowledge so the search has content.`)
          return { id, type: 'knowledge', data: { label, query, topK: Number.isFinite(rawTopK) ? Math.min(20, Math.max(1, Math.floor(rawTopK))) : 5 } } as FlowNode
        }
        warn(`“${name}”: vector-store ingestion (${mode}) doesn't run inside flows — upload these documents under Knowledge instead; the step passes its input through.`)
        return {
          id,
          type: 'code',
          data: { label, language: 'javascript', mode: 'all', code: `// Imported from n8n ${type} (${mode} mode) — document ingestion lives in\n// Backstory Knowledge (upload the documents there); this step passes through.\nreturn input` },
        } as FlowNode
      }
      // A MAIN-chain MCP client node is a TOOL CALL (it names the tool it
      // invokes), not an LLM — it must win over the generic LangChain check.
      if (type.endsWith('.mcpClient')) {
        const toolName = String((parameters.tool as { value?: unknown })?.value ?? 'mcp-tool')
        const endpoint = String(parameters.endpointUrl ?? '')
        // The platform's OWN MCP plane (Backstory / People.ai Sales AI) needs
        // no per-org connection pick — bind it outright.
        const isBackstory = /(^|\.)(people\.ai|backstory\.ai)\//.test(`${endpoint}/`) || /mcp\.(people|backstory)\./.test(endpoint)
        if (isBackstory) {
          warn(`“${name}”: bound to the platform's Backstory (Sales AI) tools — calls “${toolName}” natively.`)
        } else {
          warn(`“${name}”: imported as a Tool step calling “${toolName}” — open it and pick your MCP connection.`)
        }
        return {
          id,
          type: 'tool',
          data: {
            label,
            connectionId: isBackstory ? 'people_ai:backstory' : '',
            toolName,
            args: JSON.stringify((parameters.parameters as { value?: unknown })?.value ?? {}),
            note: isBackstory
              ? `Imported from n8n MCP client (${endpoint}); runs on the platform's own Sales AI tools.`
              : `Imported from n8n MCP client (endpoint ${endpoint || 'unknown'}). Pick the matching MCP connection.`,
          },
        } as FlowNode
      }
      if (isLlmType(type)) {
        warn(`“${name}”: imported as a native AI step running on Backstory models — review its instructions.`)
        return { id, type: 'ai', data: { label, aiOp: 'ask', instructions: llmInstructions(parameters, tr) } } as FlowNode
      }
      // Known app node → prefer the platform's OWN integration capability over
      // an unbound stub: the step arrives bound and runnable.
      const binding = integrationBindingFor(type, parameters, tr)
      if (binding && 'connectionId' in binding) {
        warn(`“${name}”: bound to the platform's ${binding.label} integration (${binding.toolName}) — confirm the ${binding.label} connection under Integrations.`)
        if (binding.warning) warn(`“${name}”: ${binding.warning}`)
        return {
          id,
          type: 'tool',
          data: {
            label,
            connectionId: binding.connectionId,
            toolName: binding.toolName,
            args: JSON.stringify(binding.args),
            note: [`Imported from n8n (${type}); runs through the connected ${binding.label} integration.`, binding.note]
              .filter(Boolean)
              .join(' '),
          },
        } as FlowNode
      }
      if (binding && 'missing' in binding) {
        // No integration covers this capability — import it as a direct API
        // REQUEST to the provider instead: an http step with the endpoint
        // prefilled, configured like any API call (method/url/body/auth), and
        // visually distinct from integration-backed steps (no company logo).
        const trAny = (value: unknown) => {
          const text = String(value ?? '')
          return tr(text.startsWith('=') || !text.includes('{{') ? text : `=${text}`)
        }
        const skeleton = ((): { method: 'GET' | 'POST'; url: string; body?: string; bodyMode?: 'json' | 'text'; hint: string } => {
          if (type === 'n8n-nodes-base.snowflake') {
            return {
              method: 'POST',
              url: 'https://YOUR_ACCOUNT.snowflakecomputing.com/api/v2/statements',
              body: JSON.stringify({ statement: trAny(parameters.query), timeout: 60 }),
              hint: 'set your account host and add a key-pair JWT or OAuth token under Auth',
            }
          }
          if (type === 'n8n-nodes-base.googleDrive') {
            return {
              method: 'POST',
              url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media',
              body: `{{${jsonBase}.content}}`,
              bodyMode: 'text',
              hint: 'add a Google OAuth token under Auth; media upload sends the content only — set the filename/folder with a follow-up PATCH to /drive/v3/files/{id}, or use the multipart endpoint',
            }
          }
          const API_BASES: Record<string, string> = {
            'n8n-nodes-base.slack': 'https://slack.com/api/',
            'n8n-nodes-base.gmail': 'https://gmail.googleapis.com/gmail/v1/users/me/',
            'n8n-nodes-base.googleSheets': 'https://sheets.googleapis.com/v4/spreadsheets',
            'n8n-nodes-base.salesforce': 'https://YOUR_DOMAIN.my.salesforce.com/services/data/v61.0/',
          }
          const params = Object.fromEntries(
            Object.entries(parameters)
              .filter(([key]) => key !== 'options' && key !== 'authentication' && key !== 'genericAuthType')
              .map(([key, value]) => [key, typeof value === 'string' ? trAny(value) : value]),
          )
          return {
            method: 'POST',
            url: API_BASES[type] ?? 'https://',
            body: JSON.stringify(params),
            hint: 'finish the endpoint path and add authentication; the original n8n parameters are in the body',
          }
        })()
        warn(
          `“${name}”: the platform's integrations don't cover ${binding.missing} — imported as a direct API request (${skeleton.hint}).`,
        )
        return {
          id,
          type: 'http',
          data: {
            label,
            method: skeleton.method,
            url: skeleton.url,
            ...(skeleton.body !== undefined ? { bodyMode: skeleton.bodyMode ?? ('json' as const), body: skeleton.body } : {}),
            note: `Imported from n8n (${type}) as a direct API request — the platform's integrations don't cover ${binding.missing} yet.`,
          },
        } as FlowNode
      }
      // App/action node (talks to an external service — n8n stores its
      // credential binding on the node): import as an UNBOUND Tool step so the
      // canvas keeps a real, configurable step in place — the builder guides
      // the connection pick, and the translated parameters ride along as args.
      if (node.credentials && Object.keys(node.credentials).length > 0) {
        const app = type.split('.').pop() ?? type
        const operation = typeof parameters.operation === 'string' && parameters.operation ? `.${parameters.operation}` : ''
        const translatedParams = Object.fromEntries(
          Object.entries(parameters)
            .filter(([key]) => key !== 'options' && key !== 'authentication' && key !== 'genericAuthType')
            // Braces in a non-`=` value are literal to n8n, but OUR template
            // resolver would still try (and fail) to resolve them — translate
            // them too, which is also what the author almost always meant.
            .map(([key, value]) => [
              key,
              typeof value === 'string' ? tr(value.startsWith('=') || !value.includes('{{') ? value : `=${value}`) : value,
            ]),
        )
        // The n8n credential TYPE name (slackOAuth2Api, notionApi, …) is a
        // reliable provider signal even when the node type has no mapping —
        // bind the step to the matching connected integration.
        const provider = Object.keys(node.credentials)
          .map((credentialType) => CREDENTIAL_TYPE_PROVIDERS[credentialType])
          .find(Boolean)
        if (provider) {
          warn(
            `“${name}” (${app}) imported bound to your ${provider.label} integration via its n8n credential — open it and pick the matching ${provider.label} tool; its n8n parameters are preserved in Args.`,
          )
        } else {
          warn(`“${name}” (${app}) imported as a Tool step without a connection — open it and pick the matching integration; its n8n parameters are preserved in Args.`)
        }
        return {
          id,
          type: 'tool',
          data: {
            label,
            connectionId: provider ? `nango:${provider.key}` : '',
            toolName: `${app}${operation}`,
            args: JSON.stringify(translatedParams),
            note: provider
              ? `Imported from n8n (${type}); its n8n credential maps to the connected ${provider.label} integration — pick the matching tool.`
              : `Imported from n8n (${type}). Pick your connected integration and the matching tool; the original parameters are in Args.`,
          },
        } as FlowNode
      }
      // Credential-less utility with no mapping: a runnable passthrough stub
      // keeps the chain executing end-to-end (a dead note would not).
      warn(`“${name}” (${type}) has no native equivalent — imported as a passthrough Code step (it currently just forwards its input); implement or replace it.`)
      return {
        id,
        type: 'code',
        data: {
          label,
          language: 'javascript',
          mode: 'all',
          code: `// TODO (imported from n8n ${type}): this step is a PASSTHROUGH stub.\n// Original parameters:\n// ${JSON.stringify(parameters).slice(0, 1500)}\nreturn input`,
        },
      } as FlowNode
    }
  }
}

/**
 * Map a user-pasted URL to the actual JSON endpoint. n8n.io template PAGES
 * (https://n8n.io/workflows/<id>-<slug>) serve HTML; the workflow JSON lives
 * on the public template API. Anything else is fetched as-is.
 */
export function resolveN8nImportUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.hostname === 'n8n.io' || url.hostname === 'www.n8n.io') {
      const match = url.pathname.match(/^\/workflows\/(\d+)/)
      if (match) return `https://api.n8n.io/api/templates/workflows/${match[1]}`
    }
  } catch {
    /* not a URL — the caller validates */
  }
  return raw
}

/** Unwrap template-API / nested payloads ({workflow: {...}}) to the workflow itself. */
export function unwrapN8nPayload(payload: unknown): unknown {
  let current = payload
  for (let depth = 0; depth < 3; depth++) {
    if (looksLikeN8nWorkflow(current)) return current
    const wrapped = (current as { workflow?: unknown } | null)?.workflow
    if (wrapped === undefined) return payload
    current = wrapped
  }
  return looksLikeN8nWorkflow(current) ? current : payload
}

export function n8nToFlow(input: unknown): N8nImportResult {
  const workflow = (input ?? {}) as N8nWorkflowIn
  const sourceNodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  if (sourceNodes.length === 0) throw new Error('This n8n file has no nodes to import.')
  const warnings: string[] = []
  const warn = (msg: string) => warnings.push(msg)

  // Name → id map for connections and expression translation. The FIRST
  // trigger-typed node must get the literal id "trigger" — flow validation
  // requires exactly that id — so reserve it up front.
  const firstTrigger = sourceNodes.find((node) => n8nTriggerType(node.type))
  const usedIds = new Set<string>(['trigger'])
  const idByName = new Map<string, string>()
  for (const [index, node] of sourceNodes.entries()) {
    if (node === firstTrigger) {
      if (node.name) idByName.set(node.name, 'trigger')
      continue
    }
    let id = node.id ?? `n8n-${index}`
    while (usedIds.has(id)) id = `${id}-${index}`
    usedIds.add(id)
    if (node.name) idByName.set(node.name, id)
  }
  const idOf = (node: N8nNodeIn, index: number) =>
    node === firstTrigger ? 'trigger' : (node.name && idByName.get(node.name)) || node.id || `n8n-${index}`

  // LangChain SUB-nodes (chat models, tool/memory/parser providers) hang off
  // the agent via non-`main` connection types (ai_languageModel, ai_tool, …).
  // They are the agent's CONFIGURATION, not steps — importing them as steps
  // produced floating empty nodes wired to the trigger. Absorb them instead.
  const subNodeNames = new Set<string>()
  for (const [sourceName, conn] of Object.entries(workflow.connections ?? {})) {
    const types = Object.keys(conn ?? {})
    if (types.length > 0 && types.every((t) => t !== 'main')) subNodeNames.add(sourceName)
  }

  // Who consumes each sub-node, and over which port (ai_tool, ai_languageModel,
  // ai_memory, ai_outputParser) — the raw material for agent-cluster specs.
  const nodeByName = new Map(sourceNodes.filter((n) => n.name).map((n) => [n.name as string, n]))
  const subsByTarget = new Map<string, Array<{ node: N8nNodeIn; connType: string }>>()
  const subTargetOf = new Map<string, string>()
  for (const [sourceName, conn] of Object.entries(workflow.connections ?? {})) {
    for (const [connType, outputs] of Object.entries(conn ?? {})) {
      if (connType === 'main') continue
      const sub = nodeByName.get(sourceName)
      if (!sub) continue
      for (const targets of outputs ?? []) {
        for (const target of targets ?? []) {
          if (!target?.node) continue
          const list = subsByTarget.get(target.node) ?? []
          list.push({ node: sub, connType })
          subsByTarget.set(target.node, list)
          if (!subTargetOf.has(sourceName)) subTargetOf.set(sourceName, target.node)
        }
      }
    }
  }

  // n8n Loop Over Items (splitInBatches): output 0 = "done" (after the loop),
  // output 1 = "loop" (the body), and the body's last node connects BACK to
  // the splitInBatches node. Walk the loop output to collect the body members
  // — they become a native Loop step's `body` id list instead of dropped edges.
  const loopBodyByName = new Map<string, string[]>()
  const bodyMemberNames = new Set<string>()
  const bodyStartNames = new Set<string>()
  for (const node of sourceNodes) {
    if (node.type !== 'n8n-nodes-base.splitInBatches' || !node.name) continue
    const starts = (workflow.connections?.[node.name]?.main?.[1] ?? [])
      .map((target) => target?.node)
      .filter((n): n is string => Boolean(n))
    const members: string[] = []
    const queue = [...starts]
    const seen = new Set<string>([node.name])
    while (queue.length) {
      const current = queue.shift()!
      if (seen.has(current) || !nodeByName.has(current)) continue
      seen.add(current)
      members.push(current)
      const outputs = workflow.connections?.[current]?.main ?? []
      // A nested Loop Over Items owns its own loop branch — walk only its
      // "done" output for the OUTER body.
      const walkable = nodeByName.get(current)?.type === 'n8n-nodes-base.splitInBatches' ? [outputs[0]] : outputs
      for (const targets of walkable) {
        for (const target of targets ?? []) {
          if (target?.node && target.node !== node.name) queue.push(target.node)
        }
      }
    }
    if (members.length === 0) continue
    starts.forEach((start) => bodyStartNames.add(start))
    members.forEach((member) => bodyMemberNames.add(member))
    loopBodyByName.set(node.name, members)
  }

  // What `$json` means per node: the direct upstream on the MAIN chain. The
  // loop back-edge (body → splitInBatches) is NOT a parent — without the guard
  // it can shadow the loop's real upstream when it appears first in the file.
  const parentByName = new Map<string, string>()
  for (const [sourceName, conn] of Object.entries(workflow.connections ?? {})) {
    for (const targets of conn?.main ?? []) {
      for (const target of targets ?? []) {
        if (!target?.node || parentByName.has(target.node)) continue
        if (bodyMemberNames.has(sourceName) && nodeByName.get(target.node)?.type === 'n8n-nodes-base.splitInBatches') continue
        parentByName.set(target.node, sourceName)
      }
    }
  }
  const triggerNames = new Set(sourceNodes.filter((n) => n8nTriggerType(n.type)).map((n) => n.name ?? ''))

  // n8n's IF/Switch/Filter route items without reshaping them — $json inside a
  // node downstream of a branch reads the nearest DATA-producing ancestor, not
  // the branch node (whose output here is the branch decision, not the items).
  const PASS_THROUGH_TYPES = new Set(['n8n-nodes-base.if', 'n8n-nodes-base.switch', 'n8n-nodes-base.filter'])
  const dataParentOf = (nodeName: string): string | undefined => {
    let current = parentByName.get(nodeName)
    for (let hops = 0; current && PASS_THROUGH_TYPES.has(nodeByName.get(current)?.type ?? '') && hops < 50; hops++) {
      current = parentByName.get(current)
    }
    return current
  }

  // n8n executes EVERY node once per incoming item; our HTTP/tool/agent steps
  // run once. When such a step's data-parent produces an item LIST (a code
  // node — n8n code returns items —, splitOut, a file conversion), enable
  // per-item on it: its $json references translate to {{item.…}} and the step
  // fans out over the upstream list exactly as n8n did.
  const ITEM_PRODUCING_TYPES = new Set([
    'n8n-nodes-base.code',
    'n8n-nodes-base.splitOut',
    'n8n-nodes-base.convertToFile',
    'n8n-nodes-base.extractFromFile',
  ])
  const isItemProducing = (name: string | undefined, depth = 0): boolean => {
    if (!name || depth > 50) return false
    const type = nodeByName.get(name)?.type ?? ''
    // A No-Op passes its parent's items through unchanged.
    if (type === 'n8n-nodes-base.noOp') return isItemProducing(dataParentOf(name), depth + 1)
    return ITEM_PRODUCING_TYPES.has(type)
  }
  const perItemOverByName = new Map<string, string>()
  for (const node of sourceNodes) {
    if (!node.name || node === firstTrigger || bodyMemberNames.has(node.name)) continue
    const type = node.type ?? ''
    const eligible =
      type === 'n8n-nodes-base.httpRequest' ||
      type.endsWith('.mcpClient') ||
      (type === AGENT_NODE_TYPE &&
        (subsByTarget.get(node.name) ?? []).some((s) => s.connType === 'ai_tool' || s.connType === 'ai_memory')) ||
      (Boolean(node.credentials && Object.keys(node.credentials).length > 0) && !/Trigger$/.test(type) && !subNodeNames.has(node.name))
    if (!eligible) continue
    const parent = dataParentOf(node.name)
    if (!parent || !isItemProducing(parent)) continue
    const parentId = idByName.get(parent)
    if (parentId) perItemOverByName.set(node.name, `{{step.${parentId}.output}}`)
  }

  const jsonBaseFor = (nodeName: string | undefined): string => {
    // The first node inside a Loop body reads the CURRENT ITEM, not a step.
    if (nodeName && bodyStartNames.has(nodeName)) return 'item'
    // A per-item step reads the CURRENT ITEM of its upstream list.
    if (nodeName && perItemOverByName.has(nodeName)) return 'item'
    const parent = nodeName ? dataParentOf(nodeName) : undefined
    if (!parent || triggerNames.has(parent)) return 'trigger.input'
    const parentId = idByName.get(parent)
    return parentId ? `step.${parentId}.output` : 'trigger.input'
  }
  const warnedExprNodes = new Map<string, Set<string>>()
  const trFor = (nodeName: string | undefined) => (v: string) =>
    fromN8nExpression(v, idByName, jsonBaseFor(nodeName), (expr) => {
      const key = nodeName ?? '?'
      // One warning per DISTINCT broken expression (capped) — a single
      // warning per node used to hide every breakage after the first.
      const seen = warnedExprNodes.get(key) ?? new Set<string>()
      if (!warnedExprNodes.has(key)) warnedExprNodes.set(key, seen)
      if (seen.has(expr) || seen.size >= 5) return
      seen.add(expr)
      warn(`“${key}”: an n8n JS expression ({{ ${expr.slice(0, 60)} }}) was kept as-is — our templates can't evaluate JavaScript; compute it in a Code step instead.`)
    })

  // An n8n AI Agent WITH tool or memory sub-nodes is a real agent, not a bare
  // LLM call — build the spec the import route uses to create it. Model-only
  // agents skip this and import as plain ai steps (cheaper, same behavior).
  const agentClusters = new Map<string, N8nAgentSpec>()
  const agentOutputFields = new Map<string, OutputField[]>()
  // An n8n system message computed per run ({{step.…}} after translation)
  // can't live in the created agent's static instructions — flow tokens don't
  // resolve there. It rides on the agent STEP's input instead.
  const dynamicSystemByAgent = new Map<string, string>()
  // n8n memory sub-nodes (Postgres/Redis/Mongo/Xata chat memory, buffer
  // window) become the agent STEP's memory config — same n8n shape: the step
  // remembers its past runs per session key.
  const memoryByAgent = new Map<string, { store: 'postgres' | 'redis' | 'mongodb' | 'xata'; sessionKey?: string; window?: number }>()
  for (const [index, node] of sourceNodes.entries()) {
    if (node.type !== AGENT_NODE_TYPE || node === firstTrigger || !node.name) continue
    const subs = subsByTarget.get(node.name) ?? []
    const toolSubs = subs.filter((s) => s.connType === 'ai_tool')
    const memorySub = subs.find((s) => s.connType === 'ai_memory')
    if (toolSubs.length === 0 && !memorySub) continue
    const tr = trFor(node.name)
    const name = node.name
    const integrations: string[] = []
    const mcpEndpoints: string[] = []
    const tools: N8nAgentSpec['tools'] = []
    for (const { node: sub } of toolSubs) {
      const subType = sub.type ?? ''
      const subName = sub.name ?? subType
      const p = sub.parameters ?? {}
      const described = typeof p.toolDescription === 'string' && p.toolDescription.trim() ? p.toolDescription.trim() : ''
      if (subType.endsWith('.mcpClientTool')) {
        const endpoint = String(p.endpointUrl ?? p.sseEndpoint ?? '').trim()
        if (endpoint) mcpEndpoints.push(endpoint)
        const included = Array.isArray(p.includeTools) && p.includeTools.length ? ` (tools: ${(p.includeTools as unknown[]).join(', ')})` : ''
        tools.push({ name: subName, kind: 'mcp', description: `${described || `MCP server${endpoint ? ` at ${endpoint}` : ''}`}${included}` })
      } else if (subType.endsWith('.toolWorkflow')) {
        tools.push({ name: subName, kind: 'subworkflow', description: described || 'calls another n8n workflow' })
        warn(`Agent “${name}”: its tool “${subName}” calls another n8n workflow — import that workflow as a flow, then grant it to the agent (Agent → Flows).`)
      } else if (subType.endsWith('.toolHttpRequest')) {
        tools.push({ name: subName, kind: 'http', description: described || `HTTP ${String(p.method ?? 'GET')} ${String(p.url ?? '')}`.trim() })
      } else if (subType.endsWith('.toolCode')) {
        tools.push({ name: subName, kind: 'code', description: described || 'custom code tool' })
      } else if (subType.endsWith('.toolVectorStore')) {
        tools.push({ name: subName, kind: 'utility', description: described || 'searches a document knowledge base' })
        warn(`Agent “${name}”: its vector-store tool “${subName}” maps to Backstory Knowledge — upload those documents under Knowledge and the agent searches them natively.`)
      } else if (/Tool$/.test(subType) && !subType.startsWith('@n8n/n8n-nodes-langchain.tool')) {
        // App node exposed as a tool (gmailTool, slackTool, googleSheetsTool…)
        // — the strongest integration signal an n8n export carries.
        const app = deCamel((subType.split('.').pop() ?? '').replace(/Tool$/, ''))
        integrations.push(app)
        const operation = typeof p.operation === 'string' && p.operation ? ` — ${p.operation}` : ''
        tools.push({ name: subName, kind: 'integration', description: described || `${app}${operation}` })
      } else {
        tools.push({ name: subName, kind: 'utility', description: described || deCamel((subType.split('.').pop() ?? subType).replace(/^tool/, '')) })
      }
    }
    const modelSub = subs.find((s) => s.connType === 'ai_languageModel')
    const model = modelSub ? rawModelName(modelSub.node.parameters?.model) : undefined
    const parserSub = subs.find((s) => s.connType === 'ai_outputParser')
    const parserFields = parserSub ? fieldsFromOutputParser(parserSub.node.parameters ?? {}) : []
    if (parserFields.length) agentOutputFields.set(name, parserFields)
    if (memorySub) {
      const memoryType = memorySub.node.type ?? ''
      const store = /postgres/i.test(memoryType) ? 'postgres' : /redis/i.test(memoryType) ? 'redis' : /mongo/i.test(memoryType) ? 'mongodb' : /xata/i.test(memoryType) ? 'xata' : 'postgres'
      const memoryParams = memorySub.node.parameters ?? {}
      const sessionKey = typeof memoryParams.sessionKey === 'string' && memoryParams.sessionKey.trim() ? tr(memoryParams.sessionKey) : undefined
      const windowRaw = Number(memoryParams.contextWindowLength ?? NaN)
      memoryByAgent.set(name, {
        store: store as 'postgres',
        ...(sessionKey ? { sessionKey } : {}),
        ...(Number.isFinite(windowRaw) && windowRaw >= 1 ? { window: Math.min(20, Math.floor(windowRaw)) } : {}),
      })
      warn(
        `Agent “${name}”: its n8n conversation memory (${memoryType}) imported as step memory — the step remembers past runs${store !== 'postgres' ? ` (the ${store} store persists in Backstory's own Postgres today)` : ''}.`,
      )
    }
    const systemMessage = tr(String((node.parameters?.options as { systemMessage?: unknown } | undefined)?.systemMessage ?? '')).trim()
    const dynamicSystem = /\{\{/.test(systemMessage)
    if (dynamicSystem) {
      dynamicSystemByAgent.set(name, systemMessage)
      warn(
        `Agent “${name}”: its n8n system message is computed per run — it now travels on the Agent step's input (the created agent carries generic instructions).`,
      )
    }
    const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`)
    const instructions = [
      (!dynamicSystem && systemMessage) || `You are “${name}”, an agent imported from an n8n workflow. Complete the task given in the input.`,
      toolLines.length ? `Use your connected tools to do the work:\n${toolLines.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    agentClusters.set(name, {
      placeholderId: `n8n-agent-pending:${idOf(node, index)}`,
      name,
      instructions,
      ...(model ? { model } : {}),
      integrations: Array.from(new Set(integrations)),
      mcpEndpoints: Array.from(new Set(mcpEndpoints)),
      tools,
      hasMemory: Boolean(memorySub),
    })
  }

  // First recognized trigger becomes THE trigger; extra triggers become notes.
  const nodes: FlowNode[] = []
  // Synthesized companions (a classifier's routing switch, a retrieval chain's
  // answer step): outgoing edges re-source from the companion, and the internal
  // hop is added as an extra edge.
  const edgeSourceOverride = new Map<string, string>()
  // Prepended companions (an HTTP node's expression-compute step): incoming
  // edges re-target to the companion, which then feeds the real node.
  const edgeTargetOverride = new Map<string, string>()
  const synthEdges: Array<{ source: string; target: string }> = []
  let triggerId: string | null = null
  for (const [index, node] of sourceNodes.entries()) {
    const id = idOf(node, index)
    if (node.name && subNodeNames.has(node.name)) {
      const target = subTargetOf.get(node.name)
      if (target && agentClusters.has(target)) {
        warn(`“${node.name}” (${node.type}) was folded into the imported agent “${target}” — its model/tool binding lives on that agent now.`)
      } else {
        warn(`“${node.name}” (${node.type}) configures the step it points at (model/tool provider) — absorbed; the imported AI step runs on Backstory models and tools.`)
      }
      continue
    }
    const position = Array.isArray(node.position) ? { x: Number(node.position[0]) || 0, y: Number(node.position[1]) || 0 } : undefined
    const triggerType = n8nTriggerType(node.type)
    let mapped: FlowNode | null
    if (triggerType && !triggerId) {
      triggerId = id
      mapped = {
        id,
        type: 'trigger',
        data: {
          trigger:
            triggerType === 'schedule'
              ? { type: 'schedule', schedule: scheduleFromRule(node.parameters) }
              : { type: triggerType },
        },
      } as FlowNode
      if (triggerType === 'schedule') warn(`“${node.name ?? 'Trigger'}”: schedule imported PAUSED — review the cadence, then activate it.`)
      if (node.type === '@n8n/n8n-nodes-langchain.chatTrigger') {
        warn(`“${node.name ?? 'Chat trigger'}”: imported as a webhook trigger — POST { "chatInput": "…" } to it (references to $json.chatInput already point there).`)
      }
      if (node.type === 'n8n-nodes-base.formTrigger') {
        warn(`“${node.name ?? 'Form trigger'}”: imported as a webhook trigger — the form UI doesn't transfer; POST the form fields as JSON instead.`)
      }
      if (!TRIGGER_TYPES[node.type ?? '']) {
        warn(`“${node.name ?? node.type}” (${node.type}): a provider event trigger imported as a webhook trigger — point the provider's webhook/automation at this flow's URL.`)
      }
    } else if (triggerType) {
      warn(`“${node.name ?? node.type}”: a flow has one trigger — this extra ${n8nTriggerType(node.type)} trigger became a note; switch the flow's trigger type in the builder if you want this one instead.`)
      mapped = {
        id,
        type: 'note',
        data: {
          text: `Extra n8n trigger “${node.name ?? node.type}” (${node.type}) — a flow has ONE trigger, and the first one in the file won. To use this one instead, change the trigger type on the trigger card.${node.parameters && Object.keys(node.parameters).length ? `\n\nOriginal parameters:\n${JSON.stringify(node.parameters, null, 2).slice(0, 2000)}` : ''}`.slice(0, 5000),
        },
      } as FlowNode
    } else if (node.name && agentClusters.has(node.name)) {
      const spec = agentClusters.get(node.name)!
      const text = node.parameters?.text
      const outputFields = agentOutputFields.get(node.name)
      const baseInput = typeof text === 'string' && text.trim() ? trFor(node.name)(text) : `{{${jsonBaseFor(node.name)}}}`
      const dynamicSystem = dynamicSystemByAgent.get(node.name)
      const stepMemory = memoryByAgent.get(node.name)
      mapped = {
        id,
        type: 'agent',
        data: {
          agentId: spec.placeholderId,
          label: node.name,
          input: dynamicSystem ? `${dynamicSystem}\n\n${baseInput}` : baseInput,
          // The n8n sub-node attachments live on the STEP too (model + memory)
          // so the imported step mirrors the n8n agent-configuration node.
          ...(spec.model ? { model: spec.model } : {}),
          ...(stepMemory ? { memory: stepMemory } : {}),
          ...(outputFields?.length ? { responseFormat: 'structured' as const, outputFields } : {}),
        },
      } as FlowNode
      warn(
        `“${node.name}”: imported as a real Agent step — a new agent carries its instructions and ${spec.tools.length} tool${spec.tools.length === 1 ? '' : 's'}; open the agent to confirm its connections before running.`,
      )
    } else if (node.type === 'n8n-nodes-base.splitInBatches' && node.name && loopBodyByName.has(node.name)) {
      // Loop Over Items → a native Loop step whose body is the walked loop
      // branch. Body steps run per item ({{item}}); the loop's output is the
      // collected per-iteration results, flowing on via the "done" edge.
      const memberIds = (loopBodyByName.get(node.name) ?? [])
        .map((member) => idByName.get(member))
        .filter((memberId): memberId is string => Boolean(memberId))
      const batchSize = Number(node.parameters?.batchSize ?? 1)
      mapped = {
        id,
        type: 'loop',
        data: {
          label: node.name,
          over: `{{${jsonBaseFor(node.name)}}}`,
          body: memberIds,
          ...(Number.isFinite(batchSize) && batchSize > 1 ? { batchSize: Math.min(1000, Math.floor(batchSize)) } : {}),
        },
      } as FlowNode
      warn(`“${node.name}”: imported as a native Loop step over its upstream list — its ${memberIds.length} body step${memberIds.length === 1 ? '' : 's'} run once per item; check the “over” list if the loop fed itself differently.`)
    } else if (node.type === '@n8n/n8n-nodes-langchain.chainRetrievalQa' && node.name) {
      // Retrieval Q&A = search the knowledge base, then answer from the hits —
      // a Knowledge step plus a synthesized answer step.
      const tr = trFor(node.name)
      const p = node.parameters ?? {}
      const question = typeof p.text === 'string' && p.text.trim() ? tr(p.text) : typeof p.query === 'string' && p.query.trim() ? tr(p.query) : `{{${jsonBaseFor(node.name)}}}`
      let answerId = `${id}-answer`
      while (usedIds.has(answerId)) answerId = `${answerId}-x`
      usedIds.add(answerId)
      mapped = { id, type: 'knowledge', data: { label: node.name, query: question, topK: 5 } } as FlowNode
      const answer = {
        id: answerId,
        type: 'ai',
        data: {
          label: `${node.name} — answer`,
          aiOp: 'ask',
          input: `Question: ${question}\n\nRetrieved context:\n{{step.${id}.output}}`,
          instructions: 'Answer the question using only the retrieved context. Say so plainly if the context does not contain the answer.',
        },
      } as FlowNode
      const answerPosition = position ? { x: position.x + 220, y: position.y } : undefined
      nodes.push(position ? ({ ...mapped, position } as FlowNode) : mapped)
      nodes.push(answerPosition ? ({ ...answer, position: answerPosition } as FlowNode) : answer)
      edgeSourceOverride.set(node.name, answerId)
      synthEdges.push({ source: id, target: answerId })
      warn(`“${node.name}”: imported as a Knowledge search + answer step — upload the documents it searched under Knowledge so the search has something to find.`)
      continue
    } else {
      mapped = mapNode(node, id, trFor(node.name), warn, idByName, jsonBaseFor(node.name))
      // Classifiers route each item down ONE category output in n8n — mirror
      // that with a synthesized switch reading the categorize step's result.
      if (mapped && mapped.type === 'ai' && CLASSIFIER_TYPES.has(node.type ?? '') && node.name) {
        const categories = (mapped.data as { categories?: string[] }).categories ?? []
        if (categories.length) {
          let switchId = `${id}-routes`
          while (usedIds.has(switchId)) switchId = `${switchId}-x`
          usedIds.add(switchId)
          const cases = categories.map((category, caseIndex) => ({
            id: `case-${caseIndex}`,
            label: category,
            left: `{{step.${id}.output.category}}`,
            op: 'eq' as ConditionOp,
            right: category,
          }))
          edgeSourceOverride.set(node.name, switchId)
          synthEdges.push({ source: id, target: switchId })
          nodes.push(position ? ({ ...mapped, position } as FlowNode) : mapped)
          const routerPosition = position ? { x: position.x + 220, y: position.y } : undefined
          const router = { id: switchId, type: 'switch', data: { label: `${node.name} routes`, cases } } as FlowNode
          nodes.push(routerPosition ? ({ ...router, position: routerPosition } as FlowNode) : router)
          continue
        }
      }
      // An HTTP node whose url/query/headers/body kept raw n8n JS expressions
      // ({{ Math.floor(Date.now()/1000) }}) would hard-fail at run time — the
      // template resolver treats them as unknown references. Hoist each
      // expression into a prepended compute Code step (where the n8n shim runs
      // them as real JS) and reference its results from the request instead.
      if (mapped && mapped.type === 'http' && node.name && !bodyMemberNames.has(node.name)) {
        let computeId = `${id}-expr`
        while (usedIds.has(computeId)) computeId = `${computeId}-x`
        const exprs = new Map<string, string>()
        const data = mapped.data as { url: string; query?: string; headers?: string; body?: string }
        const hoistJsonMap = (raw: string): string => {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>
            return JSON.stringify(
              Object.fromEntries(
                Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? hoistRawExpressions(value, computeId, exprs) : value]),
              ),
            )
          } catch {
            return hoistRawExpressions(raw, computeId, exprs)
          }
        }
        const url = hoistRawExpressions(data.url, computeId, exprs)
        const query = data.query === undefined ? undefined : hoistJsonMap(data.query)
        const headers = data.headers === undefined ? undefined : hoistJsonMap(data.headers)
        const body = data.body === undefined ? undefined : hoistRawExpressions(data.body, computeId, exprs)
        if (exprs.size > 0) {
          // The shim covers $/$input/$json/items/$now/$today — anything else
          // from n8n's expression runtime is undefined in the sandbox and the
          // step would throw at run time. Say so now, naming the global.
          const UNSUPPORTED = /\$env|\$vars|\$execution|\$workflow|\$jmespath|\$prevNode|\$runIndex|\$itemIndex|\$fromAI|\$binary|\$items\s*\(|\bDateTime\b/g
          const unsupported = new Set<string>()
          for (const expr of exprs.keys()) {
            for (const match of expr.match(UNSUPPORTED) ?? []) unsupported.add(match.replace(/\s*\($/, ''))
          }
          if (unsupported.size) {
            warn(
              `“${node.name}”: uses ${[...unsupported].join(', ')} — n8n runtime values with no equivalent here; the inserted Code step will fail until those are replaced.`,
            )
          }
          usedIds.add(computeId)
          mapped = {
            ...mapped,
            data: {
              ...mapped.data,
              url,
              ...(query !== undefined ? { query } : {}),
              ...(headers !== undefined ? { headers } : {}),
              ...(body !== undefined ? { body } : {}),
            },
          } as FlowNode
          const lines = [...exprs.entries()].map(([expr, key]) => `  ${key}: (${expr}),`)
          const compute = {
            id: computeId,
            type: 'code',
            data: {
              label: `${node.name} — expressions`,
              language: 'javascript',
              mode: 'all',
              input: `{{${jsonBaseFor(node.name)}}}`,
              code: withN8nCodeShim(
                `// Imported from n8n: evaluates the JS expressions “${node.name}” used in its\n// request parameters; the HTTP step references the results.\nreturn {\n${lines.join('\n')}\n}`,
                Object.fromEntries(idByName),
              ),
            },
          } as FlowNode
          const computePosition = position ? { x: position.x - 220, y: position.y } : undefined
          nodes.push(computePosition ? ({ ...compute, position: computePosition } as FlowNode) : compute)
          edgeTargetOverride.set(node.name, computeId)
          synthEdges.push({ source: computeId, target: id })
          // The per-node "JS expression kept as-is" warning no longer applies —
          // the expressions now run in the inserted compute step.
          for (let i = warnings.length - 1; i >= 0; i--) {
            if (warnings[i].startsWith(`“${node.name}”: an n8n JS expression`)) warnings.splice(i, 1)
          }
          warn(
            `“${node.name}”: its n8n JS expressions were moved into an inserted Code step (“${node.name} — expressions”) that computes them before the request.`,
          )
        }
      }
    }
    // n8n per-item parity: fan the step out over its upstream item list; its
    // {{item.…}} references (translated above) read the current item.
    if (mapped && node.name && perItemOverByName.has(node.name) && (mapped.type === 'http' || mapped.type === 'tool' || mapped.type === 'agent')) {
      mapped = { ...mapped, data: { ...mapped.data, perItem: { over: perItemOverByName.get(node.name)! } } } as FlowNode
      warn(`“${node.name}”: runs once per upstream item (n8n executes per item) — the collected results flow on as a list.`)
    }
    if (mapped) {
      // Carry n8n's node-level flags: `disabled` (any kind) and the Settings-tab
      // reliability options (action kinds whose schema has the fields).
      if (ACTION_SETTING_KINDS.has(mapped.type)) {
        const settings = nodeSettingsFrom(node)
        if (Object.keys(settings).length) mapped = { ...mapped, data: { ...mapped.data, ...settings } } as FlowNode
      }
      if (node.disabled) mapped = { ...mapped, disabled: true } as FlowNode
      nodes.push(position ? ({ ...mapped, position } as FlowNode) : mapped)
    }
  }

  // No trigger in the file → synthesize a manual one and wire it to the roots.
  const nodeIds = new Set(nodes.map((n) => n.id))
  if (!triggerId) {
    triggerId = 'trigger'
    while (nodeIds.has(triggerId)) triggerId = `${triggerId}-1`
    nodes.unshift({ id: triggerId, type: 'trigger', data: { trigger: { type: 'manual' } } } as FlowNode)
    nodeIds.add(triggerId)
  }

  // Connections (keyed by source NAME) → edges, skipping any that closes a cycle.
  const errorOutputByName = new Set(
    (workflow.nodes ?? []).filter((n) => n.onError === 'continueErrorOutput' && n.name).map((n) => n.name as string),
  )
  const edges: FlowGraph['edges'] = []
  const adjacency = new Map<string, Set<string>>()
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    for (const next of adjacency.get(from) ?? []) if (reaches(next, to, seen)) return true
    return false
  }
  const typeById = new Map(nodes.map((n) => [n.id, n.type]))
  const casesById = new Map(nodes.filter((n) => n.type === 'switch').map((n) => [n.id, (n as Extract<FlowNode, { type: 'switch' }>).data.cases]))
  let edgeIndex = 0
  // Synthesized hops (classifier → its routing switch, knowledge → its answer
  // step); outgoing connections re-source from the companion via the override.
  for (const synth of synthEdges) {
    edges.push({ id: `e-${edgeIndex++}`, source: synth.source, target: synth.target })
    if (!adjacency.has(synth.source)) adjacency.set(synth.source, new Set())
    adjacency.get(synth.source)!.add(synth.target)
  }
  // Loop bodies live in the Loop step's `body` id list, not on edges — their
  // members' connections (internal hops and the back-edge) don't become edges,
  // and nothing outside may target them directly.
  const bodyMemberIds = new Set(
    Array.from(bodyMemberNames)
      .map((member) => idByName.get(member))
      .filter((memberId): memberId is string => Boolean(memberId)),
  )
  for (const [sourceName, conn] of Object.entries(workflow.connections ?? {})) {
    if (bodyMemberNames.has(sourceName)) continue
    const mappedSourceId = idByName.get(sourceName)
    if (!mappedSourceId || !nodeIds.has(mappedSourceId)) continue
    const sourceId = edgeSourceOverride.get(sourceName) ?? mappedSourceId
    const isLoopSource = loopBodyByName.has(sourceName)
    const outputs = Array.isArray(conn?.main) ? conn.main : []
    for (const [outIdx, targets] of outputs.entries()) {
      // A Loop step's body branch (output 1) is its `body` list, not edges;
      // only the "done" output (0) continues the flow.
      if (isLoopSource && outIdx !== 0) continue
      for (const target of targets ?? []) {
        const targetId = target?.node ? edgeTargetOverride.get(target.node) ?? idByName.get(target.node) : undefined
        if (!targetId || !nodeIds.has(targetId) || bodyMemberIds.has(targetId)) continue
        if (reaches(targetId, sourceId)) {
          warn(`Dropped the looping connection ${sourceName} → ${target.node} (our flows are one-way; rebuild n8n loops as a Loop step).`)
          continue
        }
        const sourceType = typeById.get(sourceId)
        const branch =
          sourceType === 'condition'
            ? outIdx === 1
              ? 'false'
              : 'true'
            : sourceType === 'switch'
              ? casesById.get(sourceId)?.[outIdx]?.id ?? 'default'
              : // onError:'route' — n8n's second output is the ERROR branch, not a
                // parallel success lane; an unlabelled edge here would run the
                // failure path on every successful execution.
                errorOutputByName.has(sourceName) && outIdx === 1
                ? 'error'
                : undefined
        edges.push({ id: `e-${edgeIndex++}`, source: sourceId, target: targetId, ...(branch ? { branch } : {}) })
        if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set())
        adjacency.get(sourceId)!.add(targetId)
      }
    }
  }

  // Wire the trigger to every root (no incoming edge) that isn't the trigger
  // or a floating annotation — covers both a synthesized trigger and an n8n
  // trigger whose connections were name-mismatched.
  const hasIncoming = new Set(edges.map((e) => e.target))
  for (const node of nodes) {
    if (node.id === triggerId || node.type === 'note' || bodyMemberIds.has(node.id)) continue
    if (!hasIncoming.has(node.id) ) {
      edges.push({ id: `e-${edgeIndex++}`, source: triggerId, target: node.id })
      hasIncoming.add(node.id)
    }
  }

  // n8n executes every node once per ITEM flowing through it; Backstory runs
  // each step once with the whole value. Imported code steps handle this via
  // the shim (arrays in, arrays out) — but steps consuming a LIST from a code
  // step (an HTTP call per item, an AI step per item) need per-item turned on.
  if (nodes.some((n) => n.type === 'code')) {
    warn(
      'n8n runs each step once per item; Backstory runs a step once with the whole list. Steps that should repeat per item (an HTTP request or AI step fed by a list) need “For each item” enabled in their settings.',
    )
  }

  // n8n pinData is our per-node pinned mock output: unwrap the [{json}] item
  // envelope (single item → the object, several → a list of them).
  const pinData: Record<string, unknown> = {}
  for (const [pinName, items] of Object.entries(workflow.pinData ?? {})) {
    const pinId = idByName.get(pinName)
    if (!pinId || !nodeIds.has(pinId)) continue
    const list = (Array.isArray(items) ? items : [items]).map((item) =>
      item && typeof item === 'object' && 'json' in (item as Record<string, unknown>) ? (item as { json: unknown }).json : item,
    )
    pinData[pinId] = list.length === 1 ? list[0] : list
  }

  return {
    name: workflow.name?.trim() || 'Imported from n8n',
    graph: { nodes, edges, ...(Object.keys(pinData).length ? { pinData } : {}) },
    warnings,
    agents: Array.from(agentClusters.values()),
  }
}
