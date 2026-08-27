import type { TriggerInputField } from '@/lib/flows/graph'
import type { ApiScope } from '@/lib/public-api/auth'

/**
 * Published flows, described as MCP tools.
 *
 * We have consumed MCP since the connections page shipped and never served it,
 * which meant everything built here — every flow, every skill behind one — was
 * reachable only through our own UI. A workspace's published flows are the
 * natural export: each already has a name, a description, and a declared input
 * shape on its trigger, which is exactly an MCP tool.
 *
 * Pure. The route owns auth, visibility and execution; this owns the mapping.
 */

export type McpToolDescriptor = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export type McpManagementToolDescriptor = McpToolDescriptor & {
  /** Scope checked again at call time; tools/list also hides tools outside it. */
  requiredScope: ApiScope
}

export type PublishableFlow = {
  id: string
  name: string
  description?: string | null
  trigger?: unknown
}

/** JSON-Schema types for the field types a trigger can declare. */
const SCHEMA_TYPE: Record<string, string> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  object: 'object',
  array: 'array',
}

/**
 * A stable, protocol-legal tool name for a flow.
 *
 * MCP names travel through other people's clients, so they are restricted to
 * `[a-z0-9_]`. Derived from the flow's NAME rather than its id because the name
 * is what a calling agent reasons about — `send_renewal_brief` tells a model
 * what it does; `flow_cmsjute6l0003` tells it nothing.
 */
export function flowToolName(flow: PublishableFlow): string {
  const base = flow.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  // A flow named only in a non-latin script, or nothing but punctuation, still
  // needs a callable name.
  return base || `flow_${flow.id.slice(0, 12)}`
}

/**
 * Disambiguate names that collide.
 *
 * Two flows may legitimately share a name; a tool list with a repeated name is
 * ambiguous to the caller and, in some clients, silently drops one. The first
 * keeps the clean name, later ones take an id suffix — stable across calls
 * because the ordering is the caller's, not a hash.
 */
export function uniqueToolNames(
  flows: readonly PublishableFlow[],
  reservedNames: Iterable<string> = [],
): Map<string, string> {
  const taken = new Set(reservedNames)
  const byFlowId = new Map<string, string>()
  for (const flow of flows) {
    const base = flowToolName(flow)
    let name = base
    if (taken.has(name)) name = `${base}_${flow.id.slice(0, 6)}`
    // Still colliding (two flows, same name, same id prefix) is not reachable
    // with cuids, but a duplicate name is worse than an ugly one.
    let suffix = 2
    while (taken.has(name)) name = `${base}_${suffix++}`
    taken.add(name)
    byFlowId.set(flow.id, name)
  }
  return byFlowId
}

function triggerInputFields(trigger: unknown): TriggerInputField[] {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return []
  const fields = (trigger as { inputFields?: unknown }).inputFields
  if (!Array.isArray(fields)) return []
  return fields.filter((field): field is TriggerInputField =>
    Boolean(field && typeof field === 'object' && typeof (field as { name?: unknown }).name === 'string'),
  )
}

/**
 * The input schema a calling agent sees.
 *
 * A flow that declares trigger input fields gets them as named properties, so
 * the caller is told what to supply. A flow that declares none still takes a
 * run input — it just has no shape to advertise — so it gets a single free
 * `input`, which is exactly what the run API accepts.
 */
export function flowInputSchema(flow: PublishableFlow): McpToolDescriptor['inputSchema'] {
  const fields = triggerInputFields(flow.trigger)
  if (fields.length === 0) {
    return {
      type: 'object',
      properties: {
        input: {
          type: ['string', 'number', 'boolean', 'object', 'array'],
          description: 'Input for this flow. Text, a number, or a JSON object.',
        },
      },
    }
  }

  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const field of fields) {
    const name = field.name.trim()
    if (!name) continue
    const type = SCHEMA_TYPE[field.type ?? 'any']
    properties[name] = {
      ...(type ? { type } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    }
    if (field.required) required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/**
 * What a caller is told the tool does.
 *
 * The flow's own description when it has one. Otherwise its name read back as a
 * sentence — a tool with no description at all is one a model will not choose.
 */
export function flowToolDescription(flow: PublishableFlow): string {
  const own = flow.description?.trim()
  if (own) return own
  return `Runs the "${flow.name}" flow in this Backstory workspace.`
}

export function describeFlowTools(
  flows: readonly PublishableFlow[],
  reservedNames: Iterable<string> = [],
): McpToolDescriptor[] {
  const names = uniqueToolNames(flows, reservedNames)
  return flows.map((flow) => ({
    name: names.get(flow.id) ?? flowToolName(flow),
    description: flowToolDescription(flow),
    inputSchema: flowInputSchema(flow),
  }))
}

/**
 * Fetching a run started by an earlier call.
 *
 * A flow run is dispatched, not awaited: in queue mode the answer is not ready
 * when the call returns. Rather than hold the connection open for an unbounded
 * time, the server answers with a run id and offers this to collect the result
 * — one extra round trip, and never a request that hangs.
 */
export const GET_RUN_TOOL: McpToolDescriptor = {
  name: 'get_flow_run',
  description:
    'Fetch the status and output of a flow run started by one of the other tools. ' +
    'Use it when a run was still going when the call returned.',
  inputSchema: {
    type: 'object',
    properties: {
      flowRunId: { type: 'string', description: 'The flowRunId returned when the run was started.' },
    },
    required: ['flowRunId'],
  },
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): McpToolDescriptor['inputSchema'] => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})

/**
 * The workspace-management plane exposed to MCP builders.
 *
 * These are deliberately stable verbs over Backstory's native graph contract,
 * not UI automation. A client can round-trip a draft, validate it, publish it,
 * inspect immutable versions, restore one, and inspect execution history.
 */
export const MCP_MANAGEMENT_TOOLS: readonly McpManagementToolDescriptor[] = [
  {
    name: 'list_flows',
    description: 'List flows visible to this API key, including draft/published state and current version.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({
      status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'DISABLED'], description: 'Optional lifecycle filter.' },
      query: { type: 'string', description: 'Optional name/description search.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    }),
  },
  {
    name: 'get_flow',
    description: 'Read one visible flow, including its draft graph, settings, trigger, and published-state metadata.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({ flowId: { type: 'string' } }, ['flowId']),
  },
  {
    name: 'create_flow',
    description: 'Create a native Backstory flow draft. Omit graph to start with a manual trigger.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema(
      {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 2000 },
        graph: { type: 'object', description: 'Native {nodes,edges,pinData?,schemaVersion?} graph.' },
        settings: { type: 'object', description: 'Optional workflow execution settings.' },
        visibility: { type: 'string', enum: ['private', 'shared'], default: 'shared' },
        folder: { type: 'string', maxLength: 120 },
      },
      ['name'],
    ),
  },
  {
    name: 'update_flow',
    description: 'Update a flow draft with optimistic concurrency. Publishing is a separate explicit tool.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema(
      {
        flowId: { type: 'string' },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 2000 },
        graph: { type: 'object' },
        settings: { type: 'object' },
        visibility: { type: 'string', enum: ['private', 'shared'] },
        folder: { type: 'string', maxLength: 120 },
        expectedUpdatedAt: { type: 'string', format: 'date-time', description: 'Reject if the draft changed since this timestamp.' },
      },
      ['flowId'],
    ),
  },
  {
    name: 'delete_flow',
    description: 'Permanently delete one editable flow and its execution/version history.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({ flowId: { type: 'string' } }, ['flowId']),
  },
  {
    name: 'validate_flow',
    description: 'Validate a stored flow draft or a supplied native graph and return every error and warning.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({
      flowId: { type: 'string', description: 'Stored flow to validate.' },
      graph: { type: 'object', description: 'Graph to validate instead of reading a stored flow.' },
    }),
  },
  {
    name: 'publish_flow',
    description: 'Validate and publish the current draft as an immutable version, honoring the workspace review gate.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({ flowId: { type: 'string' } }, ['flowId']),
  },
  {
    name: 'unpublish_flow',
    description: 'Remove the live snapshot while retaining the draft and immutable version history.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({ flowId: { type: 'string' } }, ['flowId']),
  },
  {
    name: 'list_flow_versions',
    description: 'List immutable published versions for a visible flow, newest first.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({ flowId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }, ['flowId']),
  },
  {
    name: 'restore_flow_version',
    description: 'Copy an immutable published version into the editable draft without publishing it.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({ flowId: { type: 'string' }, version: { type: 'integer', minimum: 1 } }, ['flowId', 'version']),
  },
  {
    name: 'list_flow_runs',
    description: 'List recent executions for a visible flow with status, timing, cost, and error metadata.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({ flowId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }, ['flowId']),
  },
  {
    name: 'list_node_types',
    description: 'Search native node contracts, current behavior versions, configuration fields, and built-in variants.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({ query: { type: 'string', description: 'Optional type, field, operation, or description search.' } }),
  },
  {
    name: 'run_flow',
    description: 'Start one visible published flow by id and return a durable run id for polling.',
    requiredScope: 'flows:run',
    inputSchema: objectSchema({ flowId: { type: 'string' }, input: { description: 'JSON input for the published flow.' } }, ['flowId']),
  },
  {
    name: 'list_agents',
    description: 'List visible agents that workflow agent nodes can reference.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({ query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
  },
  {
    name: 'list_credentials',
    description: 'List redacted, bindable HTTP, MCP, and connected-app credentials. Secret material is never returned.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({}),
  },
  {
    name: 'list_folders',
    description: 'List the workspace catalogue of shared agent folders. Flow folder labels are set directly on each flow.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({}),
  },
  {
    name: 'create_folder',
    description: 'Create a shared agent folder in the workspace catalogue.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({ name: { type: 'string', minLength: 1, maxLength: 60 } }, ['name']),
  },
  {
    name: 'rename_folder',
    description: 'Rename a shared agent folder and move its shared agents atomically.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({ folderId: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 60 } }, ['folderId', 'name']),
  },
  {
    name: 'delete_folder',
    description: 'Delete a shared agent folder and move its shared agents back to General.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({ folderId: { type: 'string' } }, ['folderId']),
  },
  {
    name: 'list_data_tables',
    description: 'List durable typed workspace data tables.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({}),
  },
  {
    name: 'data_table_get_rows',
    description: 'Read durable data-table rows with optional exact field matching.',
    requiredScope: 'flows:read',
    inputSchema: objectSchema({
      tableId: { type: 'string' },
      tableName: { type: 'string' },
      where: { type: 'object' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      offset: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
    }),
  },
  {
    name: 'create_data_table',
    description: 'Create a durable workspace data table with an ordered typed column schema.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({ name: { type: 'string' }, description: { type: 'string' }, columns: { type: 'array', items: { type: 'object' } } }, ['name']),
  },
  {
    name: 'update_data_table',
    description: 'Rename a data table, edit its description, or replace its typed column schema with optimistic version checking.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({
      tableId: { type: 'string' },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', maxLength: 2000 },
      columns: { type: 'array', items: { type: 'object' } },
      expectedVersion: { type: 'integer', minimum: 1 },
    }, ['tableId']),
  },
  {
    name: 'delete_data_table',
    description: 'Permanently delete a data table and its rows. confirmation must exactly match the current table name.',
    requiredScope: 'flows:write',
    inputSchema: objectSchema({
      tableId: { type: 'string' },
      confirmation: { type: 'string', description: 'The current table name, exactly.' },
    }, ['tableId', 'confirmation']),
  },
  ...(['insert', 'update', 'upsert', 'delete'] as const).map((operation): McpManagementToolDescriptor => ({
    name: `data_table_${operation}_row`,
    description: `${operation[0].toUpperCase()}${operation.slice(1)} a schema-validated durable data-table row.`,
    requiredScope: 'flows:write',
    inputSchema: objectSchema({
      tableId: { type: 'string' },
      tableName: { type: 'string' },
      rowId: { type: 'string' },
      match: { type: 'object' },
      data: { type: 'object' },
    }, operation === 'insert' ? ['data'] : operation === 'update' ? ['rowId', 'data'] : operation === 'upsert' ? ['match', 'data'] : ['rowId']),
  })),
] as const

export function managementToolsForScopes(scopes: ReadonlySet<string>): McpToolDescriptor[] {
  return MCP_MANAGEMENT_TOOLS
    .filter((tool) => scopes.has(tool.requiredScope))
    .map(({ requiredScope: _requiredScope, ...tool }) => tool)
}

export function managementTool(name: string): McpManagementToolDescriptor | undefined {
  return MCP_MANAGEMENT_TOOLS.find((tool) => tool.name === name)
}
