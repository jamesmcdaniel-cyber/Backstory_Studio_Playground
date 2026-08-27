import { AI_CAPABILITY_LEAVES, BUILTIN_GROUPS, TRIGGER_LEAVES } from '@/lib/flows/builtin-catalog'
import type { FlowNode } from '@/lib/flows/graph'
import { CURRENT_NODE_VERSIONS } from '@/lib/flows/node-versions'

export type NativeNodeDefinition = {
  type: FlowNode['type']
  typeVersion: number
  title: string
  description: string
  executable: boolean
  configurationFields: readonly string[]
  variants: Array<{ id: string; label: string; description: string; seed?: Record<string, unknown> }>
}

const META = {
  trigger: ['Trigger', 'Starts a flow from a manual call, schedule, webhook, form, signal, poll, or connected-app event.'],
  agent: ['Agent', 'Runs a saved or inline tool-using AI agent.'],
  condition: ['Condition', 'Routes data down true or false paths.'],
  loop: ['Loop', 'Runs a contained step sequence for each item or batch.'],
  parallel: ['Parallel', 'Runs independent contained branches concurrently.'],
  stop: ['Stop', 'Ends the flow early, optionally as a failure.'],
  tool: ['Connected tool', 'Calls an operation from a connected app or MCP server.'],
  http: ['HTTP request', 'Calls an HTTP endpoint with host-bound reusable authentication.'],
  transform: ['Set fields', 'Builds a deterministic object from mapped values.'],
  filter: ['Filter', 'Continues only when configured conditions match.'],
  switch: ['Switch', 'Routes data to one or more named matching outputs.'],
  variable: ['Variable', 'Initializes or updates typed run-scoped state.'],
  data: ['Data operation', 'Performs deterministic list, text, date, conversion, comparison, or security operations.'],
  code: ['Code', 'Runs isolated JavaScript or Python data transformations.'],
  humanReview: ['Human review', 'Pauses a run and collects a reviewer response.'],
  output: ['Output', 'Returns named values to the flow caller.'],
  join: ['Join', 'Merges indexed incoming branches and their item data.'],
  ai: ['AI operation', 'Runs focused ask, extract, categorize, summarize, or score operations.'],
  subflow: ['Subflow', 'Runs a published child flow and maps its result.'],
  knowledge: ['Knowledge', 'Retrieves relevant workspace knowledge passages.'],
  wait: ['Wait', 'Pauses until a duration, date, or protected webhook callback.'],
  note: ['Note', 'Documents a graph without executing.'],
} as const satisfies Record<FlowNode['type'], readonly [string, string]>

const FIELDS = {
  trigger: ['trigger'],
  agent: ['agentId', 'input', 'instructions', 'tools', 'memory', 'outputFields'],
  condition: ['match', 'clauses'],
  loop: ['over', 'concurrency', 'batchSize', 'itemError', 'body'],
  parallel: ['branches'],
  stop: ['reason', 'status'],
  tool: ['connectionId', 'toolName', 'args', 'perItem', 'retry', 'onError'],
  http: ['method', 'url', 'connectionId', 'credentialId', 'credentialResolverId', 'query', 'headers', 'body', 'pagination', 'perItem', 'retry', 'onError'],
  transform: ['fields', 'includeOtherFields', 'includeMode', 'includeFields', 'perItem'],
  filter: ['match', 'clauses'],
  switch: ['cases', 'allMatches'],
  variable: ['op', 'name', 'varType', 'value'],
  data: ['op', 'input', 'fields', 'clauses', 'by', 'to', 'algorithm', 'secret'],
  code: ['language', 'code', 'input', 'timeoutMs'],
  humanReview: ['message', 'assigneeUserId', 'timeoutSeconds'],
  output: ['outputs'],
  join: ['mode', 'by', 'includeUnpaired'],
  ai: ['op', 'input', 'prompt', 'model', 'outputFields', 'categories', 'min', 'max'],
  subflow: ['flowId', 'input'],
  knowledge: ['query', 'limit', 'agentId'],
  wait: ['mode', 'duration', 'until', 'timeoutSeconds'],
  note: ['text', 'color'],
} as const satisfies Record<FlowNode['type'], readonly string[]>

const actionLeaves = [
  ...BUILTIN_GROUPS.flatMap((group) => group.children),
  ...AI_CAPABILITY_LEAVES,
]

function variantsFor(type: FlowNode['type']): NativeNodeDefinition['variants'] {
  if (type === 'trigger') {
    return TRIGGER_LEAVES.map((leaf) => ({
      id: leaf.id,
      label: leaf.label,
      description: leaf.description,
      ...(leaf.triggerType ? { seed: { triggerType: leaf.triggerType } } : {}),
    }))
  }
  return actionLeaves
    .filter((leaf) => leaf.stepType === type)
    .map((leaf) => ({
      id: leaf.id,
      label: leaf.label,
      description: leaf.description,
      ...(leaf.seed ? { seed: { ...leaf.seed } } : {}),
    }))
}

/** Stable, redacted registry used by MCP builders and architecture checks. */
export function nativeNodeRegistry(query = ''): NativeNodeDefinition[] {
  const needle = query.trim().toLowerCase()
  return (Object.keys(CURRENT_NODE_VERSIONS) as FlowNode['type'][])
    .map((type): NativeNodeDefinition => ({
      type,
      typeVersion: CURRENT_NODE_VERSIONS[type],
      title: META[type][0],
      description: META[type][1],
      executable: type !== 'trigger' && type !== 'note',
      configurationFields: FIELDS[type],
      variants: variantsFor(type),
    }))
    .filter((definition) => !needle || [
      definition.type,
      definition.title,
      definition.description,
      ...definition.configurationFields,
      ...definition.variants.flatMap((variant) => [variant.label, variant.description]),
    ].join(' ').toLowerCase().includes(needle))
}
