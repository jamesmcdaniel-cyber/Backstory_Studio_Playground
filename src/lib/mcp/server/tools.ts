import type { TriggerInputField } from '@/lib/flows/graph'

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
export function uniqueToolNames(flows: readonly PublishableFlow[]): Map<string, string> {
  const taken = new Set<string>()
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

export function describeFlowTools(flows: readonly PublishableFlow[]): McpToolDescriptor[] {
  const names = uniqueToolNames(flows)
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
