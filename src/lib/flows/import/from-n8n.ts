import type { FlowGraph, FlowNode, ConditionOp } from '@/lib/flows/graph'

/**
 * Import an n8n workflow JSON (Workflows → Download) as a Backstory flow —
 * the reverse of export/to-n8n.ts. Structural nodes (trigger, HTTP, IF,
 * Switch, Filter, Set, Code, Merge, Wait) convert to native steps and run
 * immediately; LLM nodes become native `ai` steps (they run on our models);
 * app nodes with no native equivalent import as canvas notes carrying the
 * original name/type/parameters so the user swaps in a tool/HTTP step.
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
}

type N8nWorkflowIn = {
  name?: string
  nodes?: N8nNodeIn[]
  connections?: Record<string, { main?: Array<Array<{ node?: string; index?: number }>> }>
}

export type N8nImportResult = { name: string; graph: FlowGraph; warnings: string[] }

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

const TRIGGER_TYPES: Record<string, 'manual' | 'webhook' | 'schedule'> = {
  'n8n-nodes-base.manualTrigger': 'manual',
  'n8n-nodes-base.webhook': 'webhook',
  'n8n-nodes-base.scheduleTrigger': 'schedule',
  'n8n-nodes-base.cron': 'schedule',
}

function isLlmType(type: string): boolean {
  return type.startsWith('@n8n/n8n-nodes-langchain.') || /openai|anthropic|chatmodel|\.ai\b/i.test(type)
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
      return {
        id,
        type: 'http',
        data: {
          label,
          method: typeof parameters.method === 'string' ? parameters.method : 'GET',
          url: tr(String(parameters.url ?? '')),
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
      const original = String((python ? parameters.pythonCode : parameters.jsCode) ?? parameters.jsCode ?? parameters.pythonCode ?? '')
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
      warn(`“${name}”: n8n loops (Loop Over Items) don’t import — rebuild it as a Backstory Loop step; its looping connection was dropped.`)
      return { id, type: 'note', data: { text: noteText(node) } } as FlowNode
    default: {
      if (isLlmType(type)) {
        warn(`“${name}”: imported as a native AI step running on Backstory models — review its instructions.`)
        return { id, type: 'ai', data: { label, aiOp: 'ask', instructions: llmInstructions(parameters, tr) } } as FlowNode
      }
      warn(`“${name}” (${type}) has no native equivalent — imported as a note; replace it with a Tool or HTTP step.`)
      return { id, type: 'note', data: { text: noteText(node) } } as FlowNode
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
  const firstTrigger = sourceNodes.find((node) => TRIGGER_TYPES[node.type ?? ''])
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

  // What `$json` means per node: the direct upstream on the MAIN chain.
  const parentByName = new Map<string, string>()
  for (const [sourceName, conn] of Object.entries(workflow.connections ?? {})) {
    for (const targets of conn?.main ?? []) {
      for (const target of targets ?? []) {
        if (target?.node && !parentByName.has(target.node)) parentByName.set(target.node, sourceName)
      }
    }
  }
  const triggerNames = new Set(sourceNodes.filter((n) => TRIGGER_TYPES[n.type ?? '']).map((n) => n.name ?? ''))
  const jsonBaseFor = (nodeName: string | undefined): string => {
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

  // First recognized trigger becomes THE trigger; extra triggers become notes.
  const nodes: FlowNode[] = []
  let triggerId: string | null = null
  for (const [index, node] of sourceNodes.entries()) {
    const id = idOf(node, index)
    if (node.name && subNodeNames.has(node.name)) {
      warn(`“${node.name}” (${node.type}) configures the agent it points at (model/tool provider) — absorbed; the imported AI step runs on Backstory models and tools.`)
      continue
    }
    const position = Array.isArray(node.position) ? { x: Number(node.position[0]) || 0, y: Number(node.position[1]) || 0 } : undefined
    const triggerType = TRIGGER_TYPES[node.type ?? '']
    let mapped: FlowNode | null
    if (triggerType && !triggerId) {
      triggerId = id
      mapped = {
        id,
        type: 'trigger',
        data: {
          trigger:
            triggerType === 'schedule'
              ? { type: 'schedule', schedule: { type: 'daily', isActive: false } }
              : { type: triggerType },
        },
      } as FlowNode
      if (triggerType === 'schedule') warn(`“${node.name ?? 'Trigger'}”: schedule imported as daily (paused) — set the cadence you want.`)
    } else if (triggerType) {
      warn(`“${node.name ?? node.type}”: a flow has one trigger — this extra ${TRIGGER_TYPES[node.type ?? '']} trigger became a note; switch the flow's trigger type in the builder if you want this one instead.`)
      mapped = {
        id,
        type: 'note',
        data: {
          text: `Extra n8n trigger “${node.name ?? node.type}” (${node.type}) — a flow has ONE trigger, and the first one in the file won. To use this one instead, change the trigger type on the trigger card.${node.parameters && Object.keys(node.parameters).length ? `\n\nOriginal parameters:\n${JSON.stringify(node.parameters, null, 2).slice(0, 2000)}` : ''}`.slice(0, 5000),
        },
      } as FlowNode
    } else {
      mapped = mapNode(node, id, trFor(node.name), warn, idByName)
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
  for (const [sourceName, conn] of Object.entries(workflow.connections ?? {})) {
    const sourceId = idByName.get(sourceName)
    if (!sourceId || !nodeIds.has(sourceId)) continue
    const outputs = Array.isArray(conn?.main) ? conn.main : []
    for (const [outIdx, targets] of outputs.entries()) {
      for (const target of targets ?? []) {
        const targetId = target?.node ? idByName.get(target.node) : undefined
        if (!targetId || !nodeIds.has(targetId)) continue
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
    if (node.id === triggerId || node.type === 'note') continue
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
  }
}
