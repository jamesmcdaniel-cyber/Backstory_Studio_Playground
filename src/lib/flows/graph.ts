import { z } from 'zod'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'

/** Comparison operators available to a condition node. */
export const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches'] as const
export type ConditionOp = (typeof CONDITION_OPS)[number]

/** Plain-english operator labels — the ONLY strings the UI may show for ops. */
export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  matches: 'matches pattern',
}

/** Field types a step's output schema can declare (for the datatree picker). */
export const FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'any'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export const outputFieldSchema = z.object({ name: z.string(), type: z.enum(FIELD_TYPES).default('any'), description: z.string().optional() })
export type OutputField = z.infer<typeof outputFieldSchema>

/** A trigger input field: an OutputField plus whether the run must supply it
 * and a `default` used at run start when the caller omits/blanks the value. */
export const triggerInputFieldSchema = outputFieldSchema.extend({ required: z.boolean().optional(), default: z.string().optional(), format: z.enum(['file']).optional() })
export type TriggerInputField = z.infer<typeof triggerInputFieldSchema>

/**
 * Per-item fan-out: run ONE step once per item of a list, collecting the
 * per-item outputs into an array (the step's output). This is the list-aware
 * step contract — n8n's item pipeline expressed as an opt-in modifier rather
 * than a global array-of-items data shape, so single-value flows stay simple.
 *
 * - `over` templates the source list; an exact `{{step.x.output}}` token keeps
 *   its structure. Inside the step, `{{item}}` (and `{{loop.index}}`) address
 *   the current item, exactly as inside a `loop` body.
 * - `itemError` decides what a FAILING item does (a failure = the step's own
 *   `onError` produced a hard error, i.e. the default `onError: 'stop'`):
 *     'fail'    (default) — the first failed item fails the whole step.
 *     'skip'    — drop the failed item; keep the survivors; the step succeeds.
 *     'collect' — keep a `{ error }` placeholder in the item's slot; succeed.
 *   (A step whose own `onError` is 'continue'/'route' handles the failure
 *   per-item BEFORE `itemError` sees it — the item contributes `undefined` /
 *   the `{ error, input }` object respectively. Leave `onError` at its default
 *   'stop' to let `itemError` govern, which is the common case.)
 * - `concurrency` bounds how many items run at once (default 1), like a loop.
 */
export const perItemSchema = z.object({
  over: z.string(),
  itemError: z.enum(['fail', 'skip', 'collect']).optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
})
export type PerItemConfig = z.infer<typeof perItemSchema>

const triggerNode = z.object({
  id: z.string(),
  type: z.literal('trigger'),
  data: z.object({ trigger: z.any().optional() }),
})
const agentNode = z.object({
  id: z.string(),
  type: z.literal('agent'),
  data: z.object({
    agentId: z.string(),
    label: z.string().optional(),
    note: z.string().optional(),
    input: z.string().optional(),
    onError: z.enum(['stop', 'continue', 'route']).optional(),
    // Per-step reliability: retry the agent up to `retries` times with backoff,
    // and abort a single attempt after `timeoutMs`.
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(AGENT_RUN_TIMEOUT_MS).optional(),
    // Declared output schema — fields this step is expected to produce. Powers
    // the datatree field picker for downstream mapping.
    outputFields: z.array(outputFieldSchema).optional(),
    // Agent response contract: 'structured' appends a JSON instruction built
    // from outputFields and fails the step when the reply can't be parsed.
    responseFormat: z.enum(['text', 'structured']).optional(),
    // MS-parity "request human assistance when unsure": when false, a step
    // that pauses to ask a human fails instead of waiting.
    humanAssistance: z.boolean().optional(),
    // Aggregated upstream context: append every earlier step's captured output
    // (API/query data etc.) to the agent's prompt so nodes feed each other.
    // true → always; false → never; undefined → auto (append only when the
    // input doesn't already reference step data).
    includeUpstreamContext: z.boolean().optional(),
    // Run this agent once per item of a list, collecting the outputs (see perItemSchema).
    perItem: perItemSchema.optional(),
  }),
})
/** One left/op/right comparison; a condition ANDs/ORs a list of these. */
export const conditionClauseSchema = z.object({ left: z.string(), op: z.enum(CONDITION_OPS), right: z.string() })
const conditionNode = z.object({
  id: z.string(),
  type: z.literal('condition'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    // Multi-criteria: evaluate `clauses` with all (AND) / any (OR). The legacy
    // single left/op/right is still accepted and treated as a one-clause AND.
    match: z.enum(['all', 'any']).optional(),
    clauses: z.array(conditionClauseSchema).optional(),
    left: z.string().optional(),
    op: z.enum(CONDITION_OPS).optional(),
    right: z.string().optional(),
  }),
})
// Ends the flow early with an optional message.
const stopNode = z.object({
  id: z.string(),
  type: z.literal('stop'),
  data: z.object({ label: z.string().optional(), reason: z.string().optional(), note: z.string().optional() }),
})
// Deterministic single MCP tool call against an org connection — no LLM in the
// loop. `args` is a JSON object literal whose string values may use {{tokens}}.
const toolNode = z.object({
  id: z.string(),
  type: z.literal('tool'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    connectionId: z.string(),
    toolName: z.string(),
    args: z.string().optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    onError: z.enum(['stop', 'continue', 'route']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    perItem: perItemSchema.optional(),
  }),
})
// Plain HTTP request (webhook-out) step. URL/headers/body may use {{tokens}}.
// `connectionId` optionally names an MCP connection whose fresh OAuth token is
// injected as the Authorization header at fetch time — the token itself never
// enters the graph, run rows, or logs.
const httpNode = z.object({
  id: z.string(),
  type: z.literal('http'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    // Two mutually exclusive auth bindings, surfaced as n8n's Authentication
    // modes: credentialId is a "Generic Credential Type" (encrypted reusable
    // HTTP credential, one of the 8 auth methods); connectionId is a
    // "Predefined Credential Type" (an existing MCP-plane integration whose
    // bearer token is injected server-side).
    credentialId: z.string().optional(),
    connectionId: z.string().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('POST'),
    url: z.string(),
    sendQuery: z.boolean().optional(),
    query: z.string().optional(),
    sendHeaders: z.boolean().optional(),
    headers: z.string().optional(),
    sendBody: z.boolean().optional(),
    body: z.string().optional(),
    cookie: z.string().optional(),
    bodyMode: z.enum(['json', 'raw', 'graphql', 'form-urlencoded', 'form-data', 'text', 'none']).optional(),
    contentType: z.string().optional(),
    // 'file' downloads the response body to a stored file and outputs a file
    // reference ({ fileId, filename, url, content? }) instead of the parsed body.
    responseType: z.enum(['auto', 'json', 'text', 'file']).optional(),
    // Off by default: following redirects is opt-in, and each hop is
    // re-checked against the SSRF guard before it is requested.
    followRedirects: z.boolean().optional(),
    failOnHttpError: z.boolean().optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    onError: z.enum(['stop', 'continue', 'route']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    perItem: perItemSchema.optional(),
    // Auto-follow paginated APIs (n8n HTTP pagination parity). `updateParam`
    // increments a query param (page/offset) each request; `nextUrl` follows a
    // next-page URL in the response body. Items from every page are concatenated
    // into the step's output list. Bounded by maxPages; the SSRF guard re-runs
    // per page. Absent → a single request, exactly as before.
    pagination: z
      .object({
        mode: z.enum(['updateParam', 'nextUrl']),
        param: z.string().optional(),
        start: z.number().optional(),
        step: z.number().optional(),
        nextUrlPath: z.string().optional(),
        itemsPath: z.string().optional(),
        maxPages: z.number().int().min(1).max(50).optional(),
        intervalMs: z.number().int().min(0).max(10_000).optional(),
      })
      .optional(),
    // "Optimize response for AI": trim the response before it feeds an agent —
    // drill into a data path, keep only chosen fields, cap the item count.
    optimizeForAi: z
      .object({
        dataPath: z.string().optional(),
        fields: z.array(z.string()).optional(),
        maxItems: z.number().int().min(1).optional(),
      })
      .optional(),
  }),
})
const loopNode = z.object({
  id: z.string(),
  type: z.literal('loop'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    over: z.string(),
    concurrency: z.number().int().min(1).max(20).optional(),
    // Per-iteration error tolerance (mirrors perItemSchema.itemError): 'fail'
    // (default) fails the whole loop on the first failing iteration; 'skip'
    // drops that iteration's result and keeps the rest; 'collect' keeps a
    // { error } placeholder in its slot. Applies when a body step's own
    // onError produced a hard failure (i.e. its default onError: 'stop').
    itemError: z.enum(['fail', 'skip', 'collect']).optional(),
    body: z.array(z.string()),
  }),
})
const parallelNode = z.object({
  id: z.string(),
  type: z.literal('parallel'),
  data: z.object({ label: z.string().optional(),
    note: z.string().optional(), branches: z.array(z.array(z.string())) }),
})
// Deterministic "Set fields": build an object from templated assignments. Its
// output is the assembled object; downstream steps map its fields.
const transformNode = z.object({
  id: z.string(),
  type: z.literal('transform'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    // `value` templates are resolved; JSON-looking results are parsed.
    fields: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
    outputFields: z.array(outputFieldSchema).optional(),
    perItem: perItemSchema.optional(),
  }),
})
// Gate: continues only when the condition passes, else stops the flow (or, in a
// loop body, drops the current item from the collected results).
const filterNode = z.object({
  id: z.string(),
  type: z.literal('filter'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    match: z.enum(['all', 'any']).optional(),
    clauses: z.array(conditionClauseSchema).optional(),
  }),
})
// Multi-way branch: the first case whose condition matches routes to its edge
// (branch=case id); an unmatched signal follows the `default` edge.
const switchNode = z.object({
  id: z.string(),
  type: z.literal('switch'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    cases: z.array(z.object({ id: z.string(), label: z.string().optional(), left: z.string(), op: z.enum(CONDITION_OPS), right: z.string() })).default([]),
  }),
})

/** Operations a variable step can perform on the flow's symbol table. */
export const VARIABLE_OPS = ['initialize', 'set', 'increment', 'decrement', 'appendArray', 'appendString'] as const
export type VariableOp = (typeof VARIABLE_OPS)[number]
/** Types an Initialize variable step can declare (MS Copilot Studio parity). */
export const VARIABLE_TYPES = ['boolean', 'integer', 'float', 'string', 'object', 'array'] as const
export type VariableType = (typeof VARIABLE_TYPES)[number]
/** Display names for variable ops — the ONLY strings surfaces may show for them. */
export const VARIABLE_OP_LABELS: Record<VariableOp, string> = {
  initialize: 'Initialize variable',
  set: 'Set variable',
  increment: 'Increment variable',
  decrement: 'Decrement variable',
  appendArray: 'Append to array variable',
  appendString: 'Append to string variable',
}
/** Display names for variable types (the stored values stay lowercase). */
export const VARIABLE_TYPE_LABELS: Record<VariableType, string> = {
  boolean: 'Boolean',
  integer: 'Integer',
  float: 'Float',
  string: 'String',
  object: 'Object',
  array: 'Array',
}
// Typed symbol table step: initialize declares a variable (varType applies to
// initialize only, default 'string'); the other ops mutate one initialized
// earlier. `value` is templated; readable anywhere via {{var.<name>}}.
const variableNode = z.object({
  id: z.string(),
  type: z.literal('variable'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    op: z.enum(VARIABLE_OPS),
    name: z.string(),
    varType: z.enum(VARIABLE_TYPES).optional(),
    value: z.string().optional(),
  }),
})

/** Pure transforms a data operation step can perform (MS Data Operation parity). */
export const DATA_OPS = ['compose', 'parseJson', 'join', 'csvTable', 'htmlTable', 'filterArray', 'select', 'split', 'replace', 'getItem', 'flatten', 'trim', 'parseCsv'] as const
export type DataOp = (typeof DATA_OPS)[number]
// Deterministic data-shaping step between other steps: no LLM, no I/O. `input`
// is templated (usually an exact {{step.x.output}} token so structure survives);
// the op-specific extras are: `separator` (join), `schema` (parseJson — stored
// for the editor, not yet enforced), `clauses` (filterArray, evaluated per item
// against {{item.*}}), `fields` (select's per-item name/value mappings).
// NOTE: the existing `transform`/`filter` node types stay untouched; `data`
// supersedes them for new graphs (picker copy steers — Task 4).
const dataNode = z.object({
  id: z.string(),
  type: z.literal('data'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    op: z.enum(DATA_OPS),
    input: z.string().optional(),
    separator: z.string().optional(),
    schema: z.string().optional(),
    clauses: z.array(conditionClauseSchema).optional(),
    fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    /** replace: the text to find (required) and its replacement (default ''). */
    find: z.string().optional(),
    replaceWith: z.string().optional(),
    /** getItem: which item to take — 0-based; negatives count from the end. */
    index: z.string().optional(),
    /** trim: how many items to remove (default 1) and from which end. */
    count: z.string().optional(),
    fromEnd: z.boolean().optional(),
    perItem: perItemSchema.optional(),
  }),
})

/** User-authored code, executed by the worker in a short-lived subprocess. */
const codeNode = z.object({
  id: z.string(),
  type: z.literal('code'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    language: z.enum(['javascript', 'python']).default('javascript'),
    mode: z.enum(['all', 'each']).default('all'),
    code: z.string().max(100_000),
    // Exact data tokens preserve objects/arrays; ordinary text is templated.
    input: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(30_000).optional(),
    onError: z.enum(['stop', 'continue', 'route']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    perItem: perItemSchema.optional(),
  }),
})

// MS-parity "Request information" (human review): a first-class pause with no
// agent involved. The flow stops, asks `message` (templated) of a person, and
// the reply becomes this step's output. `assigneeUserId` routes the
// needs-input notification; unset means the run's owner is asked.
const humanReviewNode = z.object({
  id: z.string(),
  type: z.literal('humanReview'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    message: z.string(),
    assigneeUserId: z.string().optional(),
  }),
})

// Named flow outputs (Gumloop parity): a flow declares NAMED outputs that
// callers (webhook response, flow.completed signal, subflow) receive by name,
// instead of the implicit last-step output. Each `value` is templated; `type`
// is a downstream typing hint. A passthrough node — the walk continues.
const outputNode = z.object({
  id: z.string(),
  type: z.literal('output'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    outputs: z.array(z.object({
      name: z.string(),
      value: z.string(),
      type: z.enum(['text', 'list', 'any']).optional(),
    })).default([]),
  }),
})

// Branch merge point (Gumloop "Join Paths" + n8n Merge). Multiple upstream
// branches point their edges at ONE join node so downstream steps aren't
// duplicated per branch. `mode` decides how the incoming branch outputs combine:
//   passthrough (default) — forward the value from whichever branch reached it
//     (only one does when merging condition/switch/error branches — the classic
//     Join Paths). Back-compat: a join with no mode behaves exactly this way.
//   append — concatenate every active branch's items into one list.
//   combineByKey — full outer join of the branches' record lists on `key`.
const joinNode = z.object({
  id: z.string(),
  type: z.literal('join'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    mode: z.enum(['passthrough', 'append', 'combineByKey']).optional(),
    key: z.string().optional(),
  }),
})

// Pause the run and resume later (n8n Wait parity). Like humanReview, a
// first-class pause with no adapter: the interpreter records the resume
// condition and the run goes `waiting`. `duration`/`until` set a resume time
// (FlowRun.resumeAt) that the cron scan wakes; `webhook` mints a one-time
// resume URL that an external system POSTs to (its body becomes this step's
// output). `amount`/`until` are templated; `timeoutMinutes` optionally caps a
// webhook wait so a callback that never arrives can't hang the run forever.
const waitNode = z.object({
  id: z.string(),
  type: z.literal('wait'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    mode: z.enum(['duration', 'until', 'webhook']).default('duration'),
    amount: z.string().optional(),
    unit: z.enum(['seconds', 'minutes', 'hours', 'days']).optional(),
    until: z.string().optional(),
    timeoutMinutes: z.number().int().min(1).optional(),
  }),
})

/** Operations a first-class `ai` step can perform against the org's model. */
export const AI_OPS = ['ask', 'extract', 'categorize', 'summarize', 'score'] as const
export type AiOp = (typeof AI_OPS)[number]
/** Display names for ai ops — the ONLY strings surfaces may show for them. */
export const AI_OP_LABELS: Record<AiOp, string> = {
  ask: 'Ask AI',
  extract: 'Extract data',
  categorize: 'Categorize',
  summarize: 'Summarize',
  score: 'Score',
}
// A single LLM call shaped by `aiOp` (WS14): `input` is the templated content
// the model reads; `instructions` steers the op (freeform guidance for
// ask/summarize, the extraction/categorization/scoring brief for the others).
// `outputFields` names what an extract step pulls; `categories` lists a
// categorize step's buckets; `scoreMin`/`scoreMax` bound a score step's range.
// `model` picks a speed/quality tier — unset defers to the org default.
const aiNode = z.object({
  id: z.string(),
  type: z.literal('ai'),
  data: z.object({
    aiOp: z.enum(AI_OPS),
    input: z.string().optional(),
    instructions: z.string().optional(),
    model: z.enum(['fast', 'smart']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    categories: z.array(z.string()).optional(),
    scoreMin: z.number().optional(),
    scoreMax: z.number().optional(),
    label: z.string().optional(),
    note: z.string().optional(),
    onError: z.enum(['stop', 'continue', 'route']).optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(AGENT_RUN_TIMEOUT_MS).optional(),
    perItem: perItemSchema.optional(),
  }),
})

// Run another flow as one step (WS15): the child's PUBLISHED graph executes
// with this run's data as its input, and its named outputs (or last-step
// output) become this step's output. `inputs` maps the child's declared
// trigger input fields to templated values; `input` is the free-form fallback
// when the child declares none. Nesting is depth-capped at runtime.
const subflowNode = z.object({
  id: z.string(),
  type: z.literal('subflow'),
  data: z.object({
    flowId: z.string(),
    inputs: z.record(z.string(), z.string()).optional(),
    input: z.string().optional(),
    label: z.string().optional(),
    note: z.string().optional(),
    onError: z.enum(['stop', 'continue', 'route']).optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(AGENT_RUN_TIMEOUT_MS).optional(),
    perItem: perItemSchema.optional(),
  }),
})

// Search the workspace's uploaded knowledge (pgvector over KnowledgeChunk):
// `query` is templated; output is a list of hits {content, filename, score}
// for downstream loops/AI steps. Read-only and best-effort — no reliability
// envelope needed (retrieval never throws; no results = an empty list).
const knowledgeNode = z.object({
  id: z.string(),
  type: z.literal('knowledge'),
  data: z.object({
    query: z.string().optional(),
    topK: z.number().int().min(1).max(20).optional(),
    label: z.string().optional(),
    note: z.string().optional(),
    perItem: perItemSchema.optional(),
  }),
})

// Optional persisted canvas position for the DAG builder. Absent on every
// pre-canvas flow (and freshly-created nodes) — the builder auto-lays those out
// with dagre and persists positions thereafter. Purely presentational: the
// interpreter and validator ignore it.
const nodePositionSchema = z.object({ x: z.number(), y: z.number() }).optional()

export const flowNodeSchema = z
  .discriminatedUnion('type', [
    triggerNode, agentNode, conditionNode, loopNode, parallelNode, stopNode, toolNode, httpNode, transformNode, filterNode, switchNode, variableNode, dataNode, codeNode, humanReviewNode, outputNode, joinNode, aiNode, subflowNode, knowledgeNode, waitNode,
  ])
  // Node-level flags shared by every type. `disabled` skips the step at run time
  // (passthrough — the prior value flows on), for muting a step while debugging.
  .and(z.object({ position: nodePositionSchema, disabled: z.boolean().optional() }))
export const flowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  // 'true'/'false' for a condition; a switch case id or 'default' for a switch.
  branch: z.string().optional(),
})
// Hard caps on graph size. Far above any real flow (hundreds of steps is already
// extreme), but low enough that a crafted multi-MB payload can't be stored and
// then re-validated in memory on every open. The App Router doesn't inherit the
// old 1MB body limit, so this schema is the effective bound on a graph PUT.
export const MAX_GRAPH_NODES = 1000
export const MAX_GRAPH_EDGES = 2000
export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema).max(MAX_GRAPH_NODES, `A flow can have at most ${MAX_GRAPH_NODES} steps.`),
  edges: z.array(flowEdgeSchema).max(MAX_GRAPH_EDGES, `A flow can have at most ${MAX_GRAPH_EDGES} connections.`),
  // Pinned / mock output per node id: when present, the executor uses this
  // value instead of running the node, so downstream steps can be built and
  // tested without live calls. Mirrors n8n's workflow-level pinData.
  pinData: z.record(z.string(), z.unknown()).optional(),
})

export type FlowNode = z.infer<typeof flowNodeSchema>
export type FlowEdge = z.infer<typeof flowEdgeSchema>
export type FlowGraph = z.infer<typeof flowGraphSchema>
export type ConditionClause = z.infer<typeof conditionClauseSchema>

/** A fresh graph: one manual trigger, no steps yet. */
export function emptyGraph(): FlowGraph {
  return { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }], edges: [] }
}
