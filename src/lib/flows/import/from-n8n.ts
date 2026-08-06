import type { FlowGraph, FlowNode, ConditionOp, OutputField } from '@/lib/flows/graph'

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
  /** n8n app/action nodes carry their credential bindings here — the signal
   * that a node talks to an external service and should import as a Tool step. */
  credentials?: Record<string, unknown>
}

/** One node's outgoing ports: `main` plus AI cluster types (ai_tool, ai_languageModel, …). */
type N8nConnectionPorts = { main?: Array<Array<{ node?: string; index?: number }>> } & Record<
  string,
  Array<Array<{ node?: string; index?: number }>> | undefined
>

type N8nWorkflowIn = {
  name?: string
  nodes?: N8nNodeIn[]
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
  const translated = body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, expr: string) => {
    // $json.path → the node's incoming item
    const jsonMatch = expr.match(/^\$json(?:\.(.+))?$/)
    if (jsonMatch) return `{{${jsonBase}${jsonMatch[1] ? '.' + jsonMatch[1] : ''}}}`
    // $node["Name"].json.path  |  $('Name').item.json.path  |  $('Name').json.path
    const nodeMatch =
      expr.match(/^\$node\[(?:"|')(.+?)(?:"|')\]\.json(?:\.(.+))?$/) ??
      expr.match(/^\$\((?:"|')(.+?)(?:"|')\)(?:\.(?:item|first\(\)))?\.json(?:\.(.+))?$/)
    if (nodeMatch) {
      const id = names.get(nodeMatch[1]) ?? nodeMatch[1]
      return `{{step.${id}.output${nodeMatch[2] ? '.' + nodeMatch[2] : ''}}}`
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
const __n8nWrap = (v) => __n8nItems(v).map((json) => ({ json }));
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
  const conditions = (parameters.conditions ?? {}) as { combinator?: string; conditions?: RawClause[] }
  const raw = Array.isArray(conditions.conditions) ? conditions.conditions : []
  const clauses = raw.map((c) => {
    const operation = c.operator?.operation ?? 'equals'
    const op = OPERATION_TO_OP[operation]
    if (!op) warn(`“${nodeName}”: condition operator “${operation}” has no equivalent — imported as “equals”; review it.`)
    return {
      left: tr(String(c.leftValue ?? '')),
      op: op ?? ('eq' as ConditionOp),
      right: tr(String(c.rightValue ?? '')),
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
      return { id, type: 'note', data: { text: (node.notes ?? 'No-op step from n8n.').slice(0, 5000) } } as FlowNode
    case 'n8n-nodes-base.httpRequest': {
      const sendBody = parameters.sendBody === true || typeof parameters.jsonBody === 'string'
      const pairs = (source: unknown): Record<string, string> =>
        Object.fromEntries(
          (((source as { parameters?: Array<{ name?: string; value?: unknown }> })?.parameters ?? [])
            .filter((p) => typeof p.name === 'string' && p.name)
            .map((p) => [String(p.name), tr(String(p.value ?? ''))])),
        )
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
          method: typeof parameters.method === 'string' ? parameters.method : 'GET',
          url: tr(String(parameters.url ?? '')),
          ...(Object.keys(query).length ? { query: JSON.stringify(query) } : {}),
          ...(Object.keys(headers).length ? { headers: JSON.stringify(headers) } : {}),
          ...(sendBody && typeof parameters.jsonBody === 'string' ? { bodyMode: 'json', body: tr(parameters.jsonBody) } : {}),
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
        ((parameters.assignments as { assignments?: Array<{ name?: string; value?: unknown }> })?.assignments ?? [])
      const fields = assignments
        .filter((a) => typeof a.name === 'string' && a.name)
        .map((a) => ({ name: String(a.name), value: tr(String(a.value ?? '')) }))
      return { id, type: 'transform', data: { label, fields } } as FlowNode
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
    case 'n8n-nodes-base.merge':
      return { id, type: 'join', data: { label, mode: 'append' } } as FlowNode
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
      const body =
        operation === 'toJson'
          ? `return { filename: ${JSON.stringify(fileName ?? 'data.json')}, mimeType: 'application/json', content: JSON.stringify(input, null, 2) }`
          : operation === 'csv'
            ? `const rows = Array.isArray(input) ? input : [input]
const keys = Array.from(new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : []))))
const cell = (v) => { const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
const lines = [keys.join(',')].concat(rows.map((r) => keys.map((k) => cell(r && typeof r === 'object' ? r[k] : undefined)).join(',')))
return { filename: ${JSON.stringify(fileName ?? 'data.csv')}, mimeType: 'text/csv', content: lines.join('\\n') }`
            : operation === 'toText'
              ? `return { filename: ${JSON.stringify(fileName ?? 'data.txt')}, mimeType: 'text/plain', content: typeof input === 'string' ? input : JSON.stringify(input, null, 2) }`
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
      const op = type === 'n8n-nodes-base.splitOut' ? 'flatten' : (type.split('.').pop() as 'sort' | 'limit' | 'removeDuplicates' | 'aggregate' | 'summarize')
      warn(`“${name}”: imported as a native “${op}” data step — its settings don't transfer 1:1; review them.`)
      return { id, type: 'data', data: { label, op, input: `{{${jsonBase}}}` } } as FlowNode
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
        warn(`“${name}”: imported as a Tool step calling “${toolName}” — open it and pick your MCP connection.`)
        return {
          id,
          type: 'tool',
          data: {
            label,
            connectionId: '',
            toolName,
            args: JSON.stringify((parameters.parameters as { value?: unknown })?.value ?? {}),
            note: `Imported from n8n MCP client (endpoint ${String(parameters.endpointUrl ?? 'unknown')}). Pick the matching MCP connection.`,
          },
        } as FlowNode
      }
      if (isLlmType(type)) {
        warn(`“${name}”: imported as a native AI step running on Backstory models — review its instructions.`)
        return { id, type: 'ai', data: { label, aiOp: 'ask', instructions: llmInstructions(parameters, tr) } } as FlowNode
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
            .map(([key, value]) => [key, typeof value === 'string' ? tr(value) : value]),
        )
        warn(`“${name}” (${app}) imported as a Tool step without a connection — open it and pick the matching integration; its n8n parameters are preserved in Args.`)
        return {
          id,
          type: 'tool',
          data: {
            label,
            connectionId: '',
            toolName: `${app}${operation}`,
            args: JSON.stringify(translatedParams),
            note: `Imported from n8n (${type}). Pick your connected integration and the matching tool; the original parameters are in Args.`,
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
  const jsonBaseFor = (nodeName: string | undefined): string => {
    // The first node inside a Loop body reads the CURRENT ITEM, not a step.
    if (nodeName && bodyStartNames.has(nodeName)) return 'item'
    const parent = nodeName ? parentByName.get(nodeName) : undefined
    if (!parent || triggerNames.has(parent)) return 'trigger.input'
    const parentId = idByName.get(parent)
    return parentId ? `step.${parentId}.output` : 'trigger.input'
  }
  const warnedExprNodes = new Set<string>()
  const trFor = (nodeName: string | undefined) => (v: string) =>
    fromN8nExpression(v, idByName, jsonBaseFor(nodeName), (expr) => {
      const key = nodeName ?? '?'
      if (warnedExprNodes.has(key) || !/[($]/.test(expr)) return
      warnedExprNodes.add(key)
      warn(`“${key}”: an n8n JS expression ({{ ${expr.slice(0, 60)} }}) was kept as-is — our templates can't evaluate JavaScript; compute it in a Code step instead.`)
    })

  // An n8n AI Agent WITH tool or memory sub-nodes is a real agent, not a bare
  // LLM call — build the spec the import route uses to create it. Model-only
  // agents skip this and import as plain ai steps (cheaper, same behavior).
  const agentClusters = new Map<string, N8nAgentSpec>()
  const agentOutputFields = new Map<string, OutputField[]>()
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
      warn(`Agent “${name}”: its n8n conversation memory (${memorySub.node.type}) doesn't transfer — Backstory agents keep their own durable memory instead.`)
    }
    const systemMessage = tr(String((node.parameters?.options as { systemMessage?: unknown } | undefined)?.systemMessage ?? '')).trim()
    const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`)
    const instructions = [
      systemMessage || `You are “${name}”, an agent imported from an n8n workflow. Complete the task given in the input.`,
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
      mapped = {
        id,
        type: 'agent',
        data: {
          agentId: spec.placeholderId,
          label: node.name,
          input: typeof text === 'string' && text.trim() ? trFor(node.name)(text) : `{{${jsonBaseFor(node.name)}}}`,
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
    }
    if (mapped) nodes.push(position ? ({ ...mapped, position } as FlowNode) : mapped)
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
        const targetId = target?.node ? idByName.get(target.node) : undefined
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

  return {
    name: workflow.name?.trim() || 'Imported from n8n',
    graph: { nodes, edges },
    warnings,
    agents: Array.from(agentClusters.values()),
  }
}
