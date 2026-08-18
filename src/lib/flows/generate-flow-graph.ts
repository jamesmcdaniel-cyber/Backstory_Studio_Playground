import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { generateStructured } from '@/lib/llm/model-runner'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import { normalizeGeneratedFlowGraphInput, repairGeneratedFlowGraph, validationIssuesForModel } from '@/lib/flows/copilot'
import { validateFlowGraph, type FlowValidationResult } from '@/lib/flows/validate'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'

/**
 * The shared flow-graph generator behind BOTH the flow copilot (interactive
 * "build a flow that…") and 1-click provisioning of a recommended flow_template.
 * It grounds on the org's real agents + tools + integrations so generated
 * agent/tool nodes reference ids that actually exist, then runs up to 2 repair
 * rounds against the validator. It THROWS on a model/parse failure (the caller
 * chooses how to surface it) and does NOT meter usage — the caller records it
 * from the returned `rawParts` (which already include the system + user prompts).
 */

// Anthropic strict structured outputs can't express a free-form object
// ({type:'object'} with no declared properties collapses to {} under
// additionalProperties:false), and node/edge shapes vary too much per node type
// to enumerate strictly. So the model returns the whole graph as a JSON STRING
// inside a wrapper object, which parseGeneratedGraphReply unwraps.
const GRAPH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    graphJson: {
      type: 'string',
      description: 'The complete flow graph as a JSON string: {"nodes": [...], "edges": [...]}',
    },
  },
  required: ['graphJson'],
  additionalProperties: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Unwrap {graphJson:"..."} (strips ```json fences); falls back to the raw reply.
 *  Exported for tests — this is the seam where a malformed model reply is
 *  either recovered or rejected. */
export function parseGeneratedGraphReply(raw: string): unknown {
  const outer = JSON.parse(raw)
  const graphJson = isRecord(outer) ? outer.graphJson : undefined
  if (typeof graphJson !== 'string') return outer
  const trimmed = graphJson.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return JSON.parse(fenced ? fenced[1].trim() : trimmed)
}

export interface GeneratedFlowGraph {
  graph: FlowGraph
  validation: FlowValidationResult
  /** Prompts + model outputs for the caller's best-effort usage metering. */
  rawParts: string[]
}

export async function generateFlowGraph(
  organizationId: string,
  userId: string,
  description: string,
  opts: { currentGraph?: unknown; issues?: string[] } = {},
): Promise<GeneratedFlowGraph> {
  const { roster, toolCatalog, contextBlock, graphRules } = await buildCopilotGrounding(organizationId, userId)
  const system = `${graphRules}\n\n${UNTRUSTED_DATA_RULE}\n\n${GUARDRAIL_RULE}`

  // REPAIR MODE: an existing graph + checker issues to fix in place, else a
  // brand-new flow from the description.
  const parsedCurrentGraph = opts.currentGraph !== undefined ? flowGraphSchema.safeParse(opts.currentGraph) : undefined
  const isRepairMode = Boolean(parsedCurrentGraph?.success && opts.issues?.length)
  const user = isRepairMode
    ? [
        `Current flow graph JSON:\n${JSON.stringify(parsedCurrentGraph!.data)}`,
        '',
        `This existing flow has these validation problems:\n${opts.issues!.map((issue) => `- ${issue}`).join('\n')}`,
        'Return the SAME flow with the minimal changes needed to fix every problem. Keep node ids, structure, and configured values wherever possible; do not redesign the flow.',
        '',
        contextBlock,
      ].join('\n')
    : [`Build a flow that: ${description}`, '', contextBlock].join('\n')

  const validationContext = {
    agents: roster.map((agent) => ({ id: agent.id, title: agent.name })),
    toolCatalog,
  }
  const raw = await generateStructured({ system, user, schema: GRAPH_JSON_SCHEMA, schemaName: 'flow_graph', maxTokens: 3500 })
  const rawParts: string[] = [system, user, raw]
  let graph = repairGeneratedFlowGraph(flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(parseGeneratedGraphReply(raw))), { agents: roster, toolCatalog })
  let validation = validateFlowGraph(graph, { ...validationContext, requireRunnable: graph.nodes.length > 1 })

  for (let round = 0; round < 2 && !validation.ok; round += 1) {
    const repairUser = [
      user,
      '',
      'The graph below did not pass validation. Return a corrected full graph object that fixes every error while preserving the user request.',
      '',
      `Validation errors:\n${validationIssuesForModel(validation)}`,
      '',
      `Broken graph:\n${JSON.stringify(graph)}`,
    ].join('\n')
    const repairedRaw = await generateStructured({ system, user: repairUser, schema: GRAPH_JSON_SCHEMA, schemaName: 'flow_graph_repair', maxTokens: 3500 })
    rawParts.push(repairUser, repairedRaw)
    graph = repairGeneratedFlowGraph(flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(parseGeneratedGraphReply(repairedRaw))), { agents: roster, toolCatalog })
    validation = validateFlowGraph(graph, { ...validationContext, requireRunnable: graph.nodes.length > 1 })
  }

  return { graph, validation, rawParts }
}
