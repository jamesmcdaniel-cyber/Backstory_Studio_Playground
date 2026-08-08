import { AI_OP_LABELS, FIELD_TYPES, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { FLOW_TRIGGER_TYPES } from '@/lib/flows/trigger'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { matchBrandHint, type ToolBrand } from '@/lib/flows/tool-presentation'
import { buildAdjacency, findCycle } from '@/lib/flows/dag-scheduler'

export type FlowValidationIssue = {
  level: 'error' | 'warning'
  code: string
  message: string
  nodeId?: string
}

export type FlowValidationContext = {
  agents?: { id: string; title?: string }[]
  toolCatalog?: { id: string; name?: string; tools?: { name: string; inputSchema?: unknown }[]; toolsError?: string }[]
  /** Reusable HTTP credentials visible to the executing workspace. */
  httpCredentials?: { id: string }[]
  /** Set by publish validation; omitted for draft/manual-run validation. */
  webhookSecretConfigured?: boolean
  requireRunnable?: boolean
  /** The flow being validated — lets subflow steps flag direct self-reference. */
  flowId?: string
}

export type FlowValidationResult = {
  ok: boolean
  errors: FlowValidationIssue[]
  warnings: FlowValidationIssue[]
  issues: FlowValidationIssue[]
}

function nodeLabel(node: FlowNode | undefined) {
  if (!node) return 'Unknown step'
  const label = 'label' in node.data && typeof node.data.label === 'string' ? node.data.label.trim() : ''
  if (label) return label
  switch (node.type) {
    case 'trigger':
      return 'Trigger'
    case 'agent':
      return 'Run agent'
    case 'tool':
      return 'Tool call'
    case 'http':
      return 'HTTP request'
    case 'loop':
      return 'For each'
    case 'parallel':
      return 'Parallel'
    case 'condition':
      return 'If / else'
    case 'switch':
      return 'Switch'
    case 'transform':
      return 'Set fields'
    case 'filter':
      return 'Filter'
    case 'stop':
      return 'Stop'
    case 'data':
      // Single source of truth — a new op added to DATA_OP_LABELS is covered here automatically.
      return DATA_OP_LABELS[node.data.op]
    case 'ai':
      return AI_OP_LABELS[node.data.aiOp]
    case 'subflow':
      return 'Run a flow'
    case 'knowledge':
      return 'Search knowledge'
    case 'code':
      return node.data.language === 'python' ? 'Python' : 'JavaScript'
    case 'humanReview':
      return 'Request information'
    case 'note':
      return 'Note'
    case 'wait':
      return 'Wait'
    case 'output':
      return 'Output'
    case 'join':
      return 'Join'
    case 'variable':
      switch (node.data.op) {
        case 'initialize':
          return 'Initialize variable'
        case 'set':
          return 'Set variable'
        case 'increment':
          return 'Increment variable'
        case 'decrement':
          return 'Decrement variable'
        case 'appendArray':
          return 'Append to array variable'
        case 'appendString':
          return 'Append to string variable'
      }
  }
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function add(
  issues: FlowValidationIssue[],
  level: FlowValidationIssue['level'],
  code: string,
  message: string,
  nodeId?: string,
) {
  issues.push({ level, code, message, ...(nodeId ? { nodeId } : {}) })
}

function hasTemplate(value: string | undefined): boolean {
  return Boolean(value?.includes('{{'))
}

// Import-skeleton placeholders: YOUR_ACCOUNT-style tokens and <angle-bracket>
// fill-ins. Case-sensitive on the YOUR_ prefix (real hosts are lowercase);
// the angle form requires a letter start so JSX-ish content can't match.
const PLACEHOLDER_RE = /YOUR_[A-Z][A-Z0-9_]*|<[a-z][a-z0-9 _-]*>/

function validateHttpUrl(issues: FlowValidationIssue[], value: string, nodeId: string) {
  if (!value.trim()) {
    add(issues, 'error', 'MISSING_HTTP_URL', 'HTTP request needs a URL.', nodeId)
    return
  }
  if (hasTemplate(value)) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') {
      add(issues, 'error', 'INVALID_HTTP_URL', 'HTTP request URL must start with https://.', nodeId)
    }
  } catch {
    add(issues, 'error', 'INVALID_HTTP_URL', 'HTTP request URL is not valid.', nodeId)
  }
}

/** The provider a URL's host points at (…snowflakecomputing.com → Snowflake), or
 *  null for unknown hosts and templated URLs whose host isn't literal. */
function httpUrlBrand(url: string): ToolBrand | null {
  if (!url.trim() || hasTemplate(url)) return null
  try {
    const brand = matchBrandHint(new URL(url).hostname)
    return brand && brand.key !== 'http' ? brand : null
  } catch {
    return null
  }
}

function validateJsonObjectField(issues: FlowValidationIssue[], value: string | undefined, message: string, nodeId: string) {
  if (!value?.trim() || hasTemplate(value)) return
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) add(issues, 'error', 'INVALID_JSON_OBJECT', message, nodeId)
  } catch {
    add(issues, 'error', 'INVALID_JSON_OBJECT', message, nodeId)
  }
}

function validateTemplatedJsonField(issues: FlowValidationIssue[], value: string | undefined, message: string, nodeId: string) {
  if (!value?.trim() || hasTemplate(value)) return
  try {
    JSON.parse(value)
  } catch {
    add(issues, 'error', 'INVALID_JSON', message, nodeId)
  }
}

function parseObjectJson(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validateTriggerConfig(
  issues: FlowValidationIssue[],
  trigger: unknown,
  context: Pick<FlowValidationContext, 'webhookSecretConfigured'> = {},
) {
  if (trigger === undefined) return
  if (!isRecord(trigger)) {
    add(issues, 'error', 'INVALID_TRIGGER_CONFIG', 'The Trigger configuration is invalid.', 'trigger')
    return
  }
  const type = trigger.type
  if (type !== undefined && (typeof type !== 'string' || !(FLOW_TRIGGER_TYPES as readonly string[]).includes(type))) {
    add(issues, 'error', 'INVALID_TRIGGER_TYPE', 'The Trigger type is not supported.', 'trigger')
    return
  }
  if (trigger.inputFields !== undefined) {
    if (!Array.isArray(trigger.inputFields)) {
      add(issues, 'error', 'INVALID_INPUT_FIELDS', 'Trigger input fields are invalid.', 'trigger')
    } else {
      const names = trigger.inputFields
        .filter(isRecord)
        .map((field) => (typeof field.name === 'string' ? field.name.trim() : ''))
      names.forEach((name, index) => {
        if (!name) add(issues, 'error', 'MISSING_INPUT_FIELD_NAME', `Trigger input field ${index + 1} needs a name.`, 'trigger')
      })
      for (const name of unique(names.filter(Boolean))) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_INPUT_FIELD', `Trigger has duplicate input field "${name}".`, 'trigger')
        }
      }
      trigger.inputFields.filter(isRecord).forEach((field, index) => {
        if (field.type !== undefined && (typeof field.type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(field.type))) {
          add(issues, 'error', 'INVALID_INPUT_FIELD_TYPE', `Trigger input field ${index + 1} has an invalid type.`, 'trigger')
        }
      })
    }
  }
  if (type === 'poll') {
    if (!String(trigger.connectionId ?? '').trim()) {
      add(issues, 'error', 'MISSING_POLL_CONNECTION', 'A polling trigger needs an app connection to check.', 'trigger')
    }
    if (!String(trigger.toolName ?? '').trim()) {
      add(issues, 'error', 'MISSING_POLL_TOOL', 'A polling trigger needs a read action to check for new items.', 'trigger')
    }
    if (!isRecord(trigger.schedule)) {
      add(issues, 'error', 'MISSING_POLL_SCHEDULE', 'A polling trigger needs a check frequency.', 'trigger')
    }
    return
  }
  if (type === 'signal' && !String(trigger.signal ?? '').trim()) {
    add(issues, 'error', 'MISSING_SIGNAL', 'A signal trigger needs a signal name.', 'trigger')
  }
  if (type === 'webhook' && context.webhookSecretConfigured === false) {
    add(issues, 'error', 'MISSING_WEBHOOK_SECRET', 'Create a webhook secret before publishing this flow.', 'trigger')
  }
  if (type !== 'schedule') return
  const schedule = trigger.schedule
  if (!isRecord(schedule)) {
    add(issues, 'error', 'MISSING_SCHEDULE', 'Scheduled triggers need a schedule.', 'trigger')
    return
  }
  const scheduleType = typeof schedule.type === 'string' ? schedule.type : 'daily'
  if (['daily', 'weekly', 'once'].includes(scheduleType) && !String(schedule.time ?? '').trim()) {
    add(issues, 'error', 'MISSING_SCHEDULE_TIME', 'Scheduled triggers need a run time.', 'trigger')
  }
  if (scheduleType === 'once' && !String(schedule.runAt ?? '').trim()) {
    add(issues, 'error', 'MISSING_SCHEDULE_DATE', 'One-time scheduled triggers need a date.', 'trigger')
  }
  if (scheduleType === 'cron' && !String(schedule.cron ?? '').trim()) {
    add(issues, 'error', 'MISSING_CRON', 'Cron scheduled triggers need a cron expression.', 'trigger')
  }
}

function requiredToolArgs(inputSchema: unknown): string[] {
  if (!isRecord(inputSchema)) return []
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') return []
  return Array.isArray(inputSchema.required) ? inputSchema.required.filter((item): item is string => typeof item === 'string') : []
}

function argHasValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
}

function conditionClauses(node: Extract<FlowNode, { type: 'condition' | 'filter' }>) {
  if (node.data.clauses?.length) return node.data.clauses
  if (node.type === 'condition' && (node.data.left !== undefined || node.data.right !== undefined)) {
    return [{ left: node.data.left ?? '', op: node.data.op ?? 'contains', right: node.data.right ?? '' }]
  }
  return []
}

function isAgentStructured(agent: Extract<FlowNode, { type: 'agent' }> | undefined): boolean {
  if (!agent) return false
  if (agent.data.responseFormat === 'structured') {
    const hasNonBlankField = agent.data.outputFields?.some((field) => typeof field.name === 'string' && field.name.trim())
    return hasNonBlankField ?? false
  }
  return false
}

/** Nodes reachable from `startId` via edges + container membership (inclusive). */
function reachableFrom(graph: FlowGraph, startId: string): Set<string> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    const node = byId.get(id)
    if (!node) return
    seen.add(id)
    if (node.type === 'loop') node.data.body.forEach(visit)
    if (node.type === 'parallel') node.data.branches.flat().forEach(visit)
    graph.edges.filter((edge) => edge.source === id).forEach((edge) => visit(edge.target))
  }
  visit(startId)
  return seen
}

function reachableNodeIds(graph: FlowGraph): Set<string> {
  return reachableFrom(graph, 'trigger')
}

/**
 * Variable step checks. "Initialized earlier" is validated cheaply: the graph
 * has no full topological order helper, so a mutation is flagged when NO
 * initialize of its name exists, or when every initialize sits strictly
 * downstream of it (reachable from the mutation — definitely later). An
 * initialize in a sibling branch can't be ordered cheaply and is allowed;
 * the interpreter fails those cleanly at runtime ("hasn't been initialized").
 */
function validateVariableNodes(graph: FlowGraph, issues: FlowValidationIssue[]) {
  const variableNodes = graph.nodes.filter((node): node is Extract<FlowNode, { type: 'variable' }> => node.type === 'variable')
  if (!variableNodes.length) return
  const initializers = variableNodes.filter((node) => node.data.op === 'initialize')
  const initNames = initializers.map((node) => node.data.name.trim()).filter(Boolean)
  for (const name of unique(initNames)) {
    if (initNames.filter((entry) => entry === name).length > 1) {
      const dupes = initializers.filter((node) => node.data.name.trim() === name)
      for (const dupe of dupes.slice(1)) {
        add(issues, 'error', 'DUPLICATE_VARIABLE', `Two steps initialize the variable "${name}" — give each its own name.`, dupe.id)
      }
    }
  }
  for (const node of variableNodes) {
    const name = node.data.name.trim()
    if (!name) {
      add(issues, 'error', 'MISSING_VARIABLE_NAME', `${nodeLabel(node)} needs a variable name.`, node.id)
      continue
    }
    if (['set', 'appendArray', 'appendString'].includes(node.data.op) && !node.data.value?.trim()) {
      add(issues, 'error', 'MISSING_VARIABLE_VALUE', `${nodeLabel(node)} needs a value.`, node.id)
    }
    if (node.data.op === 'initialize') continue
    const declarations = initializers.filter((init) => init.data.name.trim() === name)
    const downstream = reachableFrom(graph, node.id)
    // Not downstream of the mutation = earlier on its path, or in a sibling
    // branch we can't cheaply order (allowed; the interpreter fails cleanly).
    const earlier = declarations.filter((init) => !downstream.has(init.id))
    if (!earlier.length) {
      add(issues, 'error', 'UNINITIALIZED_VARIABLE', `${nodeLabel(node)} needs the variable "${name}" to be initialized earlier in the flow.`, node.id)
      continue
    }
    if (node.data.op === 'increment' || node.data.op === 'decrement') {
      const numeric = earlier.some((init) => ['integer', 'float'].includes(init.data.varType ?? 'string'))
      if (!numeric) {
        add(issues, 'error', 'VARIABLE_NOT_NUMERIC', `${nodeLabel(node)} needs "${name}" to be a number variable.`, node.id)
      }
    }
  }
}

export function validateFlowGraph(graph: FlowGraph, context: FlowValidationContext = {}): FlowValidationResult {
  const issues: FlowValidationIssue[] = []
  const agentIds = new Set((context.agents ?? []).map((agent) => agent.id))
  const connectionIds = new Set((context.toolCatalog ?? []).map((connection) => connection.id))
  const toolNamesByConnection = new Map((context.toolCatalog ?? []).map((connection) => [
    connection.id,
    new Set((connection.tools ?? []).map((tool) => tool.name)),
  ]))
  const toolErrorsByConnection = new Map((context.toolCatalog ?? []).map((connection) => [connection.id, connection.toolsError]))
  const httpCredentialIds = new Set((context.httpCredentials ?? []).map((credential) => credential.id))
  const toolsByConnection = new Map((context.toolCatalog ?? []).map((connection) => [
    connection.id,
    new Map((connection.tools ?? []).map((tool) => [tool.name, tool])),
  ]))
  const byId = new Map<string, FlowNode>()
  const triggerIds = graph.nodes.filter((node) => node.type === 'trigger').map((node) => node.id)

  for (const node of graph.nodes) {
    if (byId.has(node.id)) add(issues, 'error', 'DUPLICATE_NODE_ID', `Multiple steps use the id "${node.id}".`, node.id)
    byId.set(node.id, node)
  }

  if (triggerIds.length !== 1 || triggerIds[0] !== 'trigger') {
    add(issues, 'error', 'INVALID_TRIGGER', 'The flow needs exactly one Trigger step with id "trigger".')
  }
  const triggerNode = graph.nodes.find((node): node is Extract<FlowNode, { type: 'trigger' }> => node.type === 'trigger')
  validateTriggerConfig(issues, triggerNode?.data.trigger, context)

  const actionable = graph.nodes.filter((node) => node.type !== 'trigger')
  if (context.requireRunnable !== false && actionable.length === 0) {
    add(issues, 'error', 'NO_STEPS', 'Add at least one step before running or publishing this flow.')
  }

  for (const edge of graph.edges) {
    if (!byId.has(edge.source)) add(issues, 'error', 'DANGLING_EDGE', `An edge starts from missing step "${edge.source}".`)
    if (!byId.has(edge.target)) add(issues, 'error', 'DANGLING_EDGE', `An edge points to missing step "${edge.target}".`)
  }

  for (const node of graph.nodes) {
    if (node.type === 'agent') {
      if (!node.data.agentId) {
        add(issues, 'error', 'MISSING_AGENT', `${nodeLabel(node)} needs an agent.`, node.id)
      } else if (context.agents && !agentIds.has(node.data.agentId)) {
        add(issues, 'error', 'UNKNOWN_AGENT', `${nodeLabel(node)} uses an agent that is not available.`, node.id)
      }
      if (!node.data.input?.trim()) {
        add(issues, 'warning', 'EMPTY_AGENT_INPUT', `${nodeLabel(node)} has an empty message.`, node.id)
      }
      // Step-granted tool connections get the same existence/health checks as
      // tool steps — an agent whose prompt assumes tools it can't actually
      // reach produces confident hallucinated output, not an error.
      if (context.toolCatalog) {
        for (const grantedId of node.data.toolConnectionIds ?? []) {
          if (!connectionIds.has(grantedId)) {
            add(issues, 'error', 'UNKNOWN_AGENT_TOOL_CONNECTION', `${nodeLabel(node)} grants the agent a tool connection that is not available — re-pick it under Tools.`, node.id)
          } else if (toolErrorsByConnection.get(grantedId)) {
            add(issues, 'error', 'AGENT_TOOL_CONNECTION_UNAVAILABLE', `${nodeLabel(node)} grants the agent a connection that can't be reached — reconnect it in Integrations.`, node.id)
          }
        }
      }
    }

    if (node.type === 'tool') {
      if (!node.data.connectionId) {
        add(issues, 'error', 'MISSING_TOOL_CONNECTION', `${nodeLabel(node)} needs a connection.`, node.id)
      } else if (context.toolCatalog && !connectionIds.has(node.data.connectionId)) {
        add(issues, 'error', 'UNKNOWN_TOOL_CONNECTION', `${nodeLabel(node)} uses a connection that is not available.`, node.id)
      } else if (toolErrorsByConnection.get(node.data.connectionId)) {
        add(issues, 'error', 'TOOL_CONNECTION_UNAVAILABLE', `${nodeLabel(node)} cannot reach its connection — reconnect it in Integrations and try again.`, node.id)
      }
      if (!node.data.toolName) {
        add(issues, 'error', 'MISSING_TOOL', `${nodeLabel(node)} needs a tool.`, node.id)
      } else if (context.toolCatalog && toolNamesByConnection.get(node.data.connectionId)?.size) {
        const knownTools = toolNamesByConnection.get(node.data.connectionId)
        if (knownTools && !knownTools.has(node.data.toolName)) {
          add(issues, 'error', 'UNKNOWN_TOOL', `${nodeLabel(node)} uses a tool that is not available on the selected connection.`, node.id)
        }
      }
      validateJsonObjectField(issues, node.data.args, `${nodeLabel(node)} arguments must be a JSON object.`, node.id)
      const selectedTool = toolsByConnection.get(node.data.connectionId)?.get(node.data.toolName)
      const requiredArgs = requiredToolArgs(selectedTool?.inputSchema)
      if (requiredArgs.length) {
        const parsedArgs = parseObjectJson(node.data.args)
        if (parsedArgs) {
          for (const argName of requiredArgs) {
            if (!argHasValue(parsedArgs[argName])) {
              add(issues, 'error', 'MISSING_TOOL_ARG', `${nodeLabel(node)} needs "${argName}".`, node.id)
            }
          }
        }
      }
    }

    if (node.type === 'http') {
      validateHttpUrl(issues, node.data.url, node.id)
      // Placeholder skeletons: the n8n importer deliberately emits
      // YOUR_ACCOUNT-style hosts when it can't map a credentialed app node.
      // They parse as valid URLs, "succeed" into fail-soft paths downstream,
      // and quietly produce empty data — block them loudly instead.
      if (!hasTemplate(node.data.url) && PLACEHOLDER_RE.test(node.data.url)) {
        add(issues, 'error', 'PLACEHOLDER_VALUE', `${nodeLabel(node)} still has a placeholder in its URL — replace it with your real account address.`, node.id)
      }
      // Flow data pasted into a quoted SQL literal: one apostrophe in the data
      // breaks the statement, and %/_ wildcards fuzz the match. The SQL APIs
      // this pattern targets (Snowflake &c.) all take bind variables.
      const sqlField = (() => {
        const parsed = parseObjectJson(node.data.body)
        if (!parsed) return undefined
        for (const key of ['statement', 'sql', 'query']) {
          const value = parsed[key]
          if (typeof value === 'string') return value
        }
        return undefined
      })()
      if (sqlField && /'[^']*\{\{[^}]+\}\}[^']*'/.test(sqlField)) {
        add(issues, 'warning', 'SQL_TOKEN_IN_LITERAL', `${nodeLabel(node)} pastes flow data directly into a SQL string — a quote in the data breaks the query. Use the API's bind variables instead.`, node.id)
      }
      // No zero-auth requests: every HTTP step must authenticate, either by
      // reusing a connected integration or with a stored credential. When the
      // URL points at a provider we recognize, the message says whether that
      // integration is already connected on the platform or still needs to be.
      if (!node.data.connectionId && !node.data.credentialId) {
        const brand = httpUrlBrand(node.data.url)
        const connected =
          brand && (context.toolCatalog ?? []).some((connection) => matchBrandHint(connection.name ?? '')?.key === brand.key)
        const message = brand
          ? connected
            ? `${nodeLabel(node)} calls ${brand.label} without authentication — reuse your connected ${brand.label} integration or set up a credential for this host.`
            : `${nodeLabel(node)} calls ${brand.label} without authentication — connect ${brand.label} in Integrations or set up a credential for this host.`
          : `${nodeLabel(node)} sends its request without authentication — reuse a connected integration or set up a credential for this host.`
        add(issues, 'error', 'HTTP_NO_AUTH', message, node.id)
      }
      if (node.data.connectionId && node.data.credentialId) {
        add(issues, 'error', 'AMBIGUOUS_HTTP_AUTH', `${nodeLabel(node)} has two authentication methods selected — keep either a predefined connection or a generic credential.`, node.id)
      }
      if (node.data.connectionId && parseFlowToolConnectionId(node.data.connectionId).plane !== 'mcp') {
        add(issues, 'error', 'INVALID_HTTP_AUTH_CONNECTION', `${nodeLabel(node)} can only use an MCP connection for predefined authentication — choose one from the HTTP authentication settings.`, node.id)
      }
      if (node.data.connectionId && context.toolCatalog && !connectionIds.has(node.data.connectionId)) {
        add(issues, 'error', 'UNKNOWN_HTTP_CONNECTION', `${nodeLabel(node)} authenticates with a connection that is not available — pick another connection or reconnect it in Integrations.`, node.id)
      }
      if (node.data.credentialId && context.httpCredentials && !httpCredentialIds.has(node.data.credentialId)) {
        add(issues, 'error', 'UNKNOWN_HTTP_CREDENTIAL', `${nodeLabel(node)} uses an HTTP credential that is not available — choose or create another credential.`, node.id)
      }
      if (node.data.sendHeaders !== false) {
        validateJsonObjectField(issues, node.data.headers, `${nodeLabel(node)} headers must be a JSON object.`, node.id)
      }
      if (node.data.sendQuery !== false) {
        validateJsonObjectField(issues, node.data.query, `${nodeLabel(node)} query params must be a JSON object.`, node.id)
      }
      if ((node.data.bodyMode ?? 'json') === 'json') {
        validateTemplatedJsonField(issues, node.data.body, `${nodeLabel(node)} body must be valid JSON or a data value.`, node.id)
      }
      if (node.data.bodyMode === 'form-urlencoded') {
        validateJsonObjectField(issues, node.data.body, `${nodeLabel(node)} form body must be a JSON object.`, node.id)
      }
      if ((node.data.bodyMode ?? 'json') !== 'none' && ['GET', 'HEAD'].includes(node.data.method) && node.data.body?.trim()) {
        add(issues, 'warning', 'HTTP_BODY_IGNORED', `${nodeLabel(node)} will not send a body for ${node.data.method}.`, node.id)
      }
    }

    // Error Shield: a step set to route failures needs a labeled 'error' edge to
    // route them down. Without one the failure just continues on the normal path
    // (never a crash) — a nudge, not a blocker.
    if ((node.type === 'agent' || node.type === 'tool' || node.type === 'http' || node.type === 'code') && node.data.onError === 'route') {
      if (!graph.edges.some((edge) => edge.source === node.id && edge.branch === 'error')) {
        add(issues, 'warning', 'ROUTE_NO_ERROR_PATH', `${nodeLabel(node)} routes on error but has no error path — failures continue on the normal path.`, node.id)
      }
    }

    if (node.type === 'loop') {
      if (!node.data.over.trim()) add(issues, 'error', 'MISSING_LOOP_SOURCE', `${nodeLabel(node)} needs a list to process.`, node.id)
      if (node.data.body.length === 0) add(issues, 'error', 'EMPTY_LOOP_BODY', `${nodeLabel(node)} needs at least one nested step.`, node.id)
      for (const bodyId of node.data.body) {
        if (!byId.has(bodyId)) add(issues, 'error', 'MISSING_CONTAINER_STEP', `${nodeLabel(node)} references missing nested step "${bodyId}".`, node.id)
      }
    }

    if (node.type === 'parallel') {
      if (node.data.branches.length === 0) add(issues, 'error', 'EMPTY_PARALLEL', `${nodeLabel(node)} needs at least one branch.`, node.id)
      node.data.branches.forEach((branch, index) => {
        if (branch.length === 0) add(issues, 'error', 'EMPTY_PARALLEL_BRANCH', `${nodeLabel(node)} branch ${index + 1} is empty.`, node.id)
        for (const branchNodeId of branch) {
          if (!byId.has(branchNodeId)) add(issues, 'error', 'MISSING_CONTAINER_STEP', `${nodeLabel(node)} references missing branch step "${branchNodeId}".`, node.id)
        }
      })
    }

    if (node.type === 'condition' || node.type === 'filter') {
      const clauses = conditionClauses(node)
      if (clauses.length === 0) add(issues, 'error', 'EMPTY_CONDITION', `${nodeLabel(node)} needs at least one condition.`, node.id)
      clauses.forEach((clause, index) => {
        if (!clause.left.trim()) add(issues, 'error', 'MISSING_CONDITION_LEFT', `${nodeLabel(node)} condition ${index + 1} needs data to check.`, node.id)
      })
    }

    if (node.type === 'switch') {
      if (node.data.cases.length === 0) add(issues, 'error', 'EMPTY_SWITCH', `${nodeLabel(node)} needs at least one case.`, node.id)
      const caseIds = node.data.cases.map((entry) => entry.id).filter(Boolean)
      for (const caseId of unique(caseIds)) {
        if (caseIds.filter((entry) => entry === caseId).length > 1) {
          add(issues, 'error', 'DUPLICATE_SWITCH_CASE', `${nodeLabel(node)} has duplicate case id "${caseId}".`, node.id)
        }
      }
      node.data.cases.forEach((entry, index) => {
        if (!entry.id.trim()) add(issues, 'error', 'MISSING_SWITCH_CASE_ID', `${nodeLabel(node)} case ${index + 1} needs an id.`, node.id)
        if (!entry.left.trim()) add(issues, 'error', 'MISSING_SWITCH_LEFT', `${nodeLabel(node)} case ${index + 1} needs data to check.`, node.id)
      })
      if (!graph.edges.some((edge) => edge.source === node.id && edge.branch === 'default')) {
        add(issues, 'warning', 'MISSING_SWITCH_DEFAULT', `${nodeLabel(node)} has no default branch.`, node.id)
      }
    }

    if (node.type === 'transform') {
      if (node.data.fields.length === 0) add(issues, 'error', 'EMPTY_TRANSFORM', `${nodeLabel(node)} needs at least one field.`, node.id)
      const names = node.data.fields.map((field) => field.name.trim()).filter(Boolean)
      node.data.fields.forEach((field, index) => {
        if (!field.name.trim()) add(issues, 'error', 'MISSING_TRANSFORM_FIELD', `${nodeLabel(node)} field ${index + 1} needs a name.`, node.id)
      })
      for (const name of unique(names)) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_TRANSFORM_FIELD', `${nodeLabel(node)} has duplicate field "${name}".`, node.id)
        }
      }
    }
    if (node.type === 'humanReview') {
      if (!node.data.message.trim()) {
        add(issues, 'error', 'MISSING_REVIEW_MESSAGE', `${nodeLabel(node)} needs a message for the reviewer.`, node.id)
      }
    }

    if (node.type === 'wait') {
      if (node.data.mode === 'until' && !node.data.until?.trim()) {
        add(issues, 'error', 'MISSING_WAIT_UNTIL', `${nodeLabel(node)} needs a date/time to wait until.`, node.id)
      }
      if ((node.data.mode ?? 'duration') === 'duration' && !node.data.amount?.trim()) {
        add(issues, 'error', 'MISSING_WAIT_AMOUNT', `${nodeLabel(node)} needs how long to wait.`, node.id)
      }
    }

    if (node.type === 'output') {
      // An output node with no rows builds an empty named map at runtime, which
      // would silently drop the real last-step output — block it outright.
      if (node.data.outputs.length === 0) {
        add(issues, 'error', 'EMPTY_OUTPUT', `${nodeLabel(node)} needs at least one output.`, node.id)
      }
      const names = node.data.outputs.map((entry) => entry.name.trim()).filter(Boolean)
      node.data.outputs.forEach((entry, index) => {
        // Index the message (mirrors transform) so two empty names read distinctly.
        if (!entry.name.trim()) {
          add(issues, 'error', 'MISSING_OUTPUT_NAME', `${nodeLabel(node)} output ${index + 1} needs a name.`, node.id)
        } else if (!entry.value.trim()) {
          // A named-but-blank value is a nudge, not a blocker: the name is
          // user-declared, and an empty value may be intentional.
          add(issues, 'warning', 'EMPTY_OUTPUT_VALUE', `${nodeLabel(node)} output "${entry.name.trim()}" has no value.`, node.id)
        }
      })
      for (const name of unique(names)) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_OUTPUT_NAME', `${nodeLabel(node)} has duplicate output "${name}".`, node.id)
        }
      }
    }

    if (node.type === 'join') {
      // A join is a merge target: branches point their edges at it. With no
      // incoming edge it can never run — a harmless warning, not a blocker.
      if (!graph.edges.some((edge) => edge.target === node.id)) {
        add(issues, 'warning', 'JOIN_NO_INCOMING', `${nodeLabel(node)} isn't reached by any branch.`, node.id)
      }
      // combineByKey needs a field to match records on, or it silently falls
      // back to append at run time.
      if (node.data.mode === 'combineByKey' && !node.data.key?.trim()) {
        add(issues, 'error', 'MERGE_NO_KEY', `${nodeLabel(node)} combines by a matching field but no field is set.`, node.id)
      }
    }

    if (node.type === 'data') {
      if (!node.data.input?.trim()) {
        add(issues, 'error', 'MISSING_DATA_INPUT', `${nodeLabel(node)} needs data to work with.`, node.id)
      }
      // separator (join) is optional — it defaults to ',' at run time.
      if (node.data.op === 'filterArray') {
        const clauses = node.data.clauses ?? []
        if (clauses.length === 0) add(issues, 'error', 'EMPTY_DATA_CLAUSES', `${nodeLabel(node)} needs at least one condition.`, node.id)
        clauses.forEach((clause, index) => {
          if (!clause.left.trim()) add(issues, 'error', 'MISSING_DATA_CLAUSE_LEFT', `${nodeLabel(node)} condition ${index + 1} needs data to check.`, node.id)
        })
      }
      if (node.data.op === 'select') {
        const fields = node.data.fields ?? []
        if (fields.length === 0) add(issues, 'error', 'EMPTY_DATA_FIELDS', `${nodeLabel(node)} needs at least one field.`, node.id)
        fields.forEach((field, index) => {
          if (!field.name.trim()) add(issues, 'error', 'MISSING_DATA_FIELD_NAME', `${nodeLabel(node)} field ${index + 1} needs a name.`, node.id)
        })
      }
    }

    if (node.type === 'ai') {
      // A blank input is a nudge, not a blocker (mirrors EMPTY_AGENT_INPUT) —
      // it's commonly wired from a default token the user hasn't replaced yet.
      if (!node.data.input?.trim()) {
        add(issues, 'warning', 'AI_EMPTY_INPUT', `${nodeLabel(node)} has an empty input.`, node.id)
      }
      if (node.data.aiOp === 'extract' && !(node.data.outputFields ?? []).some((field) => field.name.trim())) {
        add(issues, 'error', 'AI_EXTRACT_NO_FIELDS', `${nodeLabel(node)} needs at least one field to extract.`, node.id)
      }
      if (node.data.aiOp === 'categorize' && (node.data.categories ?? []).filter((category) => category.trim()).length < 2) {
        add(issues, 'error', 'AI_CATEGORIZE_TOO_FEW', `${nodeLabel(node)} needs at least two categories.`, node.id)
      }
      // Only a fully-specified range can be judged — a lone bound has nothing
      // to compare against yet, so it's left alone rather than flagged.
      if (
        node.data.aiOp === 'score' &&
        node.data.scoreMin !== undefined &&
        node.data.scoreMax !== undefined &&
        node.data.scoreMin >= node.data.scoreMax
      ) {
        add(issues, 'error', 'AI_SCORE_BAD_RANGE', `${nodeLabel(node)} needs a minimum score lower than the maximum.`, node.id)
      }
    }

    if (node.type === 'knowledge') {
      if (!node.data.query?.trim()) {
        add(issues, 'warning', 'KNOWLEDGE_EMPTY_QUERY', `${nodeLabel(node)} has an empty search — it will return nothing.`, node.id)
      }
    }

    if (node.type === 'code' && !node.data.code.trim()) {
      add(issues, 'error', 'EMPTY_CODE', `${nodeLabel(node)} needs code to run.`, node.id)
    }

    // The importer's passthrough stub for an unmappable n8n node: it "runs"
    // by returning its input unchanged, which silently defeats whatever the
    // original node did. Surface it as a blocker until finished or removed.
    if (node.type === 'code' && node.data.code.trimStart().startsWith('// TODO (imported from n8n')) {
      add(issues, 'error', 'PLACEHOLDER_VALUE', `${nodeLabel(node)} is an imported stub that passes data through unchanged — finish it or delete it.`, node.id)
    }

    if (node.type === 'subflow') {
      if (!node.data.flowId.trim()) {
        add(issues, 'error', 'SUBFLOW_NO_FLOW', `${nodeLabel(node)} needs a flow to run.`, node.id)
      } else if (context.flowId && node.data.flowId === context.flowId) {
        add(issues, 'error', 'SUBFLOW_SELF', `${nodeLabel(node)} points this flow at itself — pick a different flow.`, node.id)
      }
    }
  }

  // Per-item fan-out (the list-aware step contract): a step marked perItem needs
  // a list to run over.
  for (const node of graph.nodes) {
    const perItem = (node.data as { perItem?: { over?: string } }).perItem
    if (!perItem) continue
    if (!perItem.over?.trim()) {
      add(issues, 'error', 'MISSING_PERITEM_SOURCE', `${nodeLabel(node)} runs once per item but has no list to process.`, node.id)
      continue
    }
    // A per-item step whose config never mentions the current item makes N
    // identical calls — the hardcoded-ID bug (a Slack read wired per-account
    // but pinned to one channel). `over` itself is excluded: it names the
    // list, not the item. {{input}} counts — inside a fan-out it IS the item.
    const { perItem: _overOnly, ...restData } = node.data as Record<string, unknown>
    const rendered = JSON.stringify(restData)
    if (!/\{\{\s*(item|input|loop)\s*[.}]/.test(rendered)) {
      add(issues, 'warning', 'PER_ITEM_STATIC_ARGS', `${nodeLabel(node)} runs once per item but never uses the current item — every run will be identical. Pick a value from "Current item" in the data menu.`, node.id)
    }
  }

  // List-shaped output consumed whole by a run-once side-effecting step: the
  // upstream fans out per item (or is a loop), the downstream http/tool fires
  // once with the whole array stuffed into its config. Agents are exempt —
  // aggregating all items into one prompt is a deliberate, common pattern.
  const listProducerIds = new Set(
    graph.nodes
      .filter((node) => node.type === 'loop' || Boolean((node.data as { perItem?: { over?: string } }).perItem?.over?.trim()))
      .map((node) => node.id),
  )
  for (const edge of graph.edges) {
    if (!listProducerIds.has(edge.source)) continue
    const target = byId.get(edge.target)
    if (!target || (target.type !== 'http' && target.type !== 'tool')) continue
    if ((target.data as { perItem?: { over?: string } }).perItem?.over?.trim()) continue
    const source = byId.get(edge.source)
    add(issues, 'warning', 'LIST_INTO_SINGLE', `${nodeLabel(source)} produces a list, but ${nodeLabel(target)} runs only once over the whole thing — turn on "run once per item" on ${nodeLabel(target)} if you meant one run per item.`, target.id)
  }

  validateVariableNodes(graph, issues)

  // Container bodies are flat ordered lists — they can't host branch edges, so
  // a condition/switch inside a loop/parallel body would silently never branch.
  // Flag it loudly and steer to the `filter` node for per-item gating.
  const containerMemberIds = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )
  for (const node of graph.nodes) {
    if ((node.type === 'condition' || node.type === 'switch') && containerMemberIds.has(node.id)) {
      add(
        issues,
        'error',
        'CONTAINER_BRANCHING_UNSUPPORTED',
        `${nodeLabel(node)} can't branch inside a loop or parallel branch yet — move it to the main flow, or use a Filter step to keep only the items you want.`,
        node.id,
      )
    }
    // A join merges main-chain branches; a container body is a flat ordered list
    // with nothing to merge, and at run time a join inside one reads the stale
    // main-chain `lastOutput` closure (interpret.ts) instead of the body's
    // threaded value — silently corrupting the merged output. Block it.
    if (node.type === 'join' && containerMemberIds.has(node.id)) {
      add(
        issues,
        'error',
        'CONTAINER_JOIN_UNSUPPORTED',
        `${nodeLabel(node)} can't merge branches inside a loop or parallel — move it to the main flow.`,
        node.id,
      )
    }
  }

  for (const memberId of containerMemberIds) {
    const member = byId.get(memberId)
    if (!member) continue
    // Warning (not an error): a review inside a loop now resumes per-iteration
    // (no longer re-asks already-answered items), but every iteration pauses at
    // once and each reply resolves one iteration at a time.
    if (member.type === 'humanReview') {
      add(
        issues,
        'warning',
        'HUMAN_REVIEW_IN_CONTAINER',
        `${nodeLabel(member)} inside a loop pauses on every item at once — you'll answer them one at a time. Move it after the loop if you want a single prompt.`,
        member.id,
      )
    }
  }

  // '#' is reserved: loop/parallel bodies persist per-iteration step rows keyed
  // `${nodeId}#${index}`, so a '#' in a node id would collide with that scheme.
  // The builder's id generator never emits one, but an imported/hand-authored
  // graph could — reject it up front.
  for (const node of graph.nodes) {
    if (node.id.includes('#')) {
      add(issues, 'error', 'INVALID_NODE_ID', `Step id "${node.id}" can't contain "#".`, node.id)
    }
  }

  const flaggedNodeIds = new Set<string>()
  for (const node of graph.nodes) {
    if (node.type === 'agent' || node.type === 'trigger') continue
    const dataStr = JSON.stringify(node.data)
    const fieldRefRegex = /\{\{\s*step\.([^.}\s]+)\.output\.([^}\s]+)\s*\}\}/g
    let match
    while ((match = fieldRefRegex.exec(dataStr)) !== null) {
      const agentId = match[1]
      const fieldName = match[2]
      if (fieldName === 'output') continue
      const agentNode = byId.get(agentId)
      if (agentNode?.type === 'agent' && !isAgentStructured(agentNode as Extract<FlowNode, { type: 'agent' }>)) {
        if (!flaggedNodeIds.has(node.id)) {
          add(issues, 'warning', 'TEXT_AGENT_FIELD_REF', `${nodeLabel(node)} maps a field from ${nodeLabel(agentNode)}, but that agent returns plain text — switch its response to Structured.`, node.id)
          flaggedNodeIds.add(node.id)
        }
        break
      }
    }
  }

  // Token-reference integrity: a canonical {{step.<id>.…}} naming a node the
  // graph doesn't have (deleted step, mangled import) resolves to nothing at
  // run time; same for {{var.<name>}} with no initializer anywhere. Both were
  // previously silent until the run failed. One issue per node per kind.
  const initializedVarNames = new Set(
    graph.nodes
      .filter((node): node is Extract<FlowNode, { type: 'variable' }> => node.type === 'variable' && node.data.op === 'initialize')
      .map((node) => node.data.name.trim())
      .filter(Boolean),
  )
  for (const node of graph.nodes) {
    if (node.type === 'trigger' || node.type === 'note') continue
    const dataStr = JSON.stringify(node.data)
    // Ids and names may contain spaces (the importer derives ids from n8n node
    // names) — capture up to the next `.` or closing brace, then trim.
    for (const match of dataStr.matchAll(/\{\{\s*step\.([^.}]+)/g)) {
      if (!byId.has(match[1].trim())) {
        add(issues, 'error', 'TOKEN_UNKNOWN_STEP', `${nodeLabel(node)} uses data from a step that no longer exists — open its settings and re-pick the value from the data menu.`, node.id)
        break
      }
    }
    for (const match of dataStr.matchAll(/\{\{\s*var\.([^.}]+)/g)) {
      if (!initializedVarNames.has(match[1].trim())) {
        add(issues, 'error', 'TOKEN_UNKNOWN_VAR', `${nodeLabel(node)} uses a variable "${match[1].trim()}" that no step initializes.`, node.id)
        break
      }
    }
  }

  const reachable = reachableNodeIds(graph)
  for (const node of graph.nodes) {
    if (node.type !== 'trigger' && !reachable.has(node.id)) {
      add(issues, 'warning', 'UNREACHABLE_STEP', `${nodeLabel(node)} is not connected to the trigger.`, node.id)
    }
  }

  // The outer DAG (container bodies excluded) must be acyclic — the scheduler
  // waits for a node's inputs to resolve, so a back-edge would deadlock (a node
  // in the loop never becomes ready). Fan-in (multiple incoming edges) is fine;
  // only cycles are rejected. Retry loops belong in a step's `retries` field.
  const containerMembers = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )
  const { outgoing: dagOutgoing, dagNodeIds } = buildAdjacency(graph.nodes, graph.edges, containerMembers)
  const cycle = findCycle(dagNodeIds, dagOutgoing)
  if (cycle) {
    const labels = cycle.map((id) => {
      const node = graph.nodes.find((n) => n.id === id)
      return node ? nodeLabel(node) : id
    }).join(' → ')
    add(issues, 'error', 'CYCLE', `These steps form a loop (${labels}). A flow must run forward — to retry a step, set its retry count instead of looping an edge back.`, cycle[0])
  }

  const errors = issues.filter((issue) => issue.level === 'error')
  const warnings = issues.filter((issue) => issue.level === 'warning')
  return { ok: errors.length === 0, errors, warnings, issues }
}

export function validationErrorMessage(result: FlowValidationResult): string {
  if (result.ok) return ''
  const first = result.errors[0]
  const extra = result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : ''
  return `${first.message}${extra}`
}
