import { prisma } from '@/lib/prisma'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { loadFlowToolCatalog, type FlowToolCatalogConnection } from '@/lib/flows/tool-catalog'
import { outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'

function toolInputHint(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return ''
  const shape = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
  const props = Object.entries(shape.properties ?? {}).slice(0, 8)
  if (!props.length) return ''
  const required = new Set(shape.required ?? [])
  return props.map(([name, prop]) => `${name}${required.has(name) ? '*' : ''}:${prop.type ?? 'any'}`).join(', ')
}

function toolOutputHint(schema: unknown): string {
  const fields = outputFieldsFromJsonSchema(schema, 8)
  return fields.map((field) => `${field.name}:${field.type}`).join(', ')
}

const graphRules =
  'You design runnable workflow graphs for Backstory Studio. Return a single JSON object with one property, graphJson: a JSON string containing the flow graph, shaped as {"nodes": [...], "edges": [...]}. ' +
  'Always include one trigger node with id "trigger". Prefer deterministic tool nodes for concrete integration actions and agent nodes for reasoning/writing decisions. ' +
  'Allowed node types: agent, tool, http, transform, filter, condition, switch, loop, parallel, stop, variable, data, code, humanReview, output, join, ai, subflow, knowledge. ' +
  'If the flow expects named input fields, put them on the trigger as data.trigger.inputFields: [{name,type,description}]. ' +
  'Agent data: {agentId, label, input, includeUpstreamContext}; agentId MUST be from the agent roster. includeUpstreamContext controls whether every earlier step\'s captured output (API/query data etc.) is appended to the agent prompt: omit for auto (appended only when input has no {{step...}}/{{steps}} reference), true to always append, false never. For "gather data with API/tool steps, then have an agent reason over all of it", chain the data steps before the agent and leave includeUpstreamContext at auto (or set true) — you need not hand-wire every {{step.<id>.output}} token. ' +
  'HTTP output also exposes {{step.<httpNodeId>.output.data}} as an alias of .body (the parsed API response). ' +
  'Aggregate token {{steps}} resolves to an object of every earlier step\'s output keyed by step label (HTTP steps unwrapped to their body); use it to feed an agent/ai step everything gathered so far in one token, or {{steps.<Step Label>}} for one. ' +
  'Tool data: {connectionId, toolName, label, args, retries, timeoutMs}; connectionId/toolName MUST be from available tools and args MUST be a JSON object string. Use retries for flaky external actions and timeoutMs for slow tools. ' +
  'Trigger inputFields may set format: "file" on an object-typed field — the run form shows an upload and the value arrives as {filename, content} with the file\'s text. For required tool args that should come from the run form, declare trigger inputFields and map args to {{trigger.input.fieldName}}. ' +
  'HTTP data: {method,url,credentialId,sendQuery,query,sendHeaders,headers,sendBody,bodyMode,contentType,responseType,failOnHttpError,retries,timeoutMs,body}; method is GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS. query and headers are JSON object strings enabled by their send toggles. bodyMode is json/raw/graphql/form-urlencoded/none; JSON and form-urlencoded bodies use JSON object strings, while raw and GraphQL accept raw text. credentialId may only reference a verified reusable HTTP credential already present in the flow context; otherwise omit it. responseType is auto/json/text. ' +
  'HTTP output is an object with ok, status, statusText, url, headers, body, and bodyText; use {{step.<httpNodeId>.output.body}} for parsed API response data and {{step.<httpNodeId>.output.status}} for status checks. ' +
  'Variable data: {op, name, varType, value}; op is initialize/set/increment/decrement/appendArray/appendString; initialize declares the variable (free name, varType one of boolean/integer/float/string/object/array, optional starting value) and MUST come before any mutation of that name; varType is only for initialize; value is templated and optional for increment/decrement (defaults to 1); read a variable anywhere with {{var.<name>}}. ' +
  'Data (data operation) node data: {op, input, separator, schema, clauses, fields, find, replaceWith, index, count, fromEnd}; op is compose/parseJson/join/csvTable/htmlTable/filterArray/select/split/replace/getItem/flatten/trim/parseCsv (parseCsv: CSV text with a header row -> list of records); input is templated and usually an exact {{step.<nodeId>.output}} token so structure survives; separator is join/split; schema is parseJson-only (optional, stored for reference); clauses is filterArray-only (left/op/right evaluated per item against {{item.*}}); fields is select-only ([{name,value}] with {{item.*}} values); find/replaceWith are replace-only; index is getItem-only (0-based, negatives from the end); count/fromEnd are trim-only. Prefer data nodes over transform/filter for new graphs. ' +
  'Code data: {language, mode, code, input, timeoutMs}; language is javascript or python; mode is all or each; input is a templated value available to code as input; code must return a JSON-compatible value. Use code only when built-in data operations cannot express the transform. Imports, files, network, and child processes are unavailable. ' +
  'HumanReview data: {message, assigneeUserId}; message (required, templated) is the question asked; the run pauses at this step until the person replies and the reply becomes {{step.<nodeId>.output}}; omit assigneeUserId to ask the flow owner. ' +
  'Output data: {outputs: [{name, value, type}]}; a passthrough step that returns NAMED results to the caller (webhook response, flow.completed signal). Each value is templated (usually a {{step.<nodeId>.output}} token); type is text/list/any; names must be unique and non-empty. Add an output node near the end when the flow should return specific fields instead of the implicit last-step output. ' +
  'Join data: {label, note}; a no-config merge point — point condition/switch/error branch edges at ONE join node so downstream steps run once instead of being duplicated per branch. Its output is the value from whichever branch reached it. ' +
  'Flows are directed ACYCLIC graphs and a step MAY have multiple incoming edges (fan-in): it runs exactly once, after every incoming path resolves, and can read each parent via {{step.<id>.output}} or the {{steps}} aggregate. Several independent steps (e.g. query-API calls) can therefore run in parallel and fan into one agent that reasons over all of them. Condition/Switch branches that are not taken are pruned (dead-path elimination), so a fan-in node after a branch runs once with whichever path ran. NEVER create a cycle — an edge that loops back to an earlier step is invalid; to retry a step, set its retries instead. ' +
  'AI step data: {aiOp, input, instructions, model, outputFields, categories, scoreMin, scoreMax}; aiOp is ask/extract/categorize/summarize/score; input is the templated content to operate on (usually a {{step.<nodeId>.output}} or {{trigger.input}} token); instructions is the prompt (ask) or optional guidance (others); model is "fast" (default) or "smart". Per op: extract requires outputFields [{name,type}] and outputs an object with those fields; categorize requires categories (>=2 strings) and outputs {category}; score outputs {score, reason} within scoreMin..scoreMax (default 1..10); ask/summarize output plain text. Prefer an ai step for one-off prompts inside a flow; use an agent step only when a roster agent (with its tools and memory) is needed. ' +
  'Subflow data: {flowId, inputs, input}; runs another flow in this workspace as one step (its PUBLISHED version). flowId must be an EXISTING flow id from the workspace context — never invent one, and never point a flow at itself. inputs maps the child flow\'s declared trigger input field names to templated values; input is the free-form fallback when the child declares no fields. The step\'s output is the child\'s named outputs object (or its last step\'s output) — reference it like any step output. Nesting is capped at 5 levels. ' +
  'Knowledge data: {query, topK}; searches the workspace\'s uploaded documents semantically and outputs a LIST of hits [{content, filename, score}] — loop over it or feed it to an ai step. query is templated; topK (1-20, default 5) bounds the hits. ' +
  'Error paths: agent/ai/subflow/tool/http/code data may set onError to "stop" (default), "continue", or "route". With "route", a failing step outputs {error, input} and the walk follows the node\'s edge with branch "error" instead of the normal edge; a downstream step can read {{step.<nodeId>.output.error}} and, e.g., route to a join. Add an "error"-branch edge when using route. ' +
  'Use data references only when needed: {{trigger.input}}, {{step.<nodeId>.output}}, {{step.<nodeId>.output.field}}, {{steps}}, {{steps.<Step Label>}}, {{item}}, {{item.field}}, {{loop.index}}, {{var.<name>}}, {{now}}, {{now.date}}, {{now.time}}, {{now.unix}}, {{run.id}}, {{run.trigger}}, {{run.startedAt}}, {{run.url}}, {{flow.name}} — the now/run/flow tokens are set automatically for every run. ' +
  'For loops, data.over should point at a list and data.body should contain nested node ids. For condition/filter, use data.clauses with left/op/right. ' +
  'Edges connect node ids; condition edges use branch "true"/"false"; switch edges use case ids or "default". ' +
  'When a later step references {{step.<agentNodeId>.output.<field>}}, that agent node MUST set responseFormat: "structured" and declare outputFields: [{name,type}] matching the referenced fields.'

export async function buildCopilotGrounding(
  organizationId: string,
  userId: string,
  options: {
    /**
     * Cross-workspace guest editing a shared flow: the flow RUNS in its
     * owner's org, so grounding on the caller's roster/tool catalog would
     * inject agent/connection ids that resolve to nothing there — and
     * grounding on the owner's would leak that workspace's roster to an
     * outsider. Structure-only sidesteps both: no roster, no tools, and the
     * sanitizer (fed the same empty context) discards any agent/tool op the
     * model invents anyway.
     */
    structureOnly?: boolean
  } = {},
): Promise<{
  roster: { id: string; name: string }[]
  toolCatalog: FlowToolCatalogConnection[]
  httpCredentials: { id: string; name: string; allowedHost: string }[]
  contextBlock: string
  graphRules: string
}> {
  if (options.structureOnly) {
    const contextBlock = [
      'Agents:\n- None available on this flow — it is shared with you from another workspace. Do not add agent steps.',
      '',
      'Tools:\n- None available on this flow — do not add tool steps. Use http, ai, data, code, condition and the other generic steps instead.',
    ].join('\n')
    return { roster: [], toolCatalog: [], httpCredentials: [], contextBlock, graphRules }
  }
  const [agents, toolCatalog, httpCredentials] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId, status: 'ACTIVE', ...agentVisibilityScope(userId) },
      select: { id: true, description: true, metadata: true },
      take: 100,
    }),
    loadFlowToolCatalog(organizationId, { userId, takeConnections: 25, takeTools: 100 }),
    prisma.httpCredential.findMany({
      where: { organizationId, status: 'verified' },
      select: { id: true, name: true, allowedHost: true },
      take: 50,
    }),
  ])
  const roster = agents
    .map((agent) => ({ id: agent.id, name: readAgentMetadata(agent.metadata).title || agent.description }))
    .filter((entry) => entry.name)
  const tools = toolCatalog.flatMap((connection) =>
    connection.tools.map((tool) => ({
      connectionId: connection.id,
      connectionName: connection.name,
      name: tool.name,
      description: tool.description,
      inputHint: toolInputHint(tool.inputSchema),
      outputHint: toolOutputHint(tool.outputSchema),
    })),
  )
  const contextBlock = [
    `Agents:\n${roster.map((entry) => `- ${entry.name} (id: ${entry.id})`).join('\n') || '- None available'}`,
    '',
    `Tools:\n${tools.map((tool) => `- ${tool.connectionName}: ${tool.name} (connectionId: ${tool.connectionId})${tool.inputHint ? ` args: ${tool.inputHint}` : ''}${tool.outputHint ? ` outputs: ${tool.outputHint}` : ''}${tool.description ? ` — ${tool.description}` : ''}`).join('\n') || '- None available'}`,
    '',
    `HTTP credentials (verified; bind one to an http step with data.credentialId — each works only for its host):\n${httpCredentials.map((credential) => `- ${credential.name} (credentialId: ${credential.id}, host: ${credential.allowedHost})`).join('\n') || '- None available — to authenticate an http step the user must create a credential under Integrations → HTTP credentials, or you can bind an MCP connection via data.connectionId.'}`,
  ].join('\n')
  return { roster, toolCatalog, httpCredentials, contextBlock, graphRules }
}
